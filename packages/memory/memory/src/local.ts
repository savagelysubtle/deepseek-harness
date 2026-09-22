/**
 * Local filesystem memory provider: plain markdown files under one storage
 * root (default `<harness home>/memory/`), one directory per project slug.
 * Humans and agents co-edit the same tree; every path is jailed before any
 * I/O and every write lands through temp-file rename so readers never see a
 * torn file. A write that would replace an existing entry retains that
 * entry's previous content first, under a bounded per-entry history that
 * stays invisible to {@link LocalMemoryProvider.list} and
 * {@link LocalMemoryProvider.search}. The whole check-retain-rename sequence
 * runs under a per-entry file lock (see {@link acquireEntryLock}), so two
 * writers racing one path are fully serialized rather than merely each
 * protecting what they individually saw — concurrent writers racing one path
 * lose the visible slot, never the content.
 * @module @deepseek-ai/dsh-memory/local
 */

import { link, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isLockHolderLive } from '@deepseek-ai/dsh-named-sessions'
import { MemoryService } from './index.ts'
import {
  MAX_ENTRY_BYTES,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  jailedScopePath,
  projectSlug,
} from './scope.ts'
import type { MemoryEntry, MemoryMatch, MemoryWriteResult } from './types.ts'

/** Config for the local provider. */
export interface Config {
  /**
   * Storage root; defaults to `memory/` under the harness home
   * (`$DSH_HOME` or `~/.dsh`). One project-slug directory per project anchor
   * (the git common directory when the cwd belongs to a repository, the cwd
   * itself otherwise).
   */
  root?: string
}

/** Resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  root: string
}

/**
 * Resolve the runtime spec from plugin config: an explicit `root` wins,
 * otherwise storage lives under the harness home.
 * @param config - raw plugin config.
 * @returns the resolved absolute storage root.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    root: config.root === undefined || config.root.trim() === ''
      ? join(resolveDshHome(), 'memory')
      : config.root,
  }
}

/** Schemastery configuration for the local provider plugin. */
export const Config: z<Config> = z.object({
  root: z.string(),
})

/** Temp-name prefix for the write critical section. */
const TEMP_PREFIX = '.memory-tmp-'

/**
 * Directory (dot-prefixed, so {@link LocalMemoryProvider.list} and
 * {@link LocalMemoryProvider.search} skip it like any other dotfile) holding
 * retained copies of entries a write has replaced, mirrored by relative path
 * under the scope root.
 */
const RETAINED_DIR = '.replaced'

/**
 * How many previous versions of one entry {@link LocalMemoryProvider.write}
 * keeps before pruning the oldest. Defends against several writers racing one
 * path within the same short window — SWD-148 was four seats writing one
 * anchor path within seconds; keeping only the single most recent version
 * would still have lost the earlier three.
 */
export const MAX_RETAINED_VERSIONS = 5

/**
 * Monotonic tiebreaker for {@link retentionTimestamp}: `Date.now()` alone
 * cannot tell two retained copies from the same millisecond apart, and a
 * wall-clock-only stamp would then order them arbitrarily instead of by the
 * write order that actually produced them — this fixed-width, ever-increasing
 * suffix keeps that order exact within this process. It says nothing about
 * order across processes, which is why {@link retentionTimestamp} also mixes
 * in this process's pid: two processes retaining in the same millisecond
 * must never compute the same filename.
 */
let retentionSequence = 0

/**
 * Filesystem-safe, lexicographically time-ordered-within-one-process stamp
 * for one retained copy's filename. No colons (Windows rejects them in file
 * names). The pid plus a short random token make the name unique across
 * processes too — every entry write is serialized through
 * {@link acquireEntryLock} before this runs, so a same-millisecond collision
 * between two *different* entries' retentions is the only realistic case,
 * but the retained-copy link refuses to land on an existing name rather than
 * trust the name alone.
 * @returns a stamp suitable for appending to a retained-copy file name.
 */
