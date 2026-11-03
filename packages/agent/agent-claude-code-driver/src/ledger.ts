/**
 * Host-state ledger of the Claude Code child processes each seat owns, so a
 * host that crashed or was killed can reap the orphans at its next start.
 * An entry is only acted on when the boot id and the process start time still
 * match (a recycled pid is never killed) and the host that wrote it is gone
 * (another live host's children are never killed).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/ledger
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertPrivateFile, currentUid, ensurePrivateDir, writeAtomic } from './state.ts'

/** One recorded child and the host that owns it. */
export interface LedgerEntry {
  readonly seat: string
  readonly pid: number
  /** `/proc/<pid>/stat` start time (clock ticks since boot); empty when it could not be read. */
  readonly startTime: string
  /** Pid of the host process that spawned the child. */
  readonly hostPid: number
  /** Start time of that host process; empty when it could not be read. */
  readonly hostStartTime: string
  /** `/proc/sys/kernel/random/boot_id` when the entry was written; empty when unavailable. */
  readonly bootId: string
}

/** Outcome of one {@link ProcessLedger.reapStale} pass. */
export interface ReapReport {
  /** Seats whose recorded child was still alive with a matching start time and was killed. */
  readonly reaped: readonly string[]
  /** Seats whose recorded child was gone (or from an earlier boot); nothing was killed. */
  readonly stale: readonly string[]
  /** Seats whose owning host is still alive; left alone and kept in the ledger. */
  readonly skipped: readonly string[]
  /** Seats whose leader is gone but whose process group still has members. They are NOT killed (ownership cannot be proven). */
  readonly survivors: readonly string[]
  /** Seats whose kill failed (for example EPERM); the rest of the pass continued. */
  readonly failed: readonly string[]
}

/** Process facts the ledger needs; injectable so tests never touch real processes. */
export interface LedgerProcessOps {
  /** Start time of a live pid, or `undefined` when the pid is gone or unreadable. */
  readStartTime(pid: number): string | undefined
  /** Kill the whole process group led by `pid`. */
  killGroup(pid: number): void
  /** Whether any member of the process group led by `pid` is still alive. */
  groupAlive(pid: number): boolean
  /** The kernel boot id, or an empty string when unavailable. */
  bootId(): string
  /** This host process's pid. */
  readonly hostPid: number
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
 * Read the kernel boot id.
 * @param file - the boot id file; defaults to `/proc/sys/kernel/random/boot_id`.
 * @returns the id, or an empty string when it cannot be read.
 */
export function readBootId(file = '/proc/sys/kernel/random/boot_id'): string {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
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

/**
 * Whether a process group still has members, probed with signal 0.
 * @param pid - the group leader pid.
 * @returns true when the group exists (including when it exists but may not be signalled).
 */
export function isGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The real process operations. */
export const SYSTEM_PROCESS_OPS: LedgerProcessOps = {
  readStartTime: readProcessStartTime,
  killGroup: killProcessGroup,
  groupAlive: isGroupAlive,
  bootId: () => readBootId(),
  hostPid: process.pid,
}

/** Whether a parsed JSON value is a complete ledger entry. */
function isEntry(entry: unknown): entry is LedgerEntry {
  if (typeof entry !== 'object' || entry === null) return false
  const row = entry as Record<string, unknown>
  return typeof row['seat'] === 'string'
    && Number.isInteger(row['pid'])
    && typeof row['startTime'] === 'string'
    && Number.isInteger(row['hostPid'])
    && typeof row['hostStartTime'] === 'string'
    && typeof row['bootId'] === 'string'
}

/** JSON file of live children, kept in a private directory and written atomically. */
export class ProcessLedger {
  /**
   * @param file - absolute path of the ledger file; its directory is created (mode 0700) on first write.
   * @param ops - process operations; defaults to the real ones.
   * @param uid - expected owner of the directory and file; defaults to the running user.
   */
  constructor(
    private readonly file: string,
    private readonly ops: LedgerProcessOps = SYSTEM_PROCESS_OPS,
    private readonly uid: number | undefined = currentUid(),
  ) {}

  /**
   * Read all entries; a missing file is empty. A file that is not ours, not
   * private, or not a valid list is an error naming the path and the remedy.
   * @returns the recorded child entries.
   */
  entries(): LedgerEntry[] {
    assertPrivateFile(this.file, this.uid)
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `agent-claude-code-driver: process ledger ${this.file} is corrupt (not a JSON list). `
        + 'Check that no Claude Code child of this host is still running (pgrep -f claude), then delete the file and restart.',
      )
    }
    return parsed.filter(isEntry)
  }

  private write(entries: readonly LedgerEntry[]): void {
    ensurePrivateDir(dirname(this.file), this.uid)
    writeAtomic(this.file, `${JSON.stringify(entries)}\n`)
  }

  /**
   * Record a child a seat just started. A seat may have several entries; only
   * an earlier entry for the same pid is replaced.
   * @param seat - seat key.
   * @param pid - process-group leader pid.
   */
  record(seat: string, pid: number): void {
    const { ops } = this
    const entry: LedgerEntry = {
      seat,
      pid,
      startTime: ops.readStartTime(pid) ?? '',
      hostPid: ops.hostPid,
      hostStartTime: ops.readStartTime(ops.hostPid) ?? '',
      bootId: ops.bootId(),
    }
    this.write([...this.entries().filter(known => !(known.seat === seat && known.pid === pid)), entry])
  }

  /**
   * Forget a seat's child once it has exited, but only the entry naming `pid`.
   * @param seat - seat key.
   * @param pid - the pid that exited.
   */
  clear(seat: string, pid: number): void {
    this.write(this.entries().filter(entry => !(entry.seat === seat && entry.pid === pid)))
  }

  /**
   * At host start: kill every recorded child that is still alive with a
   * matching start time, then drop the handled entries. Never acted on: an
   * entry from an earlier boot (pid and start tick prove nothing), an entry
   * whose owning host is still alive (another live host's child), an entry
   * with an unknown start time, or a dead leader whose group still has
   * members (reported, not killed). One failing kill does not stop the pass.
   * Entries of live owners, failed kills and surviving groups stay in the file so
   * the next start looks at them again.
   * @returns which seats were reaped, stale, skipped, left with survivors, or failed.
   */
  reapStale(): ReapReport {
    const { ops } = this
    const report: Record<keyof ReapReport, string[]> = { reaped: [], stale: [], skipped: [], survivors: [], failed: [] }
    const keep: LedgerEntry[] = []
    const boot = ops.bootId()
    for (const entry of this.entries()) {
      if (entry.bootId !== boot) {
        report.stale.push(entry.seat)
        continue
      }
      const ownerAlive = entry.hostPid !== ops.hostPid && entry.hostStartTime !== '' && ops.readStartTime(entry.hostPid) === entry.hostStartTime
      if (ownerAlive) {
        report.skipped.push(entry.seat)
        keep.push(entry)
        continue
      }
      const current = ops.readStartTime(entry.pid)
      if (current !== undefined && entry.startTime !== '' && current === entry.startTime) {
        try {
          ops.killGroup(entry.pid)
          report.reaped.push(entry.seat)
        } catch {
          report.failed.push(entry.seat)
          keep.push(entry)
        }
      } else if (current === undefined && ops.groupAlive(entry.pid)) {
        report.survivors.push(entry.seat)
        keep.push(entry)
      } else {
        report.stale.push(entry.seat)
      }
    }
    this.write(keep)
    return report
  }
}
