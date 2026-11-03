/**
 * Single-writer lock for one workspace store. The lock file is written as a temp file and then
 * published with `link()`, so a competitor can never observe an empty or half-written lock.
 * A lock is taken over only when its recorded pid, process start time and boot id prove the
 * holder is gone.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { link, readFile, rename, unlink } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { WORKFLOW_RUN_RECORD_VERSION } from './constants.ts'
import { WorkflowStoreError, WRITER_BUSY_REMEDY, type WriterHolder } from './errors.ts'
import { writeTempFile } from './fs-util.ts'

/** What the store needs to know about processes; injectable so tests can fake a dead holder. */
export interface ProcessProbe {
  readonly pid: number
  readonly hostname: string
  /** Kernel boot id, or null where unavailable. */
  readonly bootId: string | null
  /** Process start time token for `pid`, or null when no such process exists. */
  startTime(pid: number): string | null
}

/** Parsed content of `writer.lock`. */
interface LockFile extends WriterHolder {
  readonly v: 1
  readonly nonce: string
  readonly startTime: string | null
  readonly bootId: string | null
}

/** Token for a held writer lock. */
export interface WriterLease {
  readonly nonce: string
  readonly path: string
}

/** Details the holder publishes so a refused competitor can name it. */
export interface WriterInfo {
  readonly runId?: string
  readonly workflowName?: string
  readonly now: number
}

let cachedBootId: string | null | undefined

/**
 * Read this machine's boot id.
 * @returns The boot id, or null off Linux.
 */
export async function readBootId(): Promise<string | null> {
  if (cachedBootId !== undefined) return cachedBootId
  try {
    cachedBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null
  } catch {
    cachedBootId = null
  }
  return cachedBootId
}

/** Options for {@link createProcessProbe}. */
export interface ProbeOptions {
  /** Where the proc filesystem lives (default `/proc`); tests point it elsewhere. */
  readonly procRoot?: string
}

function fallbackAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Build a start-time reader. With a working proc filesystem it returns field 22 of
 * `/proc/<pid>/stat` and treats ENOENT as "process gone". Without one (`<procRoot>/self/stat`
 * unreadable) it can only test liveness with `kill(pid, 0)` and returns the token `unknown`.
 */
function startTimeReader(procRoot: string): (pid: number) => string | null {
  const procAvailable = existsSync(join(procRoot, 'self', 'stat'))
  return (pid) => {
    if (!procAvailable) return fallbackAlive(pid) ? 'unknown' : null
    try {
      const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return rest[19] ?? 'unknown'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return fallbackAlive(pid) ? 'unknown' : null
    }
  }
}

/**
 * Build the real process probe for the current process.
 * @param options - Optional proc filesystem location (tests only).
 * @returns A probe for this process.
 */
export async function createProcessProbe(options: ProbeOptions = {}): Promise<ProcessProbe> {
  return {
    pid: process.pid,
    hostname: osHostname(),
    bootId: await readBootId(),
    startTime: startTimeReader(options.procRoot ?? '/proc'),
  }
}

/**
 * True only when the lock's recorded pid, start time and boot id prove its holder no longer exists.
 * @param holder - Identity recorded by the lock holder.
 * @param probe - Facts about the current machine and processes.
 * @returns True when the holder is provably dead; false when alive or unprovable.
 */
export function holderIsDead(
  holder: Pick<LockFile, 'pid' | 'hostname' | 'startTime' | 'bootId'>,
  probe: ProcessProbe,
): boolean {
  if (holder.hostname !== probe.hostname) return false
  if (holder.bootId && probe.bootId && holder.bootId !== probe.bootId) return true
  const current = probe.startTime(holder.pid)
  if (current === null) return true
  if (holder.startTime && holder.startTime !== 'unknown' && current !== 'unknown' && holder.startTime !== current)
    return true
  return false
}

function parseLock(text: string): LockFile | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockFile>
    if (
      value.v === WORKFLOW_RUN_RECORD_VERSION &&
      typeof value.pid === 'number' &&
      typeof value.hostname === 'string' &&
      typeof value.nonce === 'string' &&
      typeof value.startedAt === 'number'
    )
      return value as LockFile
  } catch {
    // Unreadable content is reported as an unknown holder, never as abandoned.
  }
  return undefined
}

function busyError(holder: LockFile | undefined, lockPath: string, probe: ProcessProbe): WorkflowStoreError {
  if (!holder)
    return new WorkflowStoreError(
      'WRITER_BUSY',
      `The workflow run lock '${lockPath}' exists but its owner cannot be identified, so it was not taken over. ` +
        `If no workflow is running in this workspace (or that host is gone), delete this file '${lockPath}' and retry. ${WRITER_BUSY_REMEDY}`,
    )
  const what = holder.workflowName
    ? `workflow '${holder.workflowName}'${holder.runId ? ` (run ${holder.runId})` : ''}`
    : 'another workflow run'
  if (holder.hostname !== probe.hostname)
    return new WorkflowStoreError(
      'WRITER_BUSY',
      `The workflow run lock '${lockPath}' was written by ${what} on another host (${holder.hostname}, process ${holder.pid}), ` +
        `so it cannot be checked from here and was not taken over. If that host is gone, delete this file '${lockPath}' and retry. ` +
        WRITER_BUSY_REMEDY,
      { pid: holder.pid, hostname: holder.hostname, startedAt: holder.startedAt },
    )
  const info: WriterHolder = {
    pid: holder.pid,
    hostname: holder.hostname,
    startedAt: holder.startedAt,
    ...(holder.runId ? { runId: holder.runId } : {}),
    ...(holder.workflowName ? { workflowName: holder.workflowName } : {}),
  }
  return new WorkflowStoreError(
    'WRITER_BUSY',
    `Another run is already active in this workspace: ${what}, started ${new Date(holder.startedAt).toISOString()} ` +
      `by process ${holder.pid} on ${holder.hostname}. ${WRITER_BUSY_REMEDY}`,
    info,
  )
}