function retentionTimestamp(): string {
  retentionSequence += 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sequence = retentionSequence.toString(36).padStart(8, '0')
  const pid = process.pid.toString(36)
  const nonce = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${sequence}-${pid}-${nonce}`
}

/**
 * Directory (dot-prefixed, so {@link LocalMemoryProvider.list} and
 * {@link LocalMemoryProvider.search} skip it like `.replaced`) holding one
 * lock file per entry currently mid-write, mirrored by relative path under
 * the scope root. Local to this package on purpose: a memory entry is not a
 * named session, and this lock must never share a directory, a payload
 * shape, or a takeover policy with `dsh-named-sessions`'s own per-session
 * locks — only its holder-liveness check ({@link isLockHolderLive}) is
 * reused, not its lock storage.
 */
const LOCK_DIR = '.locks'

/**
 * Longest {@link acquireEntryLock} will wait for a live holder to release
 * before failing the write loudly. Generous next to how long one write's
 * critical section actually takes (a handful of filesystem calls), so a
 * write only ever burns this whole budget when something is genuinely
 * wedged — never silently falls through to writing anyway.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000

/** Delay between polls while {@link acquireEntryLock} waits on a live holder. */
const LOCK_POLL_INTERVAL_MS = 20

/** One entry lock's on-disk payload: enough for {@link isLockHolderLive} to judge it. */
interface EntryLockPayload {
  readonly pid: number
}

/** A held per-entry lock. */
interface EntryLock {
  /** Release the lock, but only while it still records this holder. */
  release(): Promise<void>
}

/** `setTimeout` as a promise, for {@link acquireEntryLock}'s poll loop. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Whether the lock file at `lockPath` names a holder that must still be
 * honored: read failure, unparseable content, or a pid field that is not a
 * plausible pid all read as "no provable live holder" — same fail-soft shape
 * `dsh-named-sessions` itself uses for an abandoned lock file — so a torn or
 * foreign artifact cannot wedge a write forever.
 * @param lockPath - the contended lock file.
 * @returns whether the recorded holder must be honored as live.
 */
async function entryLockHolderLive(lockPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf8')
  } catch {
    return false
  }
  let payload: { pid?: unknown }
  try {
    payload = JSON.parse(raw) as { pid?: unknown }
  } catch {
    return false
  }
  if (typeof payload.pid !== 'number' || !Number.isInteger(payload.pid) || payload.pid < 1) return false
  return isLockHolderLive({ pid: payload.pid })
}

/**
 * Take the exclusive per-entry lock guarding one write's whole
 * check-retain-rename sequence, waiting up to {@link LOCK_ACQUIRE_TIMEOUT_MS}
 * for a live holder to release before failing loud. An abandoned lock (dead
 * holder, or unreadable/foreign content) is taken over immediately, same as
 * `dsh-named-sessions`'s own steal semantics.
 * @param lockPath - absolute path of this entry's lock file.
 * @param jailed - normalized scope-relative entry path, for the timeout error.
 * @param slug - project slug, for the timeout error.
 * @returns the held lock; the caller must always release it.
 * @throws when the lock cannot be taken within the timeout, naming the entry.
 */
async function acquireEntryLock(lockPath: string, jailed: string, slug: string): Promise<EntryLock> {
  await mkdir(join(lockPath, '..'), { recursive: true })
  const payload = JSON.stringify({ pid: process.pid } satisfies EntryLockPayload)
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`memory(${slug}): could not create the write lock for "${jailed}" (${String(error instanceof Error ? error.message : error)})`)
      }
      if (!await entryLockHolderLive(lockPath)) {
        // Abandoned: no live holder to wait on. Another taker may win the
        // unlink race first, which the next loop iteration's create resolves.
        await unlink(lockPath).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`memory(${slug}): could not acquire the write lock for "${jailed}" — another process is still writing it after waiting ${LOCK_ACQUIRE_TIMEOUT_MS}ms`)
      }
      await delay(LOCK_POLL_INTERVAL_MS)
      continue
    }
    try {
      await handle.writeFile(payload, 'utf8')
    } finally {
      await handle.close()
    }
    return {
      async release(): Promise<void> {
        let current: string
        try {
          current = await readFile(lockPath, 'utf8')
        } catch (error) {
          // An already-absent artifact leaves nothing behind to clean up.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        // A taken-over lock belongs to its successor; only remove our own.
        if (current !== payload) return
        await unlink(lockPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      },
    }
  }
}

/**
 * The local provider as a Cordis service plugin: constructing it publishes
 * `ctx.memory`, mirroring the credential provider's registration shape.
 */
export class LocalMemoryProvider extends MemoryService {
  // Cordis reads this static field to validate and default a class plugin's
  // incoming config — without it, an entry with no `config:` block in
  // cordis.yml constructs with `config` as `undefined`, not `{}`.
  static Config = Config

  /** Fully resolved storage root. */
  readonly spec: ResolvedSpec

  /**
   * @param ctx - owning context; publish target for the `memory` key.
   * @param config - plugin config carrying an optional explicit root.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  private scopeDir(cwd: string): string {
    return join(this.spec.root, projectSlug(cwd))
  }

  /** @inheritdoc */
  override async read(cwd: string, path: string): Promise<string> {
    const jailed = jailedScopePath(path)
    try {
      return await readFile(join(this.scopeDir(cwd), jailed), 'utf8')
    } catch (error) {
      throw new Error(`memory(${projectSlug(cwd)}): no entry "${jailed}" — list first or write to create (${String(error instanceof Error ? error.message : error)})`)
    }
  }

  /** @inheritdoc */
  override async write(cwd: string, path: string, content: string): Promise<MemoryWriteResult> {
    const jailed = jailedScopePath(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_ENTRY_BYTES) {
      throw new Error(`memory(${projectSlug(cwd)}): entry "${jailed}" is ${bytes} bytes; the complete-entry limit is ${MAX_ENTRY_BYTES} — split it into topic files`)
    }
    const scope = this.scopeDir(cwd)
    const target = join(scope, jailed)
    const slug = projectSlug(cwd)
    await mkdir(join(target, '..'), { recursive: true })
    // The whole check-retain-rename sequence runs under this entry's lock:
    // two writers racing one path must be fully serialized, not merely each
    // protect whatever they individually saw before starting. Without this,
    // a writer that installs its content DURING another writer's retain step
    // is never itself retained by anyone (SWD-148's actual failure shape).
    const lockPath = join(scope, LOCK_DIR, `${jailed}.lock`)
    const lock = await acquireEntryLock(lockPath, jailed, slug)
    try {
      // Retaining must happen before anything below touches `target`: once
      // the temp file is renamed over it, whatever was there is gone. A
      // failure here throws and the write never proceeds — falling through
      // to the rename anyway would be exactly the silent-overwrite defect
      // this guards against.
      const replaced = await this.retainExisting(scope, jailed, target, slug)
      // Same-directory temp plus rename: co-editing readers see either the old
      // or the new file, never a partial one.
      const tmp = join(scope, jailed.split('/').slice(0, -1).join('/'), `${TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      await writeFile(tmp, content, 'utf8')
      try {
        await rename(tmp, target)
      } catch (error) {
        await writeFile(target, content, 'utf8').catch(() => {
          // Rename fallback also failed; surface the rename cause.
          throw error
        })
      }
      return replaced === undefined ? { path: jailed, bytes } : { path: jailed, bytes, replaced }
    } finally {
      await lock.release()
    }
  }

  /**
   * Preserve whatever currently lives at `target`, if anything, before a
   * write is allowed to replace it. Called only while the caller holds
   * `target`'s entry lock, so the existence check below cannot race another
   * writer. Retained copies land at
   * `<scope>/.replaced/<relative dir>/<basename>.<timestamp>`, linked aside
   * rather than copied — `link()` makes the retained path a second name for
   * the SAME inode, so the previous content is safe the instant it succeeds,
   * regardless of what happens to `target`'s own name afterward. `target` is
   * deliberately left in place here (no unlink): {@link LocalMemoryProvider.read}
   * is lock-free by design, so a name that resolved to something a moment ago must keep
   * resolving to something — old content or new — until the write below
   * renames the temp file over it; a window with no entry at all would be a
   * new, false "no entry" failure for a concurrent reader. Retained copies
   * then get pruned down to {@link MAX_RETAINED_VERSIONS} per entry, oldest
   * first.
   * @param scope - resolved scope directory for this project.
   * @param jailed - normalized scope-relative entry path.
   * @param target - absolute path of the entry the write is about to replace.
   * @param slug - project slug, for error messages.
   * @returns the replaced content's size and last-modified time, or
   *   `undefined` when `target` did not exist yet.
   */
  private async retainExisting(scope: string, jailed: string, target: string, slug: string): Promise<MemoryWriteResult['replaced']> {
    let previous: Stats
    try {
      previous = await stat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // An existing entry we cannot even stat is not safe to assume absent —
      // guessing wrong here means writing over content we never confirmed we
      // preserved.
      throw new Error(`memory(${slug}): could not check entry "${jailed}" before writing (${String(error instanceof Error ? error.message : error)})`)
    }
    const segments = jailed.split('/')
    const basename = segments.at(-1) as string
    const retainedDir = join(scope, RETAINED_DIR, segments.slice(0, -1).join('/'))
    const retainedPath = join(retainedDir, `${basename}.${retentionTimestamp()}`)
    try {
      await mkdir(retainedDir, { recursive: true })
      // Hard-link only — do NOT also unlink `target`. Linking is enough: the
      // retained path and `target` now name the same inode, so the previous
      // content is preserved the instant this call returns, no matter what
      // happens to either name afterward. Unlinking `target` here would open
      // a real window where the entry has no name at all until the rename
      // below lands the new content — and read() is intentionally lock-free
      // (see its doc), so a concurrent reader in that window would get a
      // false "no entry" error for content that still exists. Using link()
      // rather than rename() to create the retained name still matters on
      // its own: rename() would silently clobber an existing file at
      // `retainedPath`, but link() refuses with EEXIST instead of
      // overwriting one.
      await link(target, retainedPath)
    } catch (error) {
      throw new Error(`memory(${slug}): could not retain the previous "${jailed}" before replacing it — refusing to overwrite (${String(error instanceof Error ? error.message : error)})`)
    }
    await this.pruneRetained(retainedDir, basename)
    return { bytes: previous.size, modifiedAt: previous.mtime.toISOString() }
  }

  /**
   * Trim one entry's retained versions in `retainedDir` down to
   * {@link MAX_RETAINED_VERSIONS}, deleting the oldest first. Best-effort: a
   * copy that fails to delete is stale disk usage, not lost data, and must
   * never fail the write that already succeeded at the one thing that
   * matters — retaining the previous content. A failure is still surfaced
   * with a `console.warn` (not thrown) so unbounded growth from a
   * persistently undeletable directory does not go unnoticed forever.
   * @param retainedDir - the `.replaced` subdirectory holding this entry's versions.
   * @param basename - the entry's own file name (versions are `<basename>.<timestamp>`).
   */
  private async pruneRetained(retainedDir: string, basename: string): Promise<void> {
    const prefix = `${basename}.`
    let names: string[]
    try {
      names = await readdir(retainedDir)
    } catch {
      /* v8 ignore next 1 -- mkdir just created retainedDir; only a raced external removal reaches this. */
      return
    }
    const versions = names.filter(name => name.startsWith(prefix)).sort()
    const excess = versions.length - MAX_RETAINED_VERSIONS
    if (excess <= 0) return
    let failed = 0
    for (const name of versions.slice(0, excess)) {
      await unlink(join(retainedDir, name)).catch(() => {
        // Losing one old retained copy is disk hygiene, not data loss —
        // never fail the write over it.
        failed += 1
      })
    }
    if (failed > 0) {
      console.warn(`memory: failed to prune ${String(failed)} retained version(s) of "${basename}" under ${retainedDir} — history for this entry may grow unbounded`)
    }
  }

  /** @inheritdoc */
  override async list(cwd: string): Promise<MemoryEntry[]> {
    const scope = this.scopeDir(cwd)
    const entries: MemoryEntry[] = []
    const walk = async (relative: string): Promise<void> => {
      if (entries.length >= MAX_LIST_ENTRIES) return
      let dirents
      try {
        dirents = await readdir(join(scope, relative), { withFileTypes: true })
      } catch {
        // An absent scope means "no entries yet", not an error.
        return
      }
      for (const dirent of dirents) {
        if (entries.length >= MAX_LIST_ENTRIES) return
        if (dirent.name.startsWith('.') || dirent.name.startsWith(TEMP_PREFIX)) continue
        const childRelative = relative === '' ? dirent.name : `${relative}/${dirent.name}`
        if (dirent.isDirectory()) {
          await walk(childRelative)
          continue
        }
        const info = await stat(join(scope, childRelative))
        entries.push({ path: childRelative, bytes: info.size })
      }
    }
    await walk('')
    return entries.sort((a, b) => a.path.localeCompare(b.path))
  }

  /** @inheritdoc */
  override async search(cwd: string, query: string, limit?: number): Promise<MemoryMatch[]> {
    const needle = query.toLowerCase()
    if (needle === '') throw new Error('memory: search query must be non-empty')
    if (needle.length > 512) throw new Error('memory: search query exceeds 512 characters')
    const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
    const matches: MemoryMatch[] = []
    for (const entry of await this.list(cwd)) {
      if (matches.length >= effectiveLimit) break
      if (entry.bytes > MAX_ENTRY_BYTES) continue
      let text: string
      try {
        text = await readFile(join(this.scopeDir(cwd), entry.path), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length && matches.length < effectiveLimit; index++) {
        const at = lines[index]?.toLowerCase().indexOf(needle) ?? -1
        if (at === -1 || lines[index] === undefined) continue
        matches.push({
          path: entry.path,
          line: index + 1,
          excerpt: (lines[index] ?? '').trim().slice(0, 160),
        })
      }
    }
    return matches
  }
}

export default LocalMemoryProvider
