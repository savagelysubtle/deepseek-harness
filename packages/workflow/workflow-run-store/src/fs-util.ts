/** Small filesystem helpers: private directories, atomic writes, strict ids. */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { WorkflowStoreError } from './errors.ts'

/** Directory mode: owner only. */
export const DIR_MODE = 0o700
/** File mode: owner only. */
export const FILE_MODE = 0o600

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const NODE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/

/**
 * Validate a run id (also used as a directory name).
 * @param runId - Candidate run id.
 * @throws WorkflowStoreError `INVALID_ID` when the id is not allowed.
 */
export function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId))
    throw new WorkflowStoreError('INVALID_ID', `Run id '${runId}' is not allowed: use 1-64 letters, digits, '_' or '-'.`)
}

/**
 * Validate a node id (also used as a spill file stem).
 * @param nodeId - Candidate node id.
 * @throws WorkflowStoreError `INVALID_ID` when the id is not allowed.
 */
export function assertNodeId(nodeId: string): void {
  if (!NODE_ID_RE.test(nodeId) || nodeId.includes('..'))
    throw new WorkflowStoreError('INVALID_ID', `Node id '${nodeId}' is not allowed: use 1-64 letters, digits, '_', '-' or '.', without '..'.`)
}

/**
 * Join `segments` under `base` and refuse any result that escapes it.
 * @param base - Directory the result must stay inside.
 * @param segments - Path segments to append.
 * @returns The resolved absolute path.
 * @throws WorkflowStoreError `INVALID_ID` when the path escapes `base`.
 */
export function joinUnder(base: string, ...segments: string[]): string {
  const root = resolve(base)
  const full = resolve(root, ...segments)
  if (full !== root && !full.startsWith(root + sep))
    throw new WorkflowStoreError('INVALID_ID', 'Path escapes the run directory.')
  return full
}

/**
 * Create `dir` (and parents) and force mode 0700 on `dir` itself, whatever the umask or prior mode.
 * @param dir - Directory to create or tighten.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
}

/** Best-effort fsync of a directory so a rename/link survives power loss. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unsupported on some filesystems; the file itself is already synced.
  }
}

/**
 * Write `data` to a fresh temp file beside `path` (mode 0600, fsynced).
 * @param path - Final destination; the temp file is created in its directory.
 * @param data - Content to write.
 * @returns The temp file path; the caller must publish or remove it.
 */
export async function writeTempFile(path: string, data: string | Uint8Array): Promise<string> {
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE)
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(tmp).catch(() => undefined) // never leave a partial temp file behind (disk full)
    throw error
  }
  return tmp
}

/**
 * Atomically publish `data` at `path`. A crash leaves the old file, no file, or the complete new file, never a torn one.
 * With `createIfAbsent` an existing file wins (temp file then `link()`); otherwise the file is replaced via `rename()`.
 * @param path - Destination file.
 * @param data - Content to write.
 * @param options - `createIfAbsent` keeps an existing file instead of replacing it.
 * @returns True when the file was published, false when `createIfAbsent` found one already there.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { createIfAbsent?: boolean } = {},
): Promise<boolean> {
  const tmp = await writeTempFile(path, data)
  try {
    if (options.createIfAbsent) {
      try {
        await link(tmp, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    } else {
      await rename(tmp, path)
    }
    await syncDir(dirname(path))
    return true
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}
