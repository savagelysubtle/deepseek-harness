/**
 * Cross-process "follow mode" for named sessions: detect a live headless
 * owner of a `named-<token>` session by reading the SAME per-name lock file
 * `dsh --profile headless --session-name <name>` already takes — no new lock
 * format, no IPC — and, while that owner is live, poll-tail the owner's own
 * on-disk log so this host can push real `session/event` frames for turns it
 * never ran itself.
 *
 * This exists because `ensureSession`/`agentFor` used to resume or attach any
 * `named-*` session by id with no cross-process check at all: an open web
 * tab and a headless run could hold the same durable log with two
 * independent next-seq counters, which is a data-loss bug, not just a stale
 * read. Once a live owner is detected, this host must never attach or resume
 * that identity itself — it only follows.
 * @module
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  internals as namedSessionInternals, lockPathForToken, NAMED_SESSION_ID_PREFIX,
} from '@deepseek-ai/dsh-named-sessions'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  decompressZstdFrame, scanZstdFrames,
} from '@deepseek-ai/dsh-session-persistence-jsonl'

/** Shape of the JSON a held headless lock file records; read-only mirror of `dsh-named-sessions`'s internal payload. */
interface HeadlessLockPayload {
  readonly pid: number
}

/** A live headless owner detected for a named session. */
export interface LiveHeadlessOwner {
  /** Process id recorded in the lock file, already probed alive. */
  readonly pid: number
}

/** Extract a derived named-session id's 32-hex token, or undefined for any id this host did not derive from a name. */
function namedSessionToken(sessionId: SessionId): string | undefined {
  return sessionId.startsWith(NAMED_SESSION_ID_PREFIX)
    ? sessionId.slice(NAMED_SESSION_ID_PREFIX.length)
    : undefined
}

/**
 * Detect whether a named session currently has a live headless holder.
 *
 * Fails soft in every direction, matching `dsh-named-sessions`'s own steal
 * semantics for an abandoned lock: a missing, torn, or unreadable lock file,
 * an unparseable payload, or any stat/read failure all read as "no live
 * owner" rather than throwing. Only a lock file naming a pid that is
 * currently provably alive counts as a live owner.
 *
 * A lock held by THIS process is never a foreign owner. `mailbox-bridge`
 * mounted in this host takes the very same per-name lock while it cold-resumes
 * a dormant seat to deliver mail (`deliverLease`), recording our own pid.
 * Without this check the host would read its own lock as a rival, refuse its
 * own UI input with `agent-busy`, and start tailing a log it is itself
 * writing — fighting itself for every wake-on-arrival delivery.
 * @param sessionId - the transcript identity a caller wants to read or write.
 * @returns the live FOREIGN owner, or undefined when this session has none (or is not a named session at all).
 */
export async function liveHeadlessOwner(sessionId: SessionId): Promise<LiveHeadlessOwner | undefined> {
  const token = namedSessionToken(sessionId)
  if (token === undefined) return undefined
  let payload: HeadlessLockPayload
  try {
    payload = JSON.parse(await readFile(lockPathForToken(token), 'utf8')) as HeadlessLockPayload
  } catch {
    return undefined
  }
  if (typeof payload.pid !== 'number' || !Number.isInteger(payload.pid) || payload.pid < 1) return undefined
  if (payload.pid === process.pid) return undefined
  return namedSessionInternals.isPidAlive(payload.pid) ? { pid: payload.pid } : undefined
}

/** How often the host re-scans the lock directory for newly-owned sessions to follow. */
export const FOLLOW_SWEEP_INTERVAL_MS = 1_000

/** A 32-hex lock token, the shared derivation behind both a lock filename and its session id. */
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{32}$/
const LOCK_FILE_SUFFIX = '.lock'

/**
 * Every named session a live headless process currently owns, read straight
 * from the lock directory.
 *
 * This is what lets following start without a client read: a host cannot
 * learn about an owner that appeared AFTER the page was opened by waiting for
 * another `history()` call, because a page that is simply sitting open never
 * makes one. The locks are already on disk, written by headless itself, so
 * they are the one signal available to a process no browser is talking to.
 * @returns ids of named sessions whose lock names a currently-alive pid.
 */
export async function listLiveOwnedSessionIds(): Promise<SessionId[]> {
  const lockDir = dirname(lockPathForToken('0'.repeat(32)))
  let entries: string[]
  try {
    entries = await readdir(lockDir)
  } catch {
    return [] // no lock directory yet: nothing has ever run headless here
  }
  const owned: SessionId[] = []
  for (const entry of entries) {
    if (!entry.endsWith(LOCK_FILE_SUFFIX)) continue
    const token = entry.slice(0, -LOCK_FILE_SUFFIX.length)
    if (!LOCK_TOKEN_PATTERN.test(token)) continue
    const sessionId = `${NAMED_SESSION_ID_PREFIX}${token}` as SessionId
    if (await liveHeadlessOwner(sessionId) !== undefined) owned.push(sessionId)
  }
  return owned
}

/** Per-session tail cursor: bytes already consumed and the highest seq already pushed. */
interface TailCursor {
  offset: number
  lastSeq: number
}

