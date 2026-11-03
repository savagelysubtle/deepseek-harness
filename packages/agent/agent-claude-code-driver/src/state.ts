/**
 * Private on-disk state of the driver (the pid ledger and the binary pins):
 * a directory only the operator can enter, files created exclusively and
 * replaced atomically, nothing followed through a symlink.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/state
 */

import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The running user id, or `undefined` on platforms without one (ownership is then not checked). */
export function currentUid(): number | undefined {
  return process.getuid?.()
}

/**
 * Resolve the driver's state directory: always inside the harness home
 * (`dshHome`, else `$DSH_HOME`, else `~/.dsh`). A relative name is taken as a
 * subdirectory of it; an absolute path is accepted only when it already lies
 * inside it.
 * @param stateDir - configured subdirectory name or absolute path inside the home.
 * @param dshHome - the harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the absolute state directory.
 * @throws when the result would escape the harness home.
 */
export function resolveStateDir(stateDir: string, dshHome?: string): string {
  const home = resolve(dshHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
  const target = isAbsolute(stateDir) ? resolve(stateDir) : resolve(home, stateDir)
  const rel = relative(home, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `agent-claude-code-driver: stateDir "${stateDir}" must name a subdirectory of the harness home ${home} (set DSH_HOME or pass dshHome)`,
    )
  }
  return target
}

/**
 * Create the state directory (mode 0700) and verify it: a real directory,
 * owned by the running user, with no group or world access.
 * @param dir - absolute directory.
 * @param uid - expected owner; defaults to the running user.
 * @throws when the directory is a symlink, foreign-owned, or accessible by others.
 */
export function ensurePrivateDir(dir: string, uid: number | undefined = currentUid()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory()) {
    throw new Error(`agent-claude-code-driver: state directory ${dir} is not a real directory (symlinks are refused); remove it and restart`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`agent-claude-code-driver: state directory ${dir} is owned by uid ${stat.uid}, not ${uid}; refusing to trust it`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`agent-claude-code-driver: state directory ${dir} is accessible by group or others (mode ${(stat.mode & 0o777).toString(8)}); run chmod 700 on it and restart`)
  }
}

/**
 * Check an existing state file: a regular file (not a symlink), owned by the
 * running user, readable only by them.
 * @param file - absolute file path; a missing file passes.
 * @param uid - expected owner; defaults to the running user.
 * @throws when the file exists but is not trustworthy.
 */
export function assertPrivateFile(file: string, uid: number | undefined = currentUid()): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(file)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile()) {
    throw new Error(`agent-claude-code-driver: state file ${file} is not a regular file (symlinks are refused); remove it and restart`)
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`agent-claude-code-driver: state file ${file} is owned by uid ${stat.uid}, not ${uid}; refusing to trust it`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`agent-claude-code-driver: state file ${file} is accessible by group or others (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600 on it and restart`)
  }
}

/**
 * Replace a state file atomically: the new content goes to a freshly created
 * (exclusive, mode 0600) temporary file in the same directory, then renames over.
 * @param file - absolute destination path.
 * @param text - the new content.
 */
export function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
  renameSync(temp, file)
}

/** File name of the kill-switch flag, inside the driver's state directory. */
export const KILL_SWITCH_FILE_NAME = 'claude-code-kill-switch'

/**
 * Whether the kill-switch flag file exists. A file that cannot be examined
 * (anything but "not there") counts as present: the switch fails closed.
 * @param file - absolute path of the flag file.
 * @returns true when the seats must stop.
 */
export function killSwitchPresent(file: string): boolean {
  try {
    lstatSync(file)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}
