/**
 * Local filesystem memory provider: plain markdown files under one storage
 * root (default `<harness home>/memory/`), one directory per project slug.
 * Humans and agents co-edit the same tree; every path is jailed before any
 * I/O and every write lands through temp-file rename so readers never see a
 * torn file. A write that would replace an existing entry retains that
 * entry's previous content first, under a bounded per-entry history that
 * stays invisible to {@link LocalMemoryProvider.list} and
 * {@link LocalMemoryProvider.search} — concurrent writers racing one path
 * lose the visible slot, never the content.
 * @module @deepseek-ai/dsh-memory/local
 */

import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
 * suffix keeps that order exact.
 */
let retentionSequence = 0

/**
 * Filesystem-safe, lexicographically time-ordered stamp for one retained
 * copy's filename. No colons (Windows rejects them in file names); the
 * trailing sequence number guarantees a strict, call-order-correct sort even
 * when two writes land in the same millisecond.
 * @returns a stamp suitable for appending to a retained-copy file name.
 */
function retentionTimestamp(): string {
  retentionSequence += 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${retentionSequence.toString(36).padStart(8, '0')}`
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
    await mkdir(join(target, '..'), { recursive: true })
    // Retaining must happen before anything below touches `target`: once the
    // temp file is renamed over it, whatever was there is gone. A failure
    // here throws and the write never proceeds — falling through to the
    // rename anyway would be exactly the silent-overwrite defect this guards
    // against (SWD-148).
    const replaced = await this.retainExisting(cwd, scope, jailed, target)
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
  }

  /**
   * Preserve whatever currently lives at `target`, if anything, before a
   * write is allowed to replace it. Retained copies land at
   * `<scope>/.replaced/<relative dir>/<basename>.<timestamp>`, then get
   * pruned down to {@link MAX_RETAINED_VERSIONS} per entry, oldest first.
   * @param cwd - working directory; used only to name the project slug in errors.
   * @param scope - resolved scope directory for this project.
   * @param jailed - normalized scope-relative entry path.
   * @param target - absolute path of the entry the write is about to replace.
   * @returns the replaced content's size and last-modified time, or
   *   `undefined` when `target` did not exist yet.
   */
  private async retainExisting(cwd: string, scope: string, jailed: string, target: string): Promise<MemoryWriteResult['replaced']> {
    let previous: Stats
    try {
      previous = await stat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // An existing entry we cannot even stat is not safe to assume absent —
      // guessing wrong here means writing over content we never confirmed we
      // preserved.
      throw new Error(`memory(${projectSlug(cwd)}): could not check entry "${jailed}" before writing (${String(error instanceof Error ? error.message : error)})`)
    }
    const segments = jailed.split('/')
    const basename = segments.at(-1) as string
    const retainedDir = join(scope, RETAINED_DIR, segments.slice(0, -1).join('/'))
    const retainedPath = join(retainedDir, `${basename}.${retentionTimestamp()}`)
    try {
      await mkdir(retainedDir, { recursive: true })
      await copyFile(target, retainedPath)
    } catch (error) {
      throw new Error(`memory(${projectSlug(cwd)}): could not retain the previous "${jailed}" before replacing it — refusing to overwrite (${String(error instanceof Error ? error.message : error)})`)
    }
    await this.pruneRetained(retainedDir, basename)
    return { bytes: previous.size, modifiedAt: previous.mtime.toISOString() }
  }

  /**
   * Trim one entry's retained versions in `retainedDir` down to
   * {@link MAX_RETAINED_VERSIONS}, deleting the oldest first. Best-effort: a
   * copy that fails to delete is stale disk usage, not lost data, and must
   * never fail the write that already succeeded at the one thing that
   * matters — retaining the previous content.
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
    for (const name of versions.slice(0, excess)) {
      await unlink(join(retainedDir, name)).catch(() => {
        // Losing one old retained copy is disk hygiene, not data loss —
        // never fail the write over it.
      })
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