/** Collaborators the tailer needs from its owning host, kept narrow for easy substitution in tests. */
export interface FollowTailerDeps {
  /** Resolve a followed session's on-disk artifact path, or undefined for a backend with no per-session file (e.g. SQLite). */
  locate(header: SessionHeader): { path: string } | undefined
  /** Re-probe whether the session still has a live headless owner; the tailer self-stops once this reports none. */
  liveOwner(sessionId: SessionId): Promise<LiveHeadlessOwner | undefined>
  /** Push one newly observed event for a followed session onto the live channel. */
  push(sessionId: SessionId, event: SessionEvent): void
  /** Poll interval in ms between checks of a followed session's artifact; defaults to 1000. */
  intervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 1_000

/**
 * Poll-tails followed sessions' on-disk logs and pushes their new events as
 * real `session/event` frames, so a client already viewing the transcript
 * sees turns a headless process runs in another process without reloading.
 *
 * A stat-and-scan loop, not `fs.watch`: there is no existing file-watch
 * utility anywhere in the session/host packages this could reuse, and
 * inotify reliability across every deployment mount is unverified. Cost is
 * bounded to one stat per interval per currently FOLLOWED session, never
 * every session this host knows about.
 */
export class FollowTailer {
  private readonly cursors = new Map<SessionId, TailCursor>()
  private readonly timers = new Map<SessionId, ReturnType<typeof setInterval>>()
  // Marks a session between start() and the timer actually landing in
  // `timers`, keyed to a per-attempt token: `initCursor` awaits a stat before
  // it can register anything, and without this (a) a second start() call
  // arriving in that window would race its own initCursor, doubling the
  // tail, and (b) a stop() arriving in that window would be silently undone
  // once the in-flight initCursor finished and registered anyway.
  private readonly starting = new Map<SessionId, symbol>()

  constructor(private readonly deps: FollowTailerDeps) {}

  /** Whether a session currently has an active tail, or one that is still starting up. */
  isFollowing(sessionId: SessionId): boolean {
    return this.timers.has(sessionId) || this.starting.has(sessionId)
  }

  /**
   * Start (or, if already following — or already starting — leave alone)
   * tailing a followed session from its currently known tail. Idempotent:
   * safe to call on every `history()` read while a session stays followed.
   * @param sessionId - the followed session's identity.
   * @param header - the session's persisted header, needed to locate its artifact.
   * @param baseline - the events already known (from the read that discovered the live owner); only later seqs are ever pushed.
   */
  start(sessionId: SessionId, header: SessionHeader, baseline: readonly SessionEvent[]): void {
    if (this.isFollowing(sessionId)) return
    const location = this.deps.locate(header)
    if (location === undefined) return // no per-session artifact to tail on this backend
    const token = Symbol('follow-tail-start')
    this.starting.set(sessionId, token)
    const lastSeq = baseline.at(-1)?.seq ?? -1
    void this.initCursor(sessionId, location.path, lastSeq, token)
  }

  private async initCursor(sessionId: SessionId, path: string, lastSeq: number, token: symbol): Promise<void> {
    let offset: number
    try {
      offset = (await stat(path)).size
    } catch {
      if (this.starting.get(sessionId) === token) this.starting.delete(sessionId)
      return // artifact vanished between locate() and stat(); the next followed read tries again
    }
    // A stop() (or a superseding start()) landed while the stat above was in
    // flight: this attempt is abandoned rather than resurrecting a tail the
    // caller already decided to end.
    if (this.starting.get(sessionId) !== token) return
    this.cursors.set(sessionId, { offset, lastSeq })
    const timer = setInterval(() => { void this.poll(sessionId, path) }, this.deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    timer.unref()
    this.timers.set(sessionId, timer)
    this.starting.delete(sessionId)
  }

  /** Stop tailing a session (the owner died, or this host resumed ordinary ownership). Idempotent. */
  stop(sessionId: SessionId): void {
    this.starting.delete(sessionId)
    const timer = this.timers.get(sessionId)
    if (timer === undefined) return
    clearInterval(timer)
    this.timers.delete(sessionId)
    this.cursors.delete(sessionId)
  }

  /** Stop every active tail; called at host teardown. */
  disposeAll(): void {
    for (const sessionId of [...this.timers.keys()]) this.stop(sessionId)
  }

  private async poll(sessionId: SessionId, path: string): Promise<void> {
    const cursor = this.cursors.get(sessionId)
    if (cursor === undefined) return // stopped between schedule and fire
    await this.drain(sessionId, cursor, path)
    // Re-probed AFTER draining, not before: this collects whatever the owner
    // wrote right up to releasing its lock instead of racing its last append.
    const owner = await this.deps.liveOwner(sessionId)
    if (owner === undefined) this.stop(sessionId)
  }

  private async drain(sessionId: SessionId, cursor: TailCursor, path: string): Promise<void> {
    try {
      const info = await stat(path)
      if (info.size < cursor.offset) {
        // The artifact shrank (crash repair truncated a torn tail): this
        // cursor's assumptions no longer hold. Stop; a later followed read
        // starts a fresh tail from the current size.
        this.stop(sessionId)
        return
      }
      if (info.size === cursor.offset) return
      const handle = await open(path, 'r')
      let buffer: Buffer
      try {
        buffer = Buffer.alloc(info.size - cursor.offset)
        await handle.read(buffer, 0, buffer.length, cursor.offset)
      } finally {
        await handle.close()
      }
      const { frames, tornStart } = scanZstdFrames(buffer)
      for (const range of frames) {
        try {
          const plaintext = await decompressZstdFrame(buffer.subarray(range.start, range.end))
          for (const line of plaintext.toString('utf8').split('\n')) {
            if (line.length === 0) continue
            for (const event of decodeStorageRecord(JSON.parse(line))) {
              if (event.seq <= cursor.lastSeq) continue
              cursor.lastSeq = event.seq
              this.deps.push(sessionId, event)
            }
          }
        } catch {
          // One structurally-complete-but-undecodable frame must not stop
          // the rest of this batch; the offset still advances past it below,
          // since that decision does not depend on decode success.
        }
      }
      cursor.offset += tornStart ?? buffer.length
    } catch {
      // Fails soft: a transient stat/read fault leaves the cursor where it
      // was. The file only grows, so the next tick retries the same bytes
      // plus whatever else was appended meanwhile.
    }
  }
}
