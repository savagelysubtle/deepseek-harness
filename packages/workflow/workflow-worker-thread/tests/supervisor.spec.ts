import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowBashResult, WorkflowSupervisedChild, WorkflowSupervisorTools } from '@deepseek-ai/dsh-workflow'
import { createWorkflowChildSupervisor } from '../src/supervisor.ts'
import type { ChildAppendEvent } from '../src/supervisor.ts'

// Event names are the real session event types (packages/core/session/src/types.ts):
// `tool/call` carries data.callId; `tool/result` carries data.message.source.callId.
const call = (callId: string): ChildAppendEvent => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' },
})
const result = (callId: string): ChildAppendEvent => ({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId } } } })
const chunk: ChildAppendEvent = { type: 'assistant/chunk', data: { turn: 1, step: 1 } }

function rig(child: Partial<WorkflowSupervisedChild> = {}) {
  const listeners = new Set<(event: ChildAppendEvent) => void>()
  const unsubscribed = vi.fn()
  const supervisor = createWorkflowChildSupervisor({
    observe: (_id, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribed() }
    },
  })
  const supervised: WorkflowSupervisedChild = {
    callId: 1, prompt: 'p', iteration: 0, idleTimeoutMs: 1000, timeoutMs: 60_000, ...child,
  }
  const stop = vi.fn()
  const emit = (event: ChildAppendEvent): void => { for (const l of [...listeners]) l(event) }
  return { supervisor, supervised, stop, emit, listeners, unsubscribed }
}

const bashResult = (over: Partial<WorkflowBashResult>): WorkflowBashResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: '',
  stderr: '',
  truncated: false,
  stdoutBytes: 0,
  stderrBytes: 0,
  durationMs: 1,
  ...over,
})

describe('child supervisor timers', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stalls after idleTimeoutMs of silence and rearms on every append', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    vi.advanceTimersByTime(900)
    r.emit(chunk)
    vi.advanceTimersByTime(900)
    expect(r.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(r.stop).toHaveBeenCalledExactlyOnceWith('stalled')
  })

  it('does not fire falsely while a synchronous busy loop burns real time', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    for (let i = 0; i < 5; i++) {
      // A synchronous block of ~50 ms REAL time (Atomics.wait is not faked); the fake clock does not move.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      vi.advanceTimersByTime(400)
      r.emit(chunk)
    }
    expect(r.stop).not.toHaveBeenCalled()
  })

  it('pauses while a tool call is in flight and rearms when it ends', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.emit(chunk)
    r.emit(call('t1'))
    vi.advanceTimersByTime(10_000)
    r.emit(chunk)
    vi.advanceTimersByTime(10_000)
    expect(r.stop).not.toHaveBeenCalled()
    r.emit(result('t1'))
    vi.advanceTimersByTime(999)
    expect(r.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(r.stop).toHaveBeenCalledExactlyOnceWith('stalled')
  })

  it('stays paused until every parallel tool call has ended', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.emit(call('a'))
    r.emit(call('b'))
    r.emit(result('a'))
    vi.advanceTimersByTime(5000)
    expect(r.stop).not.toHaveBeenCalled()
    r.emit(result('b'))
    vi.advanceTimersByTime(1000)
    expect(r.stop).toHaveBeenCalledWith('stalled')
  })

  it('fires the absolute deadline as timeout even while a tool call is in flight', () => {
    const r = rig({ timeoutMs: 5000 })
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.emit(call('t1'))
    vi.advanceTimersByTime(4999)
    expect(r.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(r.stop).toHaveBeenCalledExactlyOnceWith('timeout')
  })

  it('release clears both timers and the subscription, and is idempotent', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.supervisor.release?.(r.supervised, 'c1')
    r.supervisor.release?.(r.supervised, 'c1')
    vi.advanceTimersByTime(1_000_000)
    expect(r.stop).not.toHaveBeenCalled()
    expect(r.unsubscribed).toHaveBeenCalledTimes(1)
    expect(r.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a stale handle event after release is a no-op', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    const listener = [...r.listeners][0]
    r.supervisor.release?.(r.supervised, 'c1')
    listener?.(chunk)
    listener?.(call('late'))
    vi.advanceTimersByTime(1_000_000)
    expect(r.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a continuation iteration is supervised independently of the previous one', () => {
    const r = rig({ timeoutMs: 5000 })
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.supervisor.release?.(r.supervised, 'c1')
    const next = { ...r.supervised, iteration: 1 }
    const stop2 = vi.fn()
    r.supervisor.register?.(next)
    r.supervisor.bind?.(next, 'c2', { stop: stop2 })
    vi.advanceTimersByTime(5000)
    expect(r.stop).not.toHaveBeenCalled()
    expect(stop2).toHaveBeenCalledWith('timeout')
  })

  it('bind without register throws a clear error and arms nothing', () => {
    const r = rig()
    expect(() => r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })).toThrow(/without a prior register/)
    vi.advanceTimersByTime(1_000_000)
    expect(r.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('release of a registered-but-never-bound child drops the registration', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.release?.(r.supervised, undefined)
    expect(() => r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })).toThrow(/without a prior register/)
  })

  it('without an append feed only the absolute deadline runs', () => {
    const supervisor = createWorkflowChildSupervisor()
    const stop = vi.fn()
    const child: WorkflowSupervisedChild = { callId: 2, prompt: 'p', iteration: 0, idleTimeoutMs: 10, timeoutMs: 100 }
    supervisor.register?.(child)
    supervisor.bind?.(child, 'x', { stop })
    vi.advanceTimersByTime(99)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stop).toHaveBeenCalledExactlyOnceWith('timeout')
  })

  it('anonymous tool ids do not collide, and a result with no id only rearms', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    r.emit({ type: 'tool/call', data: {} })
    r.emit({ type: 'tool/call', data: {} })
    r.emit({ type: 'tool/result', data: {} })
    vi.advanceTimersByTime(5000)
    expect(r.stop).not.toHaveBeenCalled()
  })

  it('caps the in-flight set and warns, dropping the oldest', () => {
    const warnings: string[] = []
    const listeners: ((e: ChildAppendEvent) => void)[] = []
    const supervisor = createWorkflowChildSupervisor({
      observe: (_id, l) => { listeners.push(l); return () => {} },
      onWarning: (m) => { warnings.push(m) },
    })
    const child: WorkflowSupervisedChild = { callId: 1, prompt: 'p', iteration: 0, idleTimeoutMs: 1000 }
    supervisor.register?.(child)
    supervisor.bind?.(child, 'c1', { stop: vi.fn() })
    for (let i = 0; i < 1001; i++) listeners[0]?.(call(`t${i}`))
    expect(warnings).toHaveLength(1)
    listeners[0]?.(result('t0'))
    listeners[0]?.(result('t1'))
  })

  it('an unobservable child (feed returns undefined) is deadline-only', () => {
    const supervisor = createWorkflowChildSupervisor({ observe: () => undefined })
    const stop = vi.fn()
    const child: WorkflowSupervisedChild = { callId: 1, prompt: 'p', iteration: 0, idleTimeoutMs: 10, timeoutMs: 100 }
    supervisor.register?.(child)
    supervisor.bind?.(child, 'c1', { stop })
    vi.advanceTimersByTime(99)
    expect(stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stop).toHaveBeenCalledExactlyOnceWith('timeout')
  })

  it('evaluate quiesces both timers, so a slow done-when check never stops a finished child', async () => {
    const r = rig({ timeoutMs: 5000, doneWhen: { command: 'true' } })
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    const gate = Promise.withResolvers<WorkflowBashResult>()
    const pending = r.supervisor.evaluate?.(r.supervised, { stopReason: 'end_turn', text: '' }, {
      runBash: () => gate.promise,
      signal: new AbortController().signal,
    })
    vi.advanceTimersByTime(100_000)
    expect(r.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    gate.resolve(bashResult({}))
    expect(await pending).toBeUndefined()
  })

  it('registers no agent/turn-stopping listener: its only subscription is the injected append feed', () => {
    const r = rig()
    r.supervisor.register?.(r.supervised)
    r.supervisor.bind?.(r.supervised, 'c1', { stop: r.stop })
    expect(r.listeners.size).toBe(1)
    r.supervisor.release?.(r.supervised, 'c1')
    expect(r.listeners.size).toBe(0)
  })

  it('no source file of the package mentions turn-stopping', () => {
    const dir = fileURLToPath(new URL('../src', import.meta.url))
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), 'utf8')).not.toContain('turn-stopping')
  })
})

