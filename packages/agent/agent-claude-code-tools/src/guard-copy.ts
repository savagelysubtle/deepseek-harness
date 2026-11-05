/**
 * Host-owned copy of the guard script. The hook runs `<policyDir>/seat-guard.js`, a file only the host
 * user can write (mode 0500 in a mode 0700 directory), never the package's own `lib/seat-guard.js`, which
 * sits in a tree a coder seat may be able to edit. The copy is rewritten only when its hash differs from
 * the attested source, and always from that attested source, so a changed source is refused rather than
 * copied.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/guard-copy
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { attestFile } from './attest-guard.ts'
import type { AttestedFile } from './attest-guard.ts'
import { ensurePolicyDir } from './policy-file.ts'

/** File name of the host-owned guard copy inside the policy directory. */
const GUARD_COPY_NAME = 'seat-guard.js'

/** Mode of the host-owned guard copy: read and execute for the host user, nothing for anyone else. */
const GUARD_COPY_MODE = 0o500

/** Whether the copy already holds exactly these bytes with exactly this mode. */
function copyIsCurrent(path: string, sha256: string): boolean {
  let fd = -1
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    return stat.isFile() && (stat.mode & 0o777) === GUARD_COPY_MODE
      && createHash('sha256').update(readFileSync(fd)).digest('hex') === sha256
  } catch {
    return false
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/**
 * Make sure `<policyDir>/seat-guard.js` holds the attested source's bytes and attest the copy.
 * @param policyDir - absolute host-owned directory (created or checked 0700).
 * @param source - the attested guard script; its hash is the only content the copy may have.
 * @returns the attestation of the copy; use its `realPath` in the hook command.
 * @throws when the source no longer matches its attested hash, or the copy cannot be written or attested.
 */
export function installGuardCopy(policyDir: string, source: AttestedFile): AttestedFile {
  ensurePolicyDir(policyDir)
  const target = join(policyDir, GUARD_COPY_NAME)
  if (!copyIsCurrent(target, source.sha256)) {
    const bytes = readFileSync(source.realPath)
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      throw new Error(`agent-claude-code-tools: ${source.path} changed since this host attested it; restart the host to re-attest it`)
    }
    const temp = join(policyDir, `.${GUARD_COPY_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      const fd = openSync(temp, 'wx', GUARD_COPY_MODE)
      try {
        writeSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, target)
    } catch (error: unknown) {
      rmSync(temp, { force: true })
      throw error
    }
  }
  return attestFile(target, { access: 'read', expectedSha256: source.sha256 })
}
