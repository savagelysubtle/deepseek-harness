/**
 * The cheap per-query fingerprint of a clone's hook-relevant state: `lstat` of `.git`, `.git/config`, the entries
 * that must be absent, `.git/hooks` and each of its entries. Comparing two fingerprints costs about a dozen `lstat`
 * calls and no spawn; the (slower) git parse re-runs only when the fingerprint changed. A missing entry has a
 * stable token (it may be supposed to be missing); an entry that cannot be read gets a token that never equals
 * any other, so an unreadable entry is a changed fingerprint and can never be cached as a pass.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/fingerprint
 */

import { lstatSync, readdirSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { FORBIDDEN_GIT_ENTRIES } from './limits.ts'

/** The two filesystem calls the checks need; tests inject a fake. */
export interface CloneFs {
  /** `lstat` with bigint fields (no following of symlinks). */
  readonly lstat: (path: string) => BigIntStats
  /** Directory entry names. */
  readonly readdir: (path: string) => string[]
}

/** The real filesystem. */
export const realCloneFs: CloneFs = {
  lstat: path => lstatSync(path, { bigint: true }),
  readdir: path => readdirSync(path),
}

let unreadable = 0

function token(fs: CloneFs, path: string): string {
  try {
    const stat = fs.lstat(path)
    return `${stat.mode}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    unreadable += 1
    return `unreadable:${unreadable}`
  }
}

function hookEntries(fs: CloneFs, hooks: string): string[] {
  try {
    return fs.readdir(hooks).sort()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    unreadable += 1
    return [`unreadable:${unreadable}`]
  }
}

/**
 * Fingerprint the hook-relevant state of a clone.
 * @param cwd - the clone's canonical working directory.
 * @param fs - the filesystem calls.
 * @returns a string that changes whenever any watched entry is created, removed, replaced or rewritten.
 */
export function fingerprintClone(cwd: string, fs: CloneFs = realCloneFs): string {
  const git = join(cwd, '.git')
  const hooks = join(git, 'hooks')
  const parts = [git, join(git, 'config'), ...FORBIDDEN_GIT_ENTRIES.map(entry => join(git, entry)), hooks]
    .map(path => `${path}=${token(fs, path)}`)
  for (const name of hookEntries(fs, hooks)) parts.push(`${name}=${token(fs, join(hooks, name))}`)
  return parts.join('|')
}
