/**
 * Named-session derivation and per-name locking, shared by every consumer
 * that addresses a durable session by a stable human-chosen name.
 *
 * A named session has no map store: the durable session id is derived from
 * the project anchor plus the user-chosen name, so every process running in
 * the same project recomputes the same identity from those two values alone.
 * The anchor ({@link projectAnchor}) is the git common directory when the
 * working directory belongs to a repository — so every worktree of one
 * repository shares its sessions' identities — and the resolved working
 * directory itself otherwise. The same derivation names the per-name lock
 * file under the canonical lock directory ({@link LOCK_DIR_SEGMENTS}), which
 * is what makes "one live holder per name" enforceable across processes.
 *
 * @module @deepseek-ai/dsh-named-sessions
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import { projectAnchor } from './anchor.ts'

export { ANCHOR_MARKER_FILENAME, PROJECT_ANCHOR_GIT_TIMEOUT_MS, projectAnchor } from './anchor.ts'

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
  /**
   * Holder process start time in clock ticks since boot (`/proc/<pid>/stat`
   * field 22), captured at acquire. A recycled pid serving a different
   * process reports different ticks, so a lock outliving its owner reads as
   * abandoned instead of fencing the seat forever. Absent in lock files
   * written before this field existed, and on platforms without `/proc`.
   */
  startTicks?: number
}

/**
 * Process seams the unit suite substitutes; production values probe the
 * operating system directly.
 */
export const internals: {
  isPidAlive(pid: number): boolean
  processStartTicks(pid: number): number | undefined
} = {
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
  /**
   * Read a process's start time in clock ticks since boot from
   * `/proc/<pid>/stat` (field 22). The comm field may contain spaces and is
   * skipped by its parenthesis delimiters; after it, fields restart at
   * state(3), so starttime(22) is entry 19 of the remaining split.
   * Undefined when the platform has no `/proc` or the read fails — callers
   * treat undefined as "instance identity unavailable".
   */
  processStartTicks(pid: number): number | undefined {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const after = stat.slice(stat.lastIndexOf(')') + 2)
      const ticks = Number(after.split(' ')[19])
      return Number.isFinite(ticks) ? ticks : undefined
    } catch {
      return undefined
    }
  },
}

/**
 * Whether a lock holder record names a process that is both alive and the
 * SAME process instance that wrote the record: a bare pid probe alone would
 * honor a recycled pid, permanently fencing the seat. A record without
 * start ticks (pre-hardening file, or a platform without `/proc`) falls back
 * to pid liveness only.
 * @param holder - the pid plus optional start ticks read from a lock file.
 * @returns whether the recorded holder must be honored as live.
 */
