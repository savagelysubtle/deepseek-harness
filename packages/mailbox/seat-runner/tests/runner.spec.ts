/**
 * Seat-runner behavior: config validation, discovery-to-wake resolution,
 * per-seat in-flight and backoff bookkeeping, and the interval loop's fault
 * containment — all against injected collaborators, never real processes.
 */

import { describe, expect, it, vi } from 'vitest'
import { formatMailboxAddress, parseOrgRegistry } from '@deepseek-ai/dsh-mailbox'
import type { MailboxAddress, MailboxProvider } from '@deepseek-ai/dsh-mailbox'
import {
  createSeatRunnerState, resolveSeatRunnerConfig, runSeatRunnerTick, startSeatRunner, WAKE_TASK_TEXT,
} from '../src/index.ts'
import type { SeatRunnerDeps, WakeRequest } from '../src/index.ts'

const REGISTRY = parseOrgRegistry(`
baseDir: /projects
seats:
  alfred: { cwd: deepseek-harness, namespace: gotham, lead: true }
  batman: { cwd: deepseek-harness, namespace: gotham }
edges:
  - [alfred, batman]
callUp: [alfred]
`, { home: '/home/test' })

const BATMAN = formatMailboxAddress('gotham', 'batman')

const CONFIG = resolveSeatRunnerConfig({ pollIntervalMs: 1_000 })

/** Controllable clock for backoff accounting. */
function fakeClock(): { clock: () => number; advance: (ms: number) => void } {
  let now = 1_000_000
  return { clock: () => now, advance: (ms: number) => { now += ms } }
}

interface Harness {
  deps: SeatRunnerDeps
  state: ReturnType<typeof createSeatRunnerState>
  wake: ReturnType<typeof vi.fn<(request: WakeRequest) => Promise<void>>>
  claimable: ReturnType<typeof vi.fn<() => Promise<readonly MailboxAddress[]>>>
  lines: string[]
  clock: ReturnType<typeof fakeClock>
}

function harness(claimable: readonly MailboxAddress[] = []): Harness {
  const clock = fakeClock()
  const lines: string[] = []
  const wake = vi.fn<(request: WakeRequest) => Promise<void>>().mockResolvedValue(undefined)
  const claim = vi.fn<() => Promise<readonly MailboxAddress[]>>().mockResolvedValue(claimable)
  const deps: SeatRunnerDeps = {
    store: { claimableAddresses: claim as unknown as MailboxProvider['claimableAddresses'] },
    registry: REGISTRY,
    wake,
    clock: clock.clock,
    log: (line: string) => { lines.push(line) },
  }
  return { deps, state: createSeatRunnerState(), wake, claimable: claim, lines, clock }
}

describe('resolveSeatRunnerConfig', () => {
  it('applies documented defaults', () => {
    const config = resolveSeatRunnerConfig()
    expect(config.registryPath).toMatch(/org[/\\]registry\.yml$/)
    expect(config.storePath).toMatch(/mailbox[/\\]mailbox\.db$/)
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.staleClaimMs).toBe(120_000)
    expect(config.backoffBaseMs).toBe(2_000)
    expect(config.maxBackoffExponent).toBe(6)
    expect(config.entrypoint).toBe('dsh')
    expect(config.wakeTask).toBe(WAKE_TASK_TEXT)
  })

  it.each([
    [{ pollIntervalMs: 0 }, 'pollIntervalMs'],
    [{ pollIntervalMs: 1.5 }, 'pollIntervalMs'],
    [{ staleClaimMs: -1 }, 'staleClaimMs'],
    [{ backoffBaseMs: 0 }, 'backoffBaseMs'],
    [{ maxBackoffExponent: 0 }, 'maxBackoffExponent'],
    [{ entrypoint: '   ' }, 'entrypoint'],
    [{ wakeTask: '' }, 'wakeTask'],
  ])('rejects %j loud', (config, label) => {
    expect(() => resolveSeatRunnerConfig(config as never)).toThrow(label)
  })
})

