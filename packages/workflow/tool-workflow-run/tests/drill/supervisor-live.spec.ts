import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowChildSupervisor } from '@deepseek-ai/dsh-workflow-worker-thread'
import type { ChildAppendEvent } from '@deepseek-ai/dsh-workflow-worker-thread'

/**
 * Live-child check for the stall watchdog, under REAL timers and a REAL local child process: a
 * child that keeps logging for longer than `idleTimeoutMs` must not be stopped, and one that goes
 * quiet must be. The log lines the child prints stand in for the session appends of a working agent
 * (the supervisor reads append events; it never looks at the process).
 */

const IDLE_MS = 1000
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

/** Wire one supervised child to a real process: every stdout line becomes a session append. */
function supervise(script: string) {
  const listeners = new Set<(event: ChildAppendEvent) => void>()
  const supervisor = createWorkflowChildSupervisor({
    observe: (_id, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  const child = { callId: 1, prompt: 'p', iteration: 0, idleTimeoutMs: IDLE_MS, timeoutMs: 60_000 }
  const stop = vi.fn()
  supervisor.register?.(child)
  supervisor.bind?.(child, 'live-child', { stop })
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(proc)
  let lines = 0
  proc.stdout.on('data', (chunk: Buffer) => {
    for (const _ of chunk.toString().split('\n').filter(l => l.length > 0)) {
      lines += 1
      for (const listener of [...listeners]) listener({ type: 'assistant/chunk', data: { turn: 1, step: 1 } })
    }
  })
  const exited = new Promise<number | null>(resolve => proc.once('exit', (code) => { resolve(code) }))
  return { supervisor, child, stop, exited, lines: () => lines, listeners }
}

describe('stall watchdog with a real child process', () => {
  it('does not stop a child that keeps logging for three idle windows', async () => {
    // Prints every 200 ms for 3 s, three times the idle window, then exits cleanly.
    const live = supervise(`
      let n = 0
      const t = setInterval(() => { console.log('progress ' + (++n)); if (n === 15) { clearInterval(t) } }, 200)
    `)
    const started = Date.now()
    expect(await live.exited).toBe(0)
    const ranMs = Date.now() - started
    expect(ranMs).toBeGreaterThanOrEqual(3 * IDLE_MS)
    expect(ranMs).toBeLessThan(10_000)
    expect(live.lines()).toBe(15)
    expect(live.stop).not.toHaveBeenCalled()
    live.supervisor.release?.(live.child, 'live-child')
    expect(live.listeners.size).toBe(0)
  }, 15_000)

  it('stops a child that prints once and then goes quiet (the negative control for the check above)', async () => {
    const live = supervise('console.log("one line"); setTimeout(() => {}, 5000)')
    await vi.waitFor(() => { expect(live.stop).toHaveBeenCalledExactlyOnceWith('stalled') }, { timeout: 5000, interval: 50 })
    expect(live.lines()).toBe(1)
    live.supervisor.release?.(live.child, 'live-child')
  }, 15_000)
})
