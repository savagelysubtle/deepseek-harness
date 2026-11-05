/**
 * Proof that a generated hook command really runs and really denies: execute the exact command with
 * a payload the policy must refuse and require exit code 2 with the guard's own reason.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/verify-guard
 */

import { spawnSync } from 'node:child_process'

/** Tool name no policy grants; the guard's "not granted" reason proves the policy file loaded too. */
const PROBE_TOOL = '__seat_guard_probe__'

/**
 * Run the hook command with a known-denied payload. Call it before a seat's first query (and from the
 * boot canary): a guard that cannot start would otherwise fail open, because only exit code 2 blocks.
 * @param command - the exact string from `buildHookCommand` (run through `sh -c`).
 * @throws when the command does not exit 2 with the `seat-guard: denied` prefix and the not-granted reason.
 */
export function verifyGuardCommand(command: string): void {
  const result = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: PROBE_TOOL, tool_input: {} }),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] },
    timeout: 60_000,
  })
  const stderr = result.stderr
  if (result.status !== 2) {
    throw new Error(`agent-claude-code-tools: the seat guard did not deny the probe (exit ${String(result.status)}): ${stderr.slice(0, 200)}`)
  }
  if (!stderr.startsWith('seat-guard: denied: ') || !stderr.includes(`tool ${PROBE_TOOL} is not granted`)) {
    throw new Error(`agent-claude-code-tools: the seat guard denied the probe for the wrong reason: ${stderr.slice(0, 200)}`)
  }
}
