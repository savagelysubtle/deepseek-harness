/**
 * Host-side writer of the per-seat policy file. The write is atomic (temp file in the same
 * directory, fsync, rename), the seat name is validated against a strict grammar so it cannot
 * traverse, and the SHA-256 of the exact bytes is returned so the hook command can pin it. A write
 * failure throws: the caller must refuse the query rather than run a seat with no policy.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/policy-file
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
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
 * Make sure the host's policy directory exists and is the host's alone: created 0700 when missing; when
 * it exists it must be a real directory (not a symlink), owned by the running user, with mode exactly 0700.
 * @param dir - absolute directory path.
 * @throws a message naming the problem and the remedy.
 */
export function ensurePolicyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  const uid = process.getuid?.()
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`agent-claude-code-tools: policy directory ${dir} is not a plain directory (a symlink or a file); remove it so the host can create it`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`agent-claude-code-tools: policy directory ${dir} is owned by uid ${stat.uid}, not the running user ${uid}; remove it so the host can create it`)
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`agent-claude-code-tools: policy directory ${dir} has mode ${(stat.mode & 0o777).toString(8)}, not 700; run chmod 700 on it`)
  }
}

/**
 * Write `<dir>/<seat>.json` atomically.
 * @param dir - absolute directory the host owns (created with mode 0700 when missing; see {@link ensurePolicyDir}).
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
  ensurePolicyDir(dir)
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
