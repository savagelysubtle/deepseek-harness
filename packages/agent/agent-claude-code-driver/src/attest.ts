/**
 * Attestation of the pinned `claude` binary: before a seat may run it, the
 * file must be a real, operator-owned, executable binary that nobody else can
 * swap, and its SHA-256 must match the first one this host saw for the seat.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/attest
 */

import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertPrivateFile, currentUid, writeAtomic } from './state.ts'

/** Script extensions that would make the SDK resolve `node` or a shell through PATH. */
const SCRIPT_EXTENSION = /\.(?:js|mjs|cjs|sh|py)$/i

/** What was verified about one binary. */
export interface BinaryAttestation {
  /** The configured path. */
  readonly path: string
  /** The resolved path every check ran against. */
  readonly realPath: string
  /** Lower-case hex SHA-256 of the file content. */
  readonly sha256: string
  /** Size, modification time and inode at attestation, for the cheap per-turn re-check. */
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
}

/** Options of {@link attestClaudePath}. */
export interface AttestOptions {
  /** Expected owner; defaults to the running user. */
  readonly uid?: number | undefined
}

/**
 * SHA-256 of a file, read in chunks so a large binary is not held in memory.
 * @param file - absolute path.
 * @returns lower-case hex digest.
 */
export function sha256File(file: string): string {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) {
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * Verify the pinned binary: a regular, executable file owned by the operator,
 * not group- or world-writable, with no script extension, in a directory chain
 * where no component is group- or world-writable (a sticky directory such as
 * `/tmp` is exempt: others there cannot replace the operator's files).
 * @param path - the configured absolute path.
 * @param options - expected owner.
 * @returns the attestation (hash and stat signature).
 * @throws a message naming the path and the failed check.
 */
export function attestClaudePath(path: string, options: AttestOptions = {}): BinaryAttestation {
  const uid = 'uid' in options ? options.uid : currentUid()
  const fail = (reason: string): never => {
    throw new Error(`agent-claude-code-driver: claude_path ${path} refused: ${reason}`)
  }
  let realPath: string
  try {
    realPath = realpathSync(path)
  } catch (error: unknown) {
    return fail(`cannot resolve it (${String((error as NodeJS.ErrnoException).code)}); point claude_path at the real binary`)
  }
  if (SCRIPT_EXTENSION.test(path) || SCRIPT_EXTENSION.test(basename(realPath))) {
    fail('it is a script (.js/.mjs/.cjs/.sh/.py); the SDK would run it through a PATH lookup. Use the native claude binary')
  }
  const stat = statSync(realPath)
  if (!stat.isFile()) fail('it is not a regular file')
  if (uid !== undefined && stat.uid !== uid) fail(`it is owned by uid ${stat.uid}, not the running user ${uid}`)
  if ((stat.mode & 0o022) !== 0) fail('it is group- or world-writable; run chmod go-w on it')
  try {
    accessSync(realPath, constants.X_OK)
  } catch {
    fail('it is not executable by the running user')
  }
  for (let dir = dirname(realPath); ; dir = dirname(dir)) {
    const dirStat = statSync(dir)
    if ((dirStat.mode & 0o022) !== 0 && (dirStat.mode & 0o1000) === 0) {
      fail(`its directory ${dir} is group- or world-writable (mode ${(dirStat.mode & 0o777).toString(8)}); someone else could swap the binary`)
    }
    if (dirname(dir) === dir) break
  }
  return { path, realPath, sha256: sha256File(realPath), size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }
}

/**
 * Cheap per-turn re-check that the attested file is still the same file.
 * @param attestation - what {@link attestClaudePath} returned at start.
 * @throws when the size, modification time or inode changed since.
 */
export function assertBinaryUnchanged(attestation: BinaryAttestation): void {
  const stat = statSync(attestation.realPath)
  if (stat.size !== attestation.size || stat.mtimeMs !== attestation.mtimeMs || stat.ino !== attestation.ino) {
    throw new Error(
      `agent-claude-code-driver: claude binary ${attestation.path} changed since this host attested it; restart the host to re-attest it (set claude_code.claude_path_sha256 to the new hash to accept an upgrade)`,
    )
  }
}

/** First-seen SHA-256 per seat, kept in the private state directory. */
export class BinaryPins {
  private readonly file: string
  private pins: Record<string, string> = {}

  /**
   * @param stateDir - the private state directory.
   * @param uid - expected owner of the pin file; defaults to the running user.
   */
  constructor(stateDir: string, uid: number | undefined = currentUid()) {
    this.file = join(stateDir, 'claude-code-binary-pins.json')
    assertPrivateFile(this.file, uid)
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      this.pins = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`agent-claude-code-driver: binary pin file ${this.file} is unreadable (${(error as Error).message}); fix or delete it after checking the binaries, then restart`)
    }
  }

  /**
   * Record the first-seen hash for a seat, or refuse when it changed.
   * @param seat - seat key.
   * @param sha256 - the hash just computed.
   * @param explicit - the row's `claude_path_sha256`; when set it must match the file and it re-pins.
   * @throws when the file does not match the explicit pin, or differs from the first-seen hash.
   */
  enforce(seat: string, sha256: string, explicit: string | undefined): void {
    if (explicit !== undefined && explicit !== sha256) {
      throw new Error(`agent-claude-code-driver: seat "${seat}": the binary's SHA-256 is ${sha256} but claude_path_sha256 pins ${explicit}; refusing to run it`)
    }
    const seen = this.pins[seat]
    if (explicit === undefined && seen !== undefined && seen !== sha256) {
      throw new Error(
        `agent-claude-code-driver: seat "${seat}": the claude binary changed (first seen ${seen}, now ${sha256}); `
        + `if this upgrade is intended set claude_code.claude_path_sha256: ${sha256} on the row to re-pin, otherwise restore the original binary`,
      )
    }
    if (seen === sha256) return
    this.pins = { ...this.pins, [seat]: sha256 }
    writeAtomic(this.file, `${JSON.stringify(this.pins)}\n`)
  }
}
