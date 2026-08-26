/**
 * Named-session derivation and per-name locking, shared by every consumer
 * that addresses a durable session by a stable human-chosen name.
 *
 * A named session has no map store: the durable session id is derived from the
 * user-chosen name, so every process recomputes the same identity from the
 * name alone. The same derivation names the per-name lock file under the
 * canonical lock directory ({@link LOCK_DIR_SEGMENTS}), which is what makes
 * "one live holder per name" enforceable across processes.
 *
 * @module @deepseek-ai/dsh-named-sessions
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Prefix of every derived named-session id. */
export const NAMED_SESSION_ID_PREFIX = 'named-'

/** Source form of a derived named-session id's token: 32 lowercase hex characters. */
export const NAMED_SESSION_TOKEN_PATTERN_SOURCE = '[0-9a-f]{32}'

/** Source form of the accepted session-name grammar; also surfaced in usage errors. */
export const SESSION_NAME_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

const SESSION_NAME_PATTERN = new RegExp(SESSION_NAME_PATTERN_SOURCE)

/**
 * Canonical home-relative directory holding one lock file per active named
 * session. Every consumer of this package shares the artifact location, so
 * independently written runners exclude each other through the same files.
 */
export const LOCK_DIR_SEGMENTS = ['headless', 'locks'] as const

/**
 * Bound on create-race takeover attempts during one acquisition. Each lost
 * attempt re-reads the winner's holder record, so a genuinely live contender
 * is reported before this bound can matter; the bound only stops two acquirers
 * from trading an abandoned artifact forever.
 */
export const LOCK_ACQUIRE_ATTEMPTS = 5

/** Shape persisted inside a held lock file. */
interface LockPayload {
  /** Process id of the holder. */
  pid: number
  /** Holder-side epoch-milliseconds timestamp, kept for diagnostics and age takeover. */
  createdAt: number
}

/**
 * Process seams the unit suite substitutes; production values probe the
 * operating system directly.
 */
export const internals: { isPidAlive(pid: number): boolean } = {
  /**
   * Signal-0 liveness probe: delivery success means alive, "no such process"
   * means dead, and any other failure (for example permission) counts as
   * alive because the holder cannot be proved gone.
   */
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
}

/**
 * Enforce the accepted session-name grammar. The bound keeps the derived
 * token a fixed-width filename component on every platform.
 * @param name - the raw session-name value.
 * @throws when the name violates the accepted grammar.
 */
export function assertValidSessionName(name: string): void {
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new Error(`invalid session name ${JSON.stringify(name)}: must match ${SESSION_NAME_PATTERN_SOURCE}`)
  }
}

/**
 * Hash a session name to the fixed-width token shared by the derived session
 * id and the lock filename. One-way by construction: the name is never stored
 * in the token, so the caller owns any name-to-id directory.
 * @param name - a validated session name.
 * @returns the 32-character lowercase hex token.
 */
