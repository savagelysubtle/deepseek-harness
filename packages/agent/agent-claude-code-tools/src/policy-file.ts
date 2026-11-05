/**
 * Host-side writer of the per-seat policy file. The write is atomic (temp file in the same
 * directory, fsync, rename), the seat name is validated against a strict grammar so it cannot
 * traverse, and the SHA-256 of the exact bytes is returned so the hook command can pin it. A write
 * failure throws: the caller must refuse the query rather than run a seat with no policy.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/policy-file
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { POLICY_FILE_VERSION } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { isSeatName } from './grammar.ts'
import { validatePolicy } from './policy-read.ts'
import type { ToolsPolicyFile } from './policy-read.ts'

/** Where a policy file landed and the hash of its exact bytes. */
export interface WrittenPolicyFile {
  /** Absolute path of the policy file. */
  readonly path: string
  /** Lower-case hex SHA-256 of the file content; the hook command pins it. */
  readonly sha256: string
}

/**
 * Serialise a policy with a fixed key order.
 * @param policy - the policy.
 * @returns the exact file text.
 */
export function serializePolicy(policy: ToolsPolicyFile): string {
  return `${JSON.stringify({
    v: POLICY_FILE_VERSION,
    seat: policy.seat,
    role: policy.role,
    cwd: policy.cwd,
    allowedRoots: policy.allowedRoots,
    deniedPrefixes: policy.deniedPrefixes,
    tools: policy.tools,
    ...policy.denyDirsContainingProtected === undefined ? {} : { denyDirsContainingProtected: policy.denyDirsContainingProtected },
  })}\n`
}

/**
 * Write `<dir>/<seat>.json` atomically.
 * @param dir - absolute directory the host owns (created with mode 0700 when missing).
 * @param policy - the policy; its seat names the file.
 * @returns the path and the SHA-256 of the written bytes.
 * @throws when the seat or policy is invalid or any filesystem step fails; nothing partial is left at the final path.
 */
export function writePolicyFile(dir: string, policy: ToolsPolicyFile): WrittenPolicyFile {
  if (!isSeatName(policy.seat)) throw new Error(`agent-claude-code-tools: seat ${JSON.stringify(policy.seat)} is not a valid seat name`)
  const checked = validatePolicy(policy)
  if (!checked.ok) throw new Error(`agent-claude-code-tools: refusing to write an invalid policy (${checked.reason})`)
  const text = serializePolicy(policy)
  const path = join(dir, `${policy.seat}.json`)
  const temp = join(dir, `.${policy.seat}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
  return { path, sha256: createHash('sha256').update(text).digest('hex') }
}
