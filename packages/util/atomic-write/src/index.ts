/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, flushes it to disk, then renames it over the
 * target and flushes the containing directory too, so readers observe either
 * the old or the new complete content, a replaced file ends up with exactly
 * the stated mode, and an unclean shutdown right after a reported success
 * cannot leave the target present but empty or truncated. `withFileLock`
 * serializes cross-process writers of one file through a `wx`-created
 * `<file>.lock` sibling, so a read-modify-write cycle can never resurrect a
 * state another writer just replaced; readers stay lock-free because the
 * rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Error codes meaning "this platform or filesystem cannot fsync a directory
 * at all", not a real I/O fault: Windows and FreeBSD do not support flushing
 * a directory handle (commonly surfaced as `EPERM`/`ENOSYS`/`ENOTSUP`), and
 * some POSIX layers refuse it outright — a read-only lower layer under an
 * overlay filesystem (as Docker's overlay2 storage driver produces) reports
 * `EINVAL` for a directory fsync it cannot honor. None of these mean the
 * write failed; they mean this one durability step cannot be performed here.
 */
const DIRECTORY_FLUSH_UNSUPPORTED_CODES = new Set(['ENOSYS', 'EINVAL', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'])

function isDirectoryFlushUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code !== undefined && DIRECTORY_FLUSH_UNSUPPORTED_CODES.has(code)
}

/**
 * Flush a directory's own metadata — the rename that just landed inside it —
 * to disk, so the rename survives an unclean shutdown as durably as the file
 * content does. Best-effort: when the platform or filesystem cannot fsync a
 * directory at all, that is not a write failure (see
 * {@link DIRECTORY_FLUSH_UNSUPPORTED_CODES}) and is swallowed after the
 * handle is closed. Any other failure (permission revoked mid-write, disk
 * full, a hardware fault) is a real fault and is rethrown rather than
 * silently discarded.
 * @param directory - the directory whose entries were just changed by a rename.
 */
async function flushDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!isDirectoryFlushUnsupported(error)) throw error
  } finally {
    await handle?.close()
  }
}

/**
 * Replace `filename` with `content` in one atomic, crash-durable step,
 * creating parent directories. The content is first written to a
 * random-suffix sibling opened with exclusive create (`wx`): the open
 * refuses to follow a symlink planted at the temp path, and the fresh inode
 * carries `options.mode` through the rename, so replacing a
 * wider-permission file narrows it without a chmod race. That temp file is
 * flushed to disk and closed before the rename, the rename replaces a
 * symlinked target itself instead of writing through to its referent, the
 * same-directory sibling keeps the rename on one filesystem, and the
 * containing directory is flushed after the rename so the rename itself
 * survives an unclean shutdown too (best-effort where the platform cannot
 * fsync a directory at all — see {@link flushDirectory}). On any failure
 * before the rename commits, the temp file is removed and the original
 * failure is rethrown — a cleanup failure during that removal is never
 * allowed to replace the real error the caller needs to see.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  const directory = dirname(filename)
  await mkdir(directory, {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): preserve owner-only permissions on
  // Windows (POSIX mode bits are inert there); see fs-local's win32.ts DACL
  // handling for a reference approach. Out of scope here.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, 'wx', options.mode)
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, filename)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    // Best-effort only: if `rm` itself throws, that failure must never
    // replace `error` in what the caller sees. A leftover `.tmp` file is a
    // nuisance; a swallowed real failure is the exact defect this helper
    // exists to remove.
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  await flushDirectory(directory)
}

/** Whether an exclusive create failed because the path already exists. */
function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Writer-lock protocol constants. These are robustness invariants of the
 * cross-process write protocol, not deployment tunables: contention normally
 * resolves within the retry deadline, while expiry fails the contender without
 * guessing whether the existing lock still has an owner.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_TIMEOUT_MS = 2_000

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. Contention backs off exponentially and fails with a
 * timed-out error after the deadline. The contender never removes an existing
 * lock because file age cannot prove that its owner stopped; orphan recovery
 * is an operator action. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!isEEXIST(error)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