function hashToken(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Derive the stable session id for a named run. Deterministic across
 * processes and machines: the same name always yields the same durable id,
 * which is how later invocations find the earlier run's log.
 * @param name - a validated session name.
 * @returns the derived branded session id (`named-<32 hex>`).
 */
export function deriveNamedSessionId(name: string): SessionId {
  return SessionId(`${NAMED_SESSION_ID_PREFIX}${hashToken(name)}`)
}

/**
 * Resolve this package's per-name lock file path under the Harness home. The
 * filename carries the same token as {@link deriveNamedSessionId}, so an id
 * and its lock share one derivation.
 * @param name - a validated session name.
 * @returns the absolute lock-file path.
 */
export function namedLockPath(name: string): string {
  return lockPathForToken(hashToken(name))
}

/**
 * Resolve the lock path for an already-derived token. The invariant companion
 * goes through this entry so the id-to-lock algebra lives in exactly one place.
 * @param token - the 32-hex token of a derived named-session id.
 * @returns the absolute lock-file path.
 */
export function lockPathForToken(token: string): string {
  return dshHomePath(...LOCK_DIR_SEGMENTS, `${token}.lock`)
}

/** An exclusively held per-name lock. */
export interface NamedSessionLock {
  /** Absolute path of the held lock file. */
  readonly path: string
  /**
    * Remove the held lock file, but only while it still records this holder:
    * a taken-over artifact belongs to its successor and is left alone. A
    * file that disappeared while held ends release silently; other read or
    * unlink failures propagate.
    */
  release(): void
}

/** Optional acquisition bounds; absent fields keep the shipped semantics. */
export interface AcquireNamedSessionLockOptions {
  /**
   * Take over a lock whose live holder recorded a `createdAt` older than this
   * many milliseconds — a bounded-wait escape for holders that cannot be
   * trusted to release. Absent (the default): pid liveness is the only
   * takeover path, so an alive holder always rejects acquisition.
   */
  readonly maxAgeMs?: number
}

/**
 * Take the per-name lock for one named run, failing loud while another live
 * process holds it and taking over an abandoned file whose holder pid is no
 * longer alive (or whose content names no readable holder). With
 * `maxAgeMs`, a live holder older than the bound also loses the artifact.
 * The lock must be held across agent creation/resumption and released after
 * the run settles.
 * @param name - a validated session name.
 * @param options - optional bounds; see {@link AcquireNamedSessionLockOptions}.
 * @returns the held lock.
 * @throws when a live process holds the lock: `session "<name>" is active in another process`.
 */
export function acquireNamedSessionLock(
  name: string,
  options: AcquireNamedSessionLockOptions = {},
): NamedSessionLock {
  const path = namedLockPath(name)
  mkdirSync(dirname(path), { recursive: true })
  // Written once per acquisition; release compares it verbatim so a
  // taken-over artifact is never removed by its previous holder.
  const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies LockPayload)
  let handle: number | undefined
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && handle === undefined; attempt += 1) {
    try {
      handle = openSync(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throwIfLiveHolder(path, name, options.maxAgeMs)
      // No provable live owner: the file is abandoned (dead holder,
      // unreadable content, removed between the failed open and the read,
      // or — with `maxAgeMs` — a live holder past the age bound).
      unlinkAbandoned(path)
    }
  }
  if (handle === undefined) {
    // Every attempt lost the create race to another acquirer, whose own
    // holder read reports the live owner on its side.
    throw new Error(`session "${name}" is active in another process`)
  }
  try {
    writeSync(handle, payload)
  } finally {
    closeSync(handle)
  }
  return {
    path,
    release(): void {
      let current: string
      try {
        current = readFileSync(path, 'utf8')
      } catch (error) {
        // An already-absent artifact leaves nothing behind to clean up.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (current !== payload) return
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

/**
 * Read a lock file's holder and reject when that holder must be honored:
 * provably alive and not aged out by `maxAgeMs`. Unreadable or malformed
 * content names no provable owner and counts as abandoned; a live holder
 * without a readable timestamp cannot be proved old, so it still rejects.
 * @param path - the contended lock file.
 * @param name - the session name the lock belongs to, for the failure message.
 * @param maxAgeMs - the caller's age-takeover bound, when one was set.
 * @throws when the recorded holder process must be honored.
 */
function throwIfLiveHolder(path: string, name: string, maxAgeMs: number | undefined): void {
  let payload: LockPayload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8')) as LockPayload
  } catch {
    // A torn or foreign lock file names no provable live holder; treating it
    // as abandoned beats wedging the named session forever.
    return
  }
  if (typeof payload.pid !== 'number' || !Number.isInteger(payload.pid) || payload.pid < 1) return
  if (!internals.isPidAlive(payload.pid)) return
  if (
    maxAgeMs !== undefined
    && typeof payload.createdAt === 'number'
    && Number.isFinite(payload.createdAt)
    && Date.now() - payload.createdAt > maxAgeMs
  ) {
    // Live but older than the caller's bound: the artifact reverts to abandoned.
    return
  }
  throw new Error(`session "${name}" is active in another process`)
}

/**
 * Remove an abandoned lock file before taking it over.
 * @param path - the abandoned lock file.
 */
function unlinkAbandoned(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    // Another taker may have removed the abandoned file first; reopening is
    // the arbitration, so absence here is not a failure.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
