/**
 * Per-seat host state the driver keeps in its private state directory for
 * registry-sourced seats: the first-seen session id of each seat (so a registry
 * writer cannot hand a seat a fresh log), and the call-window history (so the
 * window survives a session-id change and a host restart).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/seat-state
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertPrivateFile, currentUid, writeAtomic } from './state.ts'

/** File name of the per-seat session pins, inside the driver's state directory. */
export const SEAT_SESSIONS_FILE_NAME = 'claude-code-seat-sessions.json'

/** File name of the per-seat call-window history, inside the driver's state directory. */
export const CALL_WINDOW_FILE_NAME = 'claude-code-call-windows.json'

/**
 * Read a private JSON object file of the state directory.
 * @param file - absolute path; a missing file reads as empty.
 * @param what - what the file holds, for the error text.
 * @param uid - expected owner; defaults to the running user.
 * @returns the parsed object, or an empty one when the file is absent.
 * @throws when the file is not private, or is not a JSON object.
 */
function readPrivateObject(file: string, what: string, uid: number | undefined): Record<string, unknown> {
  assertPrivateFile(file, uid)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`agent-claude-code-driver: ${what} file ${file} is unreadable (${(error as Error).message}); fix or delete it after checking the seats, then restart`)
  }
}

/** The verdict of {@link SeatSessionPins.enforce}. */
export type SessionPinOutcome = 'pinned' | 'same' | 'reseeded'

/** First-seen dsh session id per seat. A change is refused unless the founder authorised it in host config. */
export class SeatSessionPins {
  private readonly file: string
  private pins: Record<string, string>

  /**
   * @param stateDir - the private state directory.
   * @param uid - expected owner of the pin file; defaults to the running user.
   */
  constructor(stateDir: string, uid: number | undefined = currentUid()) {
    this.file = join(stateDir, SEAT_SESSIONS_FILE_NAME)
    this.pins = Object.fromEntries(
      Object.entries(readPrivateObject(this.file, 'seat session pin', uid)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  }

  /**
   * Pin the first-seen session id of a seat, or check a later one against it.
   * @param seat - seat key.
   * @param sessionId - the session id being created or resumed for the seat.
   * @param authorised - the host entry's `session_id`, the founder's reseed authorisation.
   * @returns `pinned` (first sight), `same`, or `reseeded` (a different id the founder authorised; re-pinned).
   * @throws when the session id differs from the pin and is not the authorised one.
   */
  enforce(seat: string, sessionId: string, authorised: string | undefined): SessionPinOutcome {
    const pinned = this.pins[seat]
    if (pinned === sessionId) return 'same'
    if (pinned !== undefined && authorised !== sessionId) {
      throw new Error(
        `agent-claude-code-driver: seat-session-changed: seat "${seat}" session id changed without a host-config session_id; ask the founder to reseed`,
      )
    }
    const next = { ...this.pins, [seat]: sessionId }
    writeAtomic(this.file, `${JSON.stringify(next)}\n`)
    this.pins = next
    return pinned === undefined ? 'pinned' : 'reseeded'
  }
}

/** The persistence a {@link SeatGate} uses for its call history. */
export interface CallWindowPersistence {
  /** The saved call times of a seat, or `undefined` when none were ever saved. */
  load(seat: string): readonly number[] | undefined
  /** Save the call times of a seat. */
  save(seat: string, times: readonly number[]): void
}

/**
 * Call-window history per seat on disk, so a session-id change (a reseed) and
 * a host restart cannot reset a seat's window. A write that fails is reported
 * through `warn` and the in-memory count carries on.
 */
export class CallWindowStore implements CallWindowPersistence {
  private readonly file: string
  private calls: Record<string, number[]>

  /**
   * @param stateDir - the private state directory.
   * @param warn - sink for write failures.
   * @param uid - expected owner of the file; defaults to the running user.
   */
  constructor(stateDir: string, private readonly warn: (message: string) => void, uid: number | undefined = currentUid()) {
    this.file = join(stateDir, CALL_WINDOW_FILE_NAME)
    this.calls = Object.fromEntries(
      Object.entries(readPrivateObject(this.file, 'call-window', uid)).filter((entry): entry is [string, number[]] =>
        Array.isArray(entry[1]) && entry[1].every(value => typeof value === 'number' && Number.isFinite(value))),
    )
  }

  load(seat: string): readonly number[] | undefined {
    return this.calls[seat]
  }

  save(seat: string, times: readonly number[]): void {
    this.calls = { ...this.calls, [seat]: [...times] }
    try {
      writeAtomic(this.file, `${JSON.stringify(this.calls)}\n`)
    } catch (error: unknown) {
      this.warn(`agent-claude-code-driver: could not persist the call window of seat "${seat}" (${(error as Error).message}); the count is kept in memory only`)
    }
  }
}
