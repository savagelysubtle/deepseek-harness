/**
 * Local filesystem memory provider: plain markdown files under one storage
 * root (default `<harness home>/memory/`), one directory per project slug.
 * Humans and agents co-edit the same tree; every path is jailed before any
 * I/O and every write lands through temp-file rename so readers never see a
 * torn file.
 * @module @deepseek-ai/dsh-memory/local
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
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
   * (`$DSH_HOME` or `~/.dsh`). One project-slug directory per workspace cwd.
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
    return { path: jailed, bytes }
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
