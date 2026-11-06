/**
 * Attestation of the two files a hook command executes: the node binary and the guard script. Same
 * rules as the driver's claude binary attestation (regular file, operator-owned, not group- or
 * world-writable, in a directory chain nobody else can write, SHA-256 pinned) minus the
 * "no script extension" rule, which exists to stop the SDK resolving `node` through PATH and cannot
 * apply to a script. The hash helper is the driver's own `sha256File`; the rest mirrors
 * `attestClaudePath` because that function is not parameterised.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/attest-guard
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { sha256File } from '@deepseek-ai/dsh-agent-claude-code-driver'

/** What was verified about one executable file. */
export interface AttestedFile {
  /** The configured path. */
  readonly path: string
  /** The resolved path every check ran against; use this one in a command line. */
  readonly realPath: string
  /** Lower-case hex SHA-256 of the content. */
  readonly sha256: string
  /** Size, times and inode at attestation, for the cheap re-check. */
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly ino: number
}

/** Options of {@link attestFile}. */
export interface AttestFileOptions {
  /** `exec` also requires the execute bit (node); `read` requires readability (the script). */
  readonly access: 'exec' | 'read'
  /** Expected owner besides root; defaults to the running user. */
  readonly uid?: number | undefined
  /** Pinned digest the content must match. */
  readonly expectedSha256?: string | undefined
  /** The passwd database consulted for the private-group rule; default `/etc/passwd`. Injected by tests. */
  readonly passwdPath?: string
  /** The group database consulted for the private-group rule; default `/etc/group`. Injected by tests. */
  readonly groupPath?: string
}

/** Split a passwd or group file into colon-separated records. */
function records(text: string): string[][] {
  return text.split('\n').filter(line => line !== '' && !line.startsWith('#')).map(line => line.split(':'))
}

/**
 * Whether a group-writable bit on this file is harmless because the group is the owner's private one.
 * The same uid already owns the file and can change its mode, so the group bit only matters when a second
 * principal can act through the group. That is ruled out only when all of these hold, read straight from
 * the databases (no NSS, no lookups): the owner is the running user or root (checked before this runs); the group with the file's
 * gid is named exactly like the owner's passwd entry; its member list is empty or the owner alone; and no
 * other passwd entry has that gid as its primary group. If either file cannot be read, or the owner or gid is
 * not found there (NSS or LDAP accounts), the answer is no and the strict rule applies.
 * @param stat - the file or directory stat.
 * @param uid - the running user, when known.
 * @param passwdPath - passwd database path.
 * @param groupPath - group database path.
 * @returns true when the group bit can be ignored.
 */
function isOwnersPrivateGroup(stat: Stats, uid: number | undefined, passwdPath: string, groupPath: string): boolean {
  // The caller has already required the owner to be the running user or root, so only an unknown user is left to refuse.
  if (uid === undefined) return false
  let passwd: string[][]
  let groups: string[][]
  try {
    passwd = records(readFileSync(passwdPath, 'utf8'))
    groups = records(readFileSync(groupPath, 'utf8'))
  } catch {
    return false
  }
  const owner = passwd.find(entry => Number(entry[2]) === stat.uid)
  const group = groups.find(entry => Number(entry[2]) === stat.gid)
  if (owner === undefined || group === undefined || group[0] !== owner[0]) return false
  if ((group[3] ?? '').split(',').some(member => member !== '' && member !== owner[0])) return false
  return !passwd.some(entry => entry !== owner && Number(entry[3]) === stat.gid)
}

/**
 * Verify a file the hook will execute. Deliberate deviation from the driver's `attestClaudePath`: a
 * file owned by root is accepted as well as one owned by the operator (so a distribution-installed
 * `node` under `/usr/bin` can be attested); the driver demands operator ownership of the claude binary.
 * Everything else (regular file, not group/world-writable, safe directory chain, pinned SHA-256) matches.
 * @param path - the configured absolute path.
 * @param options - access kind, owner and optional pinned digest.
 * @returns the attestation.
 * @throws a message naming the path and the failed check.
 */
export function attestFile(path: string, options: AttestFileOptions): AttestedFile {
  const uid = 'uid' in options ? options.uid : process.getuid?.()
  const fail = (reason: string): never => {
    throw new Error(`agent-claude-code-tools: ${path} refused: ${reason}`)
  }
  if (!isAbsolute(path)) fail('the path must be absolute')
  let realPath = ''
  try {
    realPath = realpathSync(path)
  } catch (error: unknown) {
    fail(`cannot resolve it (${String((error as NodeJS.ErrnoException).code)})`)
  }
  const stat = statSync(realPath)
  if (!stat.isFile()) fail('it is not a regular file')
  if (uid !== undefined && stat.uid !== uid && stat.uid !== 0) fail(`it is owned by uid ${stat.uid}, neither the running user ${uid} nor root`)
  const passwdPath = options.passwdPath ?? '/etc/passwd'
  const groupPath = options.groupPath ?? '/etc/group'
  // World-writable is always refused; group-writable only when the group is the owner's private one.
  const unsafe = (item: Stats): boolean => (item.mode & 0o002) !== 0
    || ((item.mode & 0o020) !== 0 && !isOwnersPrivateGroup(item, uid, passwdPath, groupPath))
  if (unsafe(stat)) fail('it is group- or world-writable')
  try {
    accessSync(realPath, options.access === 'exec' ? constants.X_OK : constants.R_OK)
  } catch {
    fail(options.access === 'exec' ? 'it is not executable by the running user' : 'it is not readable by the running user')
  }
  for (const start of new Set([dirname(realPath), dirname(resolve(path))])) {
    for (let dir = start; ; dir = dirname(dir)) {
      const dirStat = statSync(dir)
      if (unsafe(dirStat) && (dirStat.mode & 0o1000) === 0) fail(`its directory ${dir} is group- or world-writable`)
      if (uid !== undefined && dirStat.uid !== 0 && dirStat.uid !== uid) fail(`its directory ${dir} is owned by uid ${dirStat.uid}, neither the running user nor root`)
      if (dirname(dir) === dir) break
    }
  }
  const sha256 = sha256File(realPath)
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
    fail(`its SHA-256 is ${sha256} but ${options.expectedSha256} is pinned`)
  }
  return { path, realPath, sha256, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }
}

/**
 * Cheap re-check that an attested file is still the same file: the configured path still resolves
 * to the attested real path and the size, times and inode are unchanged.
 * @param attested - what {@link attestFile} returned.
 * @throws when the file moved or changed.
 */
export function assertAttestedUnchanged(attested: AttestedFile): void {
  let resolved = ''
  try {
    resolved = realpathSync(attested.path)
  } catch {
    // an unresolvable path counts as changed below
  }
  const stat = statSync(attested.realPath)
  if (
    resolved !== attested.realPath
    || stat.size !== attested.size || stat.mtimeMs !== attested.mtimeMs
    || stat.ctimeMs !== attested.ctimeMs || stat.ino !== attested.ino
  ) {
    throw new Error(`agent-claude-code-tools: ${attested.path} changed since this host attested it; restart the host to re-attest it`)
  }
}