function lockContent(info: WriterInfo, probe: ProcessProbe): LockFile {
  return {
    v: WORKFLOW_RUN_RECORD_VERSION,
    nonce: randomBytes(16).toString('hex'),
    pid: probe.pid,
    hostname: probe.hostname,
    startTime: probe.startTime(probe.pid),
    bootId: probe.bootId,
    startedAt: info.now,
    ...(info.runId ? { runId: info.runId } : {}),
    ...(info.workflowName ? { workflowName: info.workflowName } : {}),
  }
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Remove a lock proven stale. Only one taker at a time may do this: they serialize on
 * `writer.lock.takeover`, itself published by temp file plus `link()` and itself taken over only
 * when its holder is provably dead. The holder re-reads and re-proves the lock dead under the mutex.
 */
async function takeOver(dir: string, lockPath: string, info: WriterInfo, probe: ProcessProbe): Promise<void> {
  const mutexPath = join(dir, 'writer.lock.takeover')
  const mine = lockContent(info, probe)
  const tmp = await writeTempFile(mutexPath, JSON.stringify(mine))
  try {
    let held = false
    for (let attempt = 0; attempt < 3 && !held; attempt++) {
      try {
        await link(tmp, mutexPath)
        held = true
      } catch (error) {
        if (!isEexist(error)) throw error
        const text = await readFile(mutexPath, 'utf8').catch((e: unknown) => {
          if (isEnoent(e)) return undefined
          throw e
        })
        if (text === undefined) continue
        const other = parseLock(text)
        // Unparsable or foreign-host mutexes cannot be proven dead: same path-and-remedy message as the lock.
        if (!other || other.hostname !== probe.hostname) throw busyError(other, mutexPath, probe)
        if (holderIsDead(other, probe)) await reclaimStale(mutexPath, text)
        else
          throw new WorkflowStoreError(
            'WRITER_BUSY',
            'Another process is replacing a stale workflow run lock in this workspace right now. Retry in a moment. ' +
              WRITER_BUSY_REMEDY,
          )
      }
    }
    if (!held) throw busyError(undefined, mutexPath, probe)
    try {
      const text = await readFile(lockPath, 'utf8').catch((e: unknown) => {
        if (isEnoent(e)) return undefined
        throw e
      })
      if (text === undefined) return
      const holder = parseLock(text)
      if (!holder || !holderIsDead(holder, probe)) throw busyError(holder, lockPath, probe)
      await unlink(lockPath).catch((e: unknown) => {
        if (!isEnoent(e)) throw e
      })
    } finally {
      const current = parseLock(await readFile(mutexPath, 'utf8').catch(() => ''))
      if (current?.nonce === mine.nonce) await unlink(mutexPath).catch(() => undefined)
    }
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

/**
 * Remove a takeover mutex proven stale by moving it aside first, then checking what was moved.
 * If it is not the stale content (a live taker just published theirs) it is discarded and the
 * caller is refused; it is never linked back.
 */
async function reclaimStale(path: string, expected: string): Promise<void> {
  const aside = `${path}.stale-${randomBytes(6).toString('hex')}`
  try {
    await rename(path, aside)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  const moved = await readFile(aside, 'utf8').catch(() => '')
  await unlink(aside).catch(() => undefined)
  if (moved !== expected)
    throw new WorkflowStoreError(
      'WRITER_BUSY',
      'Another process is replacing a stale workflow run lock in this workspace right now. Retry in a moment. ' +
        WRITER_BUSY_REMEDY,
    )
}

/**
 * Try to take the writer lock; throws `WRITER_BUSY` naming the holder when it is alive or unknown.
 * @param dir - Store directory holding `writer.lock`.
 * @param info - Run and workflow names to publish in the lock, and the current time.
 * @param probe - Facts about the current machine and processes.
 * @returns A lease proving ownership.
 * @throws WorkflowStoreError `WRITER_BUSY` when another holder is alive, unknown or on another host.
 */
export async function acquireLock(dir: string, info: WriterInfo, probe: ProcessProbe): Promise<WriterLease> {
  const path = join(dir, 'writer.lock')
  const content = lockContent(info, probe)
  const tmp = await writeTempFile(path, JSON.stringify(content))
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(tmp, path)
        if (await confirmOwner(path, content.nonce)) return { nonce: content.nonce, path }
        continue
      } catch (error) {
        if (!isEexist(error)) throw error
      }
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if (isEnoent(error)) continue
        throw error
      }
      const holder = parseLock(text)
      if (!holder || !holderIsDead(holder, probe)) throw busyError(holder, path, probe)
      await takeOver(dir, path, info, probe)
    }
    throw busyError(undefined, path, probe)
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}

async function confirmOwner(path: string, nonce: string): Promise<boolean> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return parseLock(text)?.nonce === nonce
}

/**
 * Release the lock if (and only if) this lease still owns it.
 * @param lease - The lease returned by {@link acquireLock}.
 */
export async function releaseLock(lease: WriterLease): Promise<void> {
  if (await confirmOwner(lease.path, lease.nonce)) await unlink(lease.path).catch(() => undefined)
}

/**
 * Check whether `lease` still owns the lock file (detects takeover by another process).
 * @param lease - The lease to check.
 * @returns True while the lock file still carries this lease's nonce.
 */
export function leaseStillHeld(lease: WriterLease): Promise<boolean> {
  return confirmOwner(lease.path, lease.nonce)
}