describe('child supervisor done_when evaluation', () => {
  const outcome = { stopReason: 'end_turn', text: '' }
  const child = (): WorkflowSupervisedChild => ({
    callId: 1, prompt: 'p', iteration: 0, doneWhen: { command: 'test -f out', maxContinuations: 3 },
  })
  const tools = (results: WorkflowBashResult[]): { tools: WorkflowSupervisorTools; run: ReturnType<typeof vi.fn> } => {
    const run = vi.fn(() => Promise.resolve(results.shift() ?? bashResult({})))
    return { tools: { runBash: run, signal: new AbortController().signal }, run }
  }

  it('reports the failure tail on iteration 1 and passes on iteration 2', async () => {
    const supervisor = createWorkflowChildSupervisor()
    const t = tools([bashResult({ exitCode: 1, stdout: 'a', stderr: 'missing out' }), bashResult({ exitCode: 0 })])
    const first = await supervisor.evaluate?.(child(), outcome, t.tools)
    expect(first).toEqual({
      iteration: 1, maxContinuations: 3, command: 'test -f out', exitCode: 1, tail: 'a\nmissing out', truncated: false,
    })
    const second = await supervisor.evaluate?.({ ...child(), iteration: 1 }, outcome, t.tools)
    expect(second).toBeUndefined()
    expect(t.run).toHaveBeenCalledWith('test -f out', {})
  })

  it('treats a timed-out or aborted check as not done', async () => {
    const supervisor = createWorkflowChildSupervisor()
    const t = tools([bashResult({ exitCode: null, timedOut: true })])
    const evidence = await supervisor.evaluate?.(child(), outcome, t.tools)
    expect(evidence?.exitCode).toBeNull()
  })

  it('returns undefined when the child has no done_when', async () => {
    const supervisor = createWorkflowChildSupervisor()
    const t = tools([])
    expect(await supervisor.evaluate?.({ callId: 1, prompt: 'p', iteration: 0 }, outcome, t.tools)).toBeUndefined()
    expect(t.run).not.toHaveBeenCalled()
  })
})
