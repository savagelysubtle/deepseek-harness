/**
 * Reader and shape check for the per-seat policy file. Guard-reachable: node builtins only, erasable
 * TypeScript only. Any problem (missing, unreadable, corrupt, wrong version, wrong seat, wrong hash)
 * is a deny: the reader returns a reason, never a partial policy.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/policy-read
 */

import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { PolicyFileV1 } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { isSeatName } from './grammar.ts'

/** The only policy file version this package reads (tied to the contract's `PolicyFileV1['v']`). */
export const SUPPORTED_POLICY_VERSION: PolicyFileV1['v'] = 1

/** Largest policy file the guard will read. */
export const MAX_POLICY_BYTES = 64 * 1024

/** The policy file as the tools package reads and writes it: the contract's v1 plus one optional flag. */
export type ToolsPolicyFile = PolicyFileV1 & {
  /** When absent or true, Grep and Glob over a directory that holds an existing protected location are denied. */
  readonly denyDirsContainingProtected?: boolean
}

/** Result of reading or validating a policy file. */
export type PolicyReadResult =
  | { readonly ok: true; readonly policy: ToolsPolicyFile }
  | { readonly ok: false; readonly reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry !== '')
}

function absolutes(value: unknown): value is string[] {
  return strings(value) && value.every(entry => isAbsolute(entry))
}

/**
 * Validate a parsed policy object and rebuild it with a fixed key order.
 * @param value - parsed JSON.
 * @returns the policy, or the reason it is not a valid version-1 policy.
 */
export function validatePolicy(value: unknown): PolicyReadResult {
  if (!isRecord(value)) return { ok: false, reason: 'policy file is not an object' }
  if (value['v'] !== SUPPORTED_POLICY_VERSION) return { ok: false, reason: `policy version ${JSON.stringify(value['v'])} is not supported` }
  const { seat, role, cwd, allowedRoots, deniedPrefixes, tools } = value
  if (!isSeatName(seat)) return { ok: false, reason: 'policy seat is not a valid seat name' }
  if (role !== 'lead' && role !== 'coder') return { ok: false, reason: 'policy role is not lead or coder' }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { ok: false, reason: 'policy cwd is not an absolute path' }
  if (!absolutes(allowedRoots)) return { ok: false, reason: 'policy allowedRoots is not a list of absolute paths' }
  if (!absolutes(deniedPrefixes)) return { ok: false, reason: 'policy deniedPrefixes is not a list of absolute paths' }
  if (!strings(tools)) return { ok: false, reason: 'policy tools is not a list of tool names' }
  const flag = value['denyDirsContainingProtected']
  if (flag !== undefined && typeof flag !== 'boolean') return { ok: false, reason: 'policy denyDirsContainingProtected is not a boolean' }
  return {
    ok: true,
    policy: {
      v: SUPPORTED_POLICY_VERSION,
      seat,
      role,
      cwd,
      allowedRoots: [...allowedRoots],
      deniedPrefixes: [...deniedPrefixes],
      tools: [...tools],
      ...flag === undefined ? {} : { denyDirsContainingProtected: flag },
    },
  }
}

/**
 * Read a policy file and check it against what the caller expects.
 * @param path - absolute path of the policy file.
 * @param expectedSeat - the seat name the hook was started for.
 * @param expectedSha256 - the hash of the file content the host recorded when it wrote the file.
 * @returns the validated policy, or a deny reason.
 */
export function readPolicyFile(path: string, expectedSeat: string, expectedSha256: string): PolicyReadResult {
  let bytes: Buffer
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, reason: 'policy file is not a regular file' }
    if (stat.size > MAX_POLICY_BYTES) return { ok: false, reason: `policy file is larger than ${MAX_POLICY_BYTES} bytes` }
    bytes = readFileSync(fd)
  } catch (error: unknown) {
    return { ok: false, reason: `policy file unreadable (${String((error as NodeJS.ErrnoException).code)})` }
  } finally {
    if (fd !== -1) closeSync(fd)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    return { ok: false, reason: 'policy file hash does not match the host record' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, reason: 'policy file is not valid JSON' }
  }
  const result = validatePolicy(parsed)
  if (result.ok && result.policy.seat !== expectedSeat) return { ok: false, reason: 'policy file belongs to a different seat' }
  return result
}
