/**
 * Host-state ledger of the Claude Code child process each seat owns, so a
 * host that crashed or was killed can reap the orphan at its next start.
 * An entry is only acted on when the process start time still matches, which
 * keeps a recycled pid from ever being killed.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/ledger
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One recorded child: the seat, its process-group leader pid, and that pid's start time. */
export interface LedgerEntry {
  readonly seat: string
  readonly pid: number
  /** `/proc/<pid>/stat` start time (clock ticks since boot); empty when it could not be read. */
  readonly startTime: string
}

/** Outcome of one {@link ProcessLedger.reapStale} pass. */
export interface ReapReport {
  /** Seats whose recorded child was still alive with a matching start time and was killed. */
  readonly reaped: readonly string[]
  /** Seats whose recorded child was gone or had a different start time (nothing was killed). */
  readonly stale: readonly string[]
}

/** Process facts the ledger needs; injectable so tests never touch real processes. */
export interface LedgerProcessOps {
  /** Start time of a live pid, or `undefined` when the pid is gone or unreadable. */
  readStartTime(pid: number): string | undefined
  /** Kill the whole process group led by `pid`. */
  killGroup(pid: number): void
}

/**
 * Read the start time of a Linux process from `/proc/<pid>/stat` (field 22).
 * @param pid - the process id.
 * @returns the start time in clock ticks since boot as a string, or `undefined`.
 */
export function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name (field 2) may contain spaces and parentheses; split after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19]
  } catch {
    return undefined
  }
}

/**
 * Kill a process group, tolerating one that is already gone.
 * @param pid - the group leader pid (the child is spawned as its own group).
 */
export function killProcessGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** The real process operations. */
export const SYSTEM_PROCESS_OPS: LedgerProcessOps = {
  readStartTime: readProcessStartTime,
  killGroup: killProcessGroup,
}

/** JSON file of live children keyed by seat, written atomically. */
export class ProcessLedger {
  /**
   * @param file - absolute path of the ledger file; its directory is created on first write.
   * @param ops - process operations; defaults to the real ones.
   */
  constructor(
    private readonly file: string,
    private readonly ops: LedgerProcessOps = SYSTEM_PROCESS_OPS,
  ) {}

  /**
   * Read all entries; a missing file is empty and a corrupt file is an error.
   * @returns the recorded child entries.
   */
  entries(): LedgerEntry[] {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error(`agent-claude-code-driver: process ledger ${this.file} is not a list`)
    return parsed.filter((entry): entry is LedgerEntry =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as LedgerEntry).seat === 'string'
      && Number.isInteger((entry as LedgerEntry).pid)
      && typeof (entry as LedgerEntry).startTime === 'string')
  }

  private write(entries: readonly LedgerEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }

  /**
   * Record the child a seat just started, replacing any earlier entry of that seat.
   * @param seat - seat key.
   * @param pid - process-group leader pid.
   */
  record(seat: string, pid: number): void {
    const startTime = this.ops.readStartTime(pid) ?? ''
    this.write([...this.entries().filter(entry => entry.seat !== seat), { seat, pid, startTime }])
  }

  /**
   * Forget a seat's child once it has exited, but only if the entry still names `pid`.
   * @param seat - seat key.
   * @param pid - the pid that exited.
   */
  clear(seat: string, pid: number): void {
    const kept = this.entries().filter(entry => !(entry.seat === seat && entry.pid === pid))
    this.write(kept)
  }

  /**
   * At host start: kill every recorded child that is still alive with a
   * matching start time, then empty the ledger. An entry with an unknown
   * start time is never killed (the match cannot be proven).
   * @returns which seats were reaped and which entries were stale.
   */
  reapStale(): ReapReport {
    const reaped: string[] = []
    const stale: string[] = []
    for (const entry of this.entries()) {
      const current = this.ops.readStartTime(entry.pid)
      if (current !== undefined && entry.startTime !== '' && current === entry.startTime) {
        this.ops.killGroup(entry.pid)
        reaped.push(entry.seat)
      } else {
        stale.push(entry.seat)
      }
    }
    this.write([])
    return { reaped, stale }
  }
}
