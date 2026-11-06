import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHookCommand, guardScriptPath } from '../src/hook-command.ts'
import { writePolicyFile } from '../src/policy-file.ts'
import { verifyGuardCommand } from '../src/verify-guard.ts'
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