export function isLockHolderLive(holder: { readonly pid: number; readonly startTicks?: number }): boolean {
  if (!internals.isPidAlive(holder.pid)) return false
  if (holder.startTicks === undefined) return true
  const current = internals.processStartTicks(holder.pid)
  // No /proc on this platform: instance identity is unavailable, so the
  // pid liveness result stands rather than fencing a seat on missing data.
  if (current === undefined) return true
  return current === holder.startTicks
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
 * Separator between the project anchor and the session name inside one hash
 * input. NUL cannot appear in a filesystem path or a session name, so the
 * joined value is injective — an anchor ending in `ab` with name `c` can
 * never collide with an anchor ending in `a` and name `bc`.
 */
const ANCHOR_NAME_SEPARATOR = '\0'

/**
 * Hash one identity source to the fixed-width token shared by derived session
 * ids and lock filenames. One-way by construction: the source is never stored
 * in the token, so the caller owns any source-to-id directory.
 * @param source - the exact identity source (anchor-joined name, or a raw
 *   session id for non-derived sessions).
 * @returns the 32-character lowercase hex token.
 */
function hashToken(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Token for one named run: the project anchor scopes the name so two
 * repositories never derive the same name into one session id, while every
 * worktree of one repository derives the same id.
 * @param name - a validated session name.
 * @param cwd - working directory naming the project; see {@link projectAnchor}.
 * @returns the 32-character lowercase hex token.
 */
function namedToken(name: string, cwd: string): string {
  return hashToken(`${projectAnchor(cwd)}${ANCHOR_NAME_SEPARATOR}${name}`)
}

/**
 * Derive the stable session id for a named run. Deterministic across
 * processes: the same name in the same project always yields the same
 * durable id, which is how later invocations find the earlier run's log.
 * @param name - a validated session name.
 * @param cwd - working directory naming the project; defaults to the process
 *   working directory, which is how every production consumer derives.
 * @returns the derived branded session id (`named-<32 hex>`).
 */
export function deriveNamedSessionId(name: string, cwd: string = process.cwd()): SessionId {
  return SessionId(`${NAMED_SESSION_ID_PREFIX}${namedToken(name, cwd)}`)
}

/**
 * Resolve this package's per-name lock file path under the Harness home. The
 * filename carries the same token as {@link deriveNamedSessionId}, so an id
 * and its lock share one derivation.
 * @param name - a validated session name.
 * @param cwd - working directory naming the project; must match the
 *   derivation cwd so the lock guards the id that is actually written.
 * @returns the absolute lock-file path.
 */
export function namedLockPath(name: string, cwd: string = process.cwd()): string {
  return lockPathForToken(namedToken(name, cwd))
}

/**
 * Extract the 32-hex token from a derived named-session id.
 * @param sessionId - a session id, named-derived or otherwise.
 * @returns the token, or undefined when the id is not name-derived.
 */
export function namedSessionToken(sessionId: string): string | undefined {
  if (!sessionId.startsWith(NAMED_SESSION_ID_PREFIX)) return undefined
  const token = sessionId.slice(NAMED_SESSION_ID_PREFIX.length)
  return new RegExp(`^${NAMED_SESSION_TOKEN_PATTERN_SOURCE}$`).test(token) ? token : undefined
}

/**
 * Resolve the per-session lock path for a session id.
 *
 * **Lock the identity that is actually written, not the name that labels it.**
 * {@link namedLockPath} derives from the name, which is correct only while a
 * seat's id is also derived from its name. Once identity is recorded in the org
 * registry, the two come apart: a rename moves the name-derived lock while the
 * log stays where it was, so two processes can hold two different locks over one
 * file. That is the corruption class this function exists to close.
 *
 * A non-derived id (a UI-created session, or an adopted one) hashes its own
 * string, so every session has exactly one lock regardless of how it was named.
 * @param sessionId - the durable session id being written.
 * @returns the absolute lock-file path for that session.
 */
export function lockPathForSession(sessionId: string): string {
  return lockPathForToken(namedSessionToken(sessionId) ?? hashToken(sessionId))
}

/**
 * Take the per-session lock for one session id.
 *
 * Prefer this over {@link acquireNamedSessionLock}: it locks the written
 * identity rather than the label, so a renamed seat cannot end up with two live
 * writers holding two different locks over one log.
 * @param sessionId - the durable session id being written.
 * @param options - optional bounds; see {@link AcquireNamedSessionLockOptions}.
 * @param label - human-facing identity for the contention error; defaults to the
 *   id. Pass the seat name — an operator reading `session "robin" is active`
 *   learns something, whereas a 32-hex token tells them nothing.
 * @returns the held lock.
 * @throws when a live process holds it: `session "<label>" is active in another process`.
 */
export function acquireSessionLock(
  sessionId: string,
  options: AcquireNamedSessionLockOptions = {},
  label: string = sessionId,
): NamedSessionLock {
  return acquireLockAtPath(lockPathForSession(sessionId), label, options)
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
 * @param cwd - working directory naming the project; must match the
 *   derivation cwd so the lock guards the id that is actually written.
 * @returns the held lock.
 * @throws when a live process holds the lock: `session "<name>" is active in another process`.
 */
export function acquireNamedSessionLock(
  name: string,
  options: AcquireNamedSessionLockOptions = {},
  cwd: string = process.cwd(),
): NamedSessionLock {
  return acquireLockAtPath(namedLockPath(name, cwd), name, options)
}

/**
 * Acquire one lock artifact, shared by the name-keyed and session-keyed entries.
 * @param path - the lock file to take.
 * @param label - identity named in the contention error (a name or a session id).
 * @param options - optional bounds; see {@link AcquireNamedSessionLockOptions}.
 * @returns the held lock.
 * @throws when a live process holds it.
 */
function acquireLockAtPath(
  path: string,
  label: string,
  options: AcquireNamedSessionLockOptions,
): NamedSessionLock {
  mkdirSync(dirname(path), { recursive: true })
  // Written once per acquisition; release compares it verbatim so a
  // taken-over artifact is never removed by its previous holder.
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    ...(() => {
      const startTicks = internals.processStartTicks(process.pid)
      return startTicks === undefined ? {} : { startTicks }
    })(),
  } satisfies LockPayload)
  let handle: number | undefined
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && handle === undefined; attempt += 1) {
    try {
      handle = openSync(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throwIfLiveHolder(path, label, options.maxAgeMs)
      // No provable live owner: the file is abandoned (dead holder,
      // unreadable content, removed between the failed open and the read,
      // or — with `maxAgeMs` — a live holder past the age bound).
      unlinkAbandoned(path)
    }
  }
  if (handle === undefined) {
    // Every attempt lost the create race to another acquirer, whose own
    // holder read reports the live owner on its side.
    throw new Error(`session "${label}" is active in another process`)
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
  if (!isLockHolderLive(payload)) return
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
