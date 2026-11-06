import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHookCommand, guardScriptPath } from '../src/hook-command.ts'
import { writePolicyFile } from '../src/policy-file.ts'
import { assertProbeOutcome, ProbeOutcomeError, runGuardHook, verifyGuardCommand, verifyGuardCommandAsync } from '../src/verify-guard.ts'
import type { HookProbeOutcome } from '../src/verify-guard.ts'
import { coderPolicy, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => {
  box.cleanup()
})

function realCommand(seat = 'coder-one'): string {
  const guard = join(box.root, 'seat-guard.js')
  copyFileSync(guardScriptPath(), guard)
  const written = writePolicyFile(join(box.root, 'policy'), coderPolicy(box))
  return buildHookCommand({ nodePath: process.execPath, guardPath: guard, policyPath: written.path, sha256: written.sha256, seat })
}

describe('verifyGuardCommand', () => {
  it('accepts the real generated command running the built guard', () => {
    expect(() => { verifyGuardCommand(realCommand()) }).not.toThrow()
  })

  it('rejects a guard that allows (exit 0)', () => {
    expect(() => { verifyGuardCommand('exit 0') }).toThrow(/did not deny the probe \(exit 0\)/)
  })

  it('rejects a guard that cannot start (exit 127) and reports its stderr', () => {
    expect(() => { verifyGuardCommand('/nonexistent/node /nonexistent/guard') }).toThrow(/exit 127/)
  })

  it('rejects a denial for the wrong reason (policy for another seat, so the probe never reaches the tool check)', () => {
    expect(() => { verifyGuardCommand(realCommand('other-seat')) }).toThrow(/wrong reason/)
  })

  it('rejects an exit-2 that is not the guard speaking', () => {
    expect(() => { verifyGuardCommand('echo nope >&2; exit 2') }).toThrow(/wrong reason/)
  })
})

const denial = 'seat-guard: denied: tool __seat_guard_probe__ is not granted to this seat'
const DENY = { kind: 'deny', reasons: ['tool __seat_guard_probe__ is not granted'] } as const

describe('assertProbeOutcome', () => {
  const outcome = (over: Partial<HookProbeOutcome> = {}): HookProbeOutcome => ({ status: 2, signal: null, stderr: denial, ...over })
  const codeOf = (run: () => void): string | undefined => {
    try {
      run()
    } catch (error: unknown) {
      return error instanceof ProbeOutcomeError ? error.code : 'other'
    }
    return undefined
  }

  it('passes the exact denial and the exact allow', () => {
    expect(() => { assertProbeOutcome(outcome(), DENY) }).not.toThrow()
    expect(() => { assertProbeOutcome(outcome({ status: 0, stderr: '' }), { kind: 'allow' }) }).not.toThrow()
    expect(() => { assertProbeOutcome(outcome({ stderr: 'seat-guard: denied: x' }), { kind: 'deny' }) }).not.toThrow()
  })

  it('fails closed on every other outcome, with a distinct code each', () => {
    expect(codeOf(() => { assertProbeOutcome(outcome({ timedOut: true }), DENY) })).toBe('timeout')
    expect(codeOf(() => { assertProbeOutcome(outcome({ error: new Error('spawn ENOENT') }), DENY) })).toBe('spawn')
    expect(codeOf(() => { assertProbeOutcome(outcome({ status: 0 }), DENY) })).toBe('exit')
    expect(codeOf(() => { assertProbeOutcome(outcome({ status: null, signal: 'SIGKILL' }), DENY) })).toBe('exit')
    expect(codeOf(() => { assertProbeOutcome(outcome({ status: 0, signal: 'SIGTERM', stderr: '' }), { kind: 'allow' }) })).toBe('exit')
    expect(codeOf(() => { assertProbeOutcome(outcome({ status: 2, stderr: '' }), { kind: 'allow' }) })).toBe('exit')
    expect(codeOf(() => { assertProbeOutcome(outcome({ stderr: 'nope' }), DENY) })).toBe('reason')
    expect(codeOf(() => { assertProbeOutcome(outcome({ stderr: 'seat-guard: denied: other' }), DENY) })).toBe('reason')
    expect(codeOf(() => { assertProbeOutcome(outcome({ status: 0, stderr: 'noise' }), { kind: 'allow' }) })).toBe('reason')
  })

  it('names the exit code and a stderr excerpt', () => {
    expect(() => { assertProbeOutcome(outcome({ status: 7, stderr: 'boom' }), DENY) }).toThrow('did not deny the probe (exit 7): boom')
    expect(() => { assertProbeOutcome(outcome({ status: 7, stderr: 'boom' }), { kind: 'allow' }) }).toThrow('did not allow the granted control (exit 7): boom')
  })
})