describe('runSeatRunnerTick', () => {
  it('resolves a pending address through the registry and issues the standard wake', async () => {
    const h = harness([BATMAN])
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).toHaveBeenCalledOnce()
    expect(h.wake.mock.calls[0][0]).toEqual({
      seat: 'batman',
      namespace: 'gotham',
      name: 'batman',
      cwd: '/projects/deepseek-harness',
      entrypoint: 'dsh',
      task: WAKE_TASK_TEXT,
    })
  })

  it('warns once per unroutable address and never wakes it', async () => {
    const h = harness([formatMailboxAddress('gotham', 'ghost')])
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).not.toHaveBeenCalled()
    const warnings = h.lines.filter(line => line.includes('unroutable'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no registry seat named "ghost"')
  })

  it('warns once for a namespace mismatch instead of waking the wrong seat', async () => {
    const h = harness([formatMailboxAddress('temple', 'alfred')])
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.lines.filter(line => line.includes('unroutable'))).toHaveLength(1)
  })

  it('skips a seat with a wake in flight until it settles', async () => {
    const h = harness([BATMAN])
    let releaseWake: () => void = () => {}
    h.wake.mockImplementation(() => new Promise<void>((resolveWake) => { releaseWake = resolveWake }))
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).toHaveBeenCalledOnce()
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).toHaveBeenCalledOnce()
    releaseWake()
    await vi.waitFor(() => { expect(h.state.inFlight.has('batman')).toBe(false) })
    await runSeatRunnerTick(h.deps, CONFIG, h.state)
    expect(h.wake).toHaveBeenCalledTimes(2)
  })

  it('backs off a failed wake exponentially and resets on a clean exit', async () => {
    const h = harness([BATMAN])
    const failing = resolveSeatRunnerConfig({ pollIntervalMs: 1_000, backoffBaseMs: 1_000, maxBackoffExponent: 2 })
    h.wake.mockRejectedValueOnce(new Error('lock held')).mockRejectedValueOnce(new Error('lock held')).mockResolvedValueOnce(undefined)

    await runSeatRunnerTick(h.deps, failing, h.state)
    await vi.waitFor(() => { expect(h.state.attempts.get('batman')).toBe(1) })
    expect(h.state.eligibleAt.get('batman')).toBe(h.clock.clock() + 1_000)

    // Still inside the first backoff window: the seat is skipped, not re-woken.
    await runSeatRunnerTick(h.deps, failing, h.state)
    expect(h.wake).toHaveBeenCalledOnce()

    h.clock.advance(1_000)
    await runSeatRunnerTick(h.deps, failing, h.state)
    await vi.waitFor(() => { expect(h.state.attempts.get('batman')).toBe(2) })
    expect(h.state.eligibleAt.get('batman')).toBe(h.clock.clock() + 2_000)

    h.clock.advance(2_000)
    await runSeatRunnerTick(h.deps, failing, h.state)
    await vi.waitFor(() => { expect(h.state.attempts.has('batman')).toBe(false) })
    expect(h.state.eligibleAt.has('batman')).toBe(false)
    expect(h.lines.some(line => line.includes('exited clean'))).toBe(true)
  })

  it('caps the backoff exponent so a stuck seat retries slowly, not never', async () => {
    const h = harness([BATMAN])
    const failing = resolveSeatRunnerConfig({ pollIntervalMs: 1_000, backoffBaseMs: 1_000, maxBackoffExponent: 2 })
    h.wake.mockRejectedValue(new Error('lock held'))
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.clock.advance(10_000)
      await runSeatRunnerTick(h.deps, failing, h.state)
      await vi.waitFor(() => { expect(h.state.attempts.get('batman')).toBe(attempt + 1) })
    }
    expect(h.state.eligibleAt.get('batman')).toBe(h.clock.clock() + 4_000)
  })
})

describe('startSeatRunner', () => {
  it('ticks immediately, then on the interval, contains store faults, and stops', async () => {
    vi.useFakeTimers()
    try {
      const h = harness([BATMAN])
      let calls = 0
      h.claimable.mockImplementation(() => {
        calls += 1
        if (calls === 2) return Promise.reject(new Error('store busy'))
        return Promise.resolve([BATMAN])
      })
      const runner = startSeatRunner(h.deps, CONFIG)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.wake).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.wake).toHaveBeenCalledTimes(1)
      expect(h.lines.some(line => line.includes('tick failed: store busy'))).toBe(true)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.wake).toHaveBeenCalledTimes(2)

      runner.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.wake).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
