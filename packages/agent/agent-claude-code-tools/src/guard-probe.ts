/**
 * Boot probe of the seat guard. It generates a real coder policy for a synthetic seat, runs the exact hook
 * command a seat would run and requires the guard to deny an unknown tool, deny an edit of `.git/config`
 * and (negative control) allow a granted read, then re-checks that the node binary, the guard copy and the
 * policy file still hold their attested bytes. It proves the GENERATED COMMAND works through `/bin/sh`; it
 * does not prove the Claude CLI invokes the hook or honours exit 2 (that is the S8 live probe). Every error
 * maps to a failed result; the caller registers the `canary` readiness contributor only on an explicit `ok: true`.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/guard-probe
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attestFile } from './attest-guard.ts'
import type { AttestedFile } from './attest-guard.ts'
import { ContributorRegistry } from './contributors.ts'
import { assertProbeOutcome, ProbeOutcomeError, runGuardHook, verifyGuardCommandAsync } from './verify-guard.ts'
import type { GuardHookRunOptions } from './verify-guard.ts'
import { generateSeatPolicy } from './settings.ts'
import type { SeatPolicy } from './settings.ts'
import type { HookGroup } from './hook-command.ts'

/** Seat name reserved for the probe; `extend()` refuses a real seat with this name. */
export const RESERVED_PROBE_SEAT = 'dsh-canary-probe'

/**
 * Why a probe failed: `attest` (node or guard cannot be attested), `timeout`, `exit` (wrong exit code), `reason`
 * (wrong text), `control` (the granted read was not allowed), `changed` (a file changed during the run), `spawn`
 * (the shell could not start, or the run was aborted), `error` (anything else).
 */
export type GuardProbeCode = 'attest' | 'timeout' | 'exit' | 'reason' | 'control' | 'changed' | 'spawn' | 'error'

/** The result of one probe run. */
export type GuardProbeResult =
  | { readonly ok: true; readonly nodeSha256: string; readonly guardSha256: string; readonly policySha256: string }
  | { readonly ok: false; readonly code: GuardProbeCode; readonly reason: string }

/** The `claudeCodeGuardProbe` service. */
export interface GuardProbe {
  /**
   * Run the probe once. Never rejects; the result says whether the guard behaved.
   * @param signal - aborts the run (reported as a failed result).
   * @returns the result.
   */
  probe(signal?: AbortSignal): Promise<GuardProbeResult>
}

/** What {@link createGuardProbe} needs from the policy provider (the same resolved options seats use). */
export interface GuardProbeDeps {
  /** The host policy directory; the probe writes under its own subdirectory. */
  readonly policyDir: string
  /** The operator's home directory (canonical). */
  readonly home: string
  /** Attest (or re-use the attestation of) the node binary and the host-owned guard copy, exactly as `extend` does. */
  readonly attest: () => { readonly node: AttestedFile; readonly guard: AttestedFile }
  /** Whether a policy file still holds the bytes its hook command pins. */
  readonly policyIntact: (policy: SeatPolicy) => boolean
  /** Timeout of each hook run in milliseconds; default 15000. */
  readonly timeoutMs?: number
  /** Shell override for tests; default `/bin/sh`. */
  readonly shell?: string
}

function guardCommandOf(policy: SeatPolicy): string {
  const groups = policy.settings.hooks?.['PreToolUse'] as readonly HookGroup[]
  return (groups[0] as HookGroup).hooks[0]?.command as string
}

function fail(code: GuardProbeCode, error: unknown): GuardProbeResult {
  return { ok: false, code, reason: error instanceof Error ? error.message : String(error) }
}

/**
 * Build the probe service.
 * @param deps - directories and the provider's attestation functions.
 * @returns the service.
 */
export function createGuardProbe(deps: GuardProbeDeps): GuardProbe {
  const run = async (signal: AbortSignal | undefined): Promise<GuardProbeResult> => {
    let node: AttestedFile
    let guard: AttestedFile
    try {
      ;({ node, guard } = deps.attest())
    } catch (error: unknown) {
      return fail('attest', error)
    }
    const options: GuardHookRunOptions = {
      ...deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs },
      ...deps.shell === undefined ? {} : { shell: deps.shell },
      ...signal === undefined ? {} : { signal },
    }
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-canary-'))
    const probeDir = join(deps.policyDir, `canary-${randomBytes(6).toString('hex')}`)
    try {
      const cwd = join(scratch, 'cwd')
      mkdirSync(join(cwd, '.git'), { recursive: true })
      const readable = join(cwd, 'control.txt')
      writeFileSync(readable, 'control\n')
      const policy = generateSeatPolicy({
        seat: RESERVED_PROBE_SEAT,
        role: 'coder',
        cwd,
        home: deps.home,
        host: {},
        contributors: new ContributorRegistry(),
        policyDir: probeDir,
        node,
        guard,
      })
      const command = guardCommandOf(policy)
      await verifyGuardCommandAsync(command, options)
      assertProbeOutcome(
        await runGuardHook(command, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(cwd, '.git', 'config'), old_string: 'a', new_string: 'b' } }), options),
        { kind: 'deny', reasons: ['protected location'] },
      )
      const control = await runGuardHook(command, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: readable } }), options)
      try {
        assertProbeOutcome(control, { kind: 'allow' })
      } catch (error: unknown) {
        // A control that is denied, fails or times out means the guard denies everything: a fake, not a guard.
        return fail('control', error)
      }
      try {
        attestFile(node.path, { access: 'exec', expectedSha256: node.sha256 })
        attestFile(guard.realPath, { access: 'read', expectedSha256: guard.sha256 })
        if (!deps.policyIntact(policy)) throw new Error('policy file changed')
      } catch (error: unknown) {
        return fail('changed', error)
      }
      return { ok: true, nodeSha256: node.sha256, guardSha256: guard.sha256, policySha256: policy.policySha256 }
    } catch (error: unknown) {
      return fail(error instanceof ProbeOutcomeError ? error.code : 'error', error)
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return { probe: signal => run(signal).catch((error: unknown) => fail('error', error)) }
}