describe('verifyGuardCommand failure paths', () => {
  it('a timeout is reported as a timeout, not a pass', () => {
    expect(() => { verifyGuardCommand('exec sleep 5', 100) }).toThrow('timed out')
  })

  it('a runaway stderr (spawn buffer exceeded) is refused, not truncated into a pass', () => {
    expect(() => { verifyGuardCommand('head -c 3000000 /dev/zero >&2; exit 2') }).toThrow(/could not run/)
  })
})

describe('runGuardHook and verifyGuardCommandAsync', () => {
  it('accepts the real command, like the sync form', async () => {
    await expect(verifyGuardCommandAsync(realCommand())).resolves.toBeUndefined()
  })

  it('judges exactly like the sync form', async () => {
    await expect(verifyGuardCommandAsync('exit 0')).rejects.toThrow(/did not deny the probe \(exit 0\)/)
    await expect(verifyGuardCommandAsync('echo nope >&2; exit 2')).rejects.toThrow(/wrong reason/)
    await expect(verifyGuardCommandAsync(realCommand('other-seat'))).rejects.toThrow(/wrong reason/)
  })

  it('reports the payload it was given on stdin, captured stderr and a null signal', async () => {
    const out = await runGuardHook('cat >&2; exit 2', 'hello')
    expect(out).toEqual({ status: 2, signal: null, stderr: 'hello' })
  })

  it('caps stderr', async () => {
    const out = await runGuardHook('head -c 10000 /dev/zero | tr "\\0" x >&2; exit 2', '')
    expect(out.stderr).toHaveLength(4096)
  })

  it('a shell that is missing or not executable comes back as an error outcome, never a rejection', async () => {
    const missing = await runGuardHook('true', '', { shell: join(box.root, 'no-such-shell') })
    expect(missing.error?.message).toContain('ENOENT')
    const plain = join(box.root, 'not-executable')
    writeFileSync(plain, 'x')
    const denied = await runGuardHook('true', '', { shell: plain })
    expect(denied.error?.message).toContain('EACCES')
  })

  it('kills a run that outlives its timeout and says so', async () => {
    const out = await runGuardHook('exec sleep 5', '', { timeoutMs: 100 })
    expect(out.timedOut).toBe(true)
    expect(out.signal).toBe('SIGKILL')
    await expect(verifyGuardCommandAsync('exec sleep 5', { timeoutMs: 100 })).rejects.toThrow('timed out')
  })

  it('an abort, before or during the run, kills it and is reported as an error outcome', async () => {
    const early = new AbortController()
    early.abort()
    expect((await runGuardHook('exec sleep 5', '', { signal: early.signal })).error?.message).toBe('aborted')
    const late = new AbortController()
    const pending = runGuardHook('exec sleep 5', '', { signal: late.signal })
    setTimeout(() => { late.abort() }, 50)
    expect((await pending).error?.message).toBe('aborted')
  })

  it('a command that exits before reading stdin does not crash the host (EPIPE is swallowed)', async () => {
    const out = await runGuardHook('exit 0', 'x'.repeat(2_000_000))
    expect(out.status).toBe(0)
  })
})
