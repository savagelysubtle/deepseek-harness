/**
 * The worktree capability seam: `ctx.worktrees` owns the provider registry,
 * slug minting, the seat-scoped registry rows, and every fence. Providers own
 * worktree mechanics; the local git provider mounts through the
 * `LocalGitWorktrees` service. Every refusal carries its reason — a lock or a
 * forbidden operation never fails silently.
 *
 * @module @deepseek-ai/dsh-worktree
 */

import { mkdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { copyListEntries, readCopyList } from './copy-list.ts'
import { WorktreeError } from './errors.ts'
import { checkEnvPresence } from './env.ts'
import type { WorktreeProvider } from './provider.ts'
import { loadRegistryFile, registryFilePath, saveRegistryFile } from './registry-file.ts'
import { mintWorktreeSlug } from './slug.ts'
import type {
  WorktreeEventPayload,
  WorktreeRow,
  WorktreeSlug,
  WorktreeSpawnRequest,
  WorktreeSpawnResult,
} from './types.ts'

export { WorktreeError } from './errors.ts'
export type { WorktreeErrorCode } from './errors.ts'
export { WORK_ENV_VAR, checkEnvPresence } from './env.ts'
export type { EnvPresence } from './env.ts'
export { WORKTREE_INCLUDE_FILENAME, parseCopyList, readCopyList, copyListEntries } from './copy-list.ts'
export { mintWorktreeSlug, parseWorktreeSlug, WORKTREE_SLUG_PATTERN_SOURCE } from './slug.ts'
export { LocalGitWorktreeProvider, LocalGitWorktrees } from './local-git.ts'
export type { WorktreeProvider } from './provider.ts'
export type {
  LocalGitWorktreeProviderOptions,
  WorktreeAddSpec,
  WorktreeEventPayload,
  WorktreeListEntry,
  WorktreeRow,
  WorktreeSlug,
  WorktreeSpawnRequest,
  WorktreeSpawnResult,
} from './types.ts'

/**
 * Session-name grammar the seat field reuses (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
 * from `@deepseek-ai/dsh-named-sessions`): filename-safe, bounded, and valid
 * inside a git branch name. Restated without a dependency, like
 * `@deepseek-ai/dsh-mailbox`'s address grammar; change both together.
 */
export const SEAT_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

const SEAT_PATTERN = new RegExp(SEAT_PATTERN_SOURCE)

/** Deployment config of the worktree service. */
export interface Config {
  /** Absolute path of the main checkout the seam branches from. */
  readonly repoRoot?: string
  /**
   * Absolute directory under which worktrees are created. Absent: the sibling
   * `<basename(repoRoot)>.worktrees` of the repo root.
   */
  readonly worktreesRoot?: string
  /** Ref new worktrees branch from when the request omits one. Default: `master`. */
  readonly mainRef?: string
  /**
   * Mirror registry rows to `<worktreesRoot>/registry.json` so the next
   * process loads them at mount. Default: false. Git's worktree state stays
   * the authority over what exists on disk; the file only remembers the
   * bookkeeping rows.
   */
  readonly persist?: boolean
}

/** Configuration after the explicit resolve step. */
export interface ResolvedConfig {
  readonly repoRoot: string
  readonly worktreesRoot: string
  readonly mainRef: string
  readonly persist: boolean
}

/**
 * Schema for {@link Config}. Structural validation runs at mount; the
 * value-level resolve (absolute paths, an existing repo root) runs in
 * {@link resolveConfig} at construction — misconfiguration fails loud at the
 * earliest resolvable point.
 */
export const Config: Schema<Config> = z.object({
  repoRoot: z.string(),
  worktreesRoot: z.string(),
  mainRef: z.string(),
  persist: z.boolean(),
})

/**
 * Resolve and validate the deployment config once at construction.
 * @param config - Schemastery-resolved plugin configuration.
 * @returns the fully resolved configuration.
 * @throws when `repoRoot` is missing, relative, or not an existing directory, when `worktreesRoot` is relative, or when `mainRef` is blank.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const repoRoot = config.repoRoot
  if (repoRoot === undefined || repoRoot.trim().length === 0) {
    throw new Error('worktree: repoRoot must be set to the absolute path of the main checkout')
  }
  if (!isAbsolute(repoRoot)) {
    throw new Error(`worktree: repoRoot must be an absolute path, saw ${JSON.stringify(repoRoot)}`)
  }
  let repoRootIsDirectory = false
  try {
    repoRootIsDirectory = statSync(repoRoot).isDirectory()
  } catch {
    repoRootIsDirectory = false
  }
  if (!repoRootIsDirectory) {
    throw new Error(`worktree: repoRoot ${JSON.stringify(repoRoot)} is not an existing directory`)
  }
  const mainRef = config.mainRef ?? 'master'
  if (mainRef.trim().length === 0) {
    throw new Error('worktree: mainRef must be a non-empty ref')
  }
  const worktreesRoot = config.worktreesRoot ?? join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`)
  if (!isAbsolute(worktreesRoot)) {
    throw new Error(`worktree: worktreesRoot must be an absolute path, saw ${JSON.stringify(worktreesRoot)}`)
  }
  return { repoRoot, worktreesRoot, mainRef, persist: config.persist ?? false }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }

  interface Events {
    /**
     * A worktree was created, locked at birth with reason `<seat> <session>`,
     * its copy-list bootstrap finished, and its registry row published.
     * @mode emit
     * @param payload - the committed row and the spawn's reason.
     */
    'worktree/spawned'(payload: WorktreeEventPayload): void
    /**
     * A worktree was locked with the carried reason.
     * @mode emit
     * @param payload - the committed row and the lock reason.
     */
    'worktree/locked'(payload: WorktreeEventPayload): void
    /**
     * A worktree's lock was removed; the committed row's `lockReason` is
     * undefined.
     * @mode emit
     * @param payload - the committed row and the unlock reason.
     */
    'worktree/unlocked'(payload: WorktreeEventPayload): void
    /**
     * A worktree was removed and its registry row deleted; the branch itself
     * survives removal.
     * @mode emit
     * @param payload - the deleted row and the removal reason.
     */
    'worktree/removed'(payload: WorktreeEventPayload): void
  }
}

/**
 * Registry over the process's worktree providers plus the fenced lifecycle
 * operations. Registering the same provider name twice fails loud; the
 * returned disposer unregisters exactly that contribution.
 */
export class WorktreeService extends Service {
  static Config: Schema<Config> = Config

  /** Resolved absolute path of the main checkout. */
  readonly repoRoot: string
  /** Resolved absolute directory worktrees are created under. */
  readonly worktreesRoot: string
  /** Resolved default ref new worktrees branch from. */
  readonly mainRef: string

  private readonly providers = new Map<string, WorktreeProvider>()
  private readonly rows = new Map<WorktreeSlug, WorktreeRow>()
  private readonly persisted: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'worktrees')
    const resolved = resolveConfig(config)
    this.repoRoot = resolved.repoRoot
    this.worktreesRoot = resolved.worktreesRoot
    this.mainRef = resolved.mainRef
    this.persisted = resolved.persist
    if (resolved.persist) {
      mkdirSync(resolved.worktreesRoot, { recursive: true })
      for (const row of loadRegistryFile(registryFilePath(resolved.worktreesRoot))) {
        this.rows.set(row.slug, row)
      }
    }
    ctx.effect(() => () => { this.flushPersist() }, 'worktree teardown')
  }

  /**
   * Register one worktree provider under its own name.
   * @param provider - the provider implementation to admit.
   * @returns the disposer that unregisters this provider; fiber disposal triggers it.
   * @throws WorktreeError with code `DUPLICATE_PROVIDER` when a live provider already holds the name.
   */
  registerProvider(provider: WorktreeProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new WorktreeError(`worktree provider "${provider.name}" is already registered`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(provider.name, provider)
    return () => {
      // Only the winning registration may remove its name; a disposer whose
      // provider was replaced by a re-registration leaves the successor alone.
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name)
    }
  }

  /**
   * Look up one registered provider by exact name.
   * @param name - the provider's registry name.
   * @returns the provider, or undefined when the name is not live.
   */
  getProvider(name: string): WorktreeProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * Enumerate the live provider names in registration order.
   * @returns fresh provider names.
   */
  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Spawn one seat-scoped worktree: verify the working environment, mint the
   * slug, refuse the states force would paper over, create the worktree
   * locked, run the copy-list bootstrap, and publish the row. No mutation
   * happens before every check passes; a bootstrap failure rolls the
   * worktree back before the error surfaces.
   * @param request - seat, intent, and optional main ref.
   * @param providerName - provider to use; omitted resolves the single registered provider and refuses ambiguity.
   * @returns the published spawn result.
   */
  async spawn(request: WorktreeSpawnRequest, providerName?: string): Promise<WorktreeSpawnResult> {
    const provider = this.resolveProvider(providerName)
    this.validateRequest(request)
    const presence = checkEnvPresence()
    if (!presence.present) {
      throw new WorktreeError(
        `work session requires ${presence.missing.join(', ')} in the environment; set it before spawning a worktree`,
        'ENV_MISSING',
      )
    }
    const slug = mintWorktreeSlug()
    const branch = `${request.seat}/${slug}`
    const session = `${request.seat}.${slug}`
    const path = join(this.worktreesRoot, `${request.seat}-${slug}`)
    const branchRef = request.mainRef ?? this.mainRef
    const lockReason = `${request.seat} ${session}`
    // The two states `git worktree add -f` would paper over are refused here,
    // loudly, instead of ever passing force to the provider.
    if (await provider.pathExists(path)) {
      throw new WorktreeError(
        `worktree path ${JSON.stringify(path)} already exists; force-reusing it (` +
        'git worktree add -f) is forbidden — remove the stale worktree first',
        'PATH_EXISTS',
      )
    }
    if (await provider.branchExists(branch)) {
      throw new WorktreeError(
        `branch ${JSON.stringify(branch)} already exists; branch reuse is forbidden — ` +
        'each spawn mints a fresh slug and branches from it',
        'BRANCH_EXISTS',
      )
    }
    mkdirSync(this.worktreesRoot, { recursive: true })
    await provider.add({ path, branch, mainRef: branchRef, lockReason })
    let copied: readonly string[]
    try {
      copied = copyListEntries(this.repoRoot, path, readCopyList(this.repoRoot))
    } catch (error: unknown) {
      // The worktree exists but its bootstrap failed; spawn is atomic, so
      // roll the half-built worktree back (unlock first — it was born locked)
      // and surface the bootstrap failure.
      let rollbackFailure: unknown
      try {
        await provider.unlock(path)
        await provider.remove(path)
      } catch (rollbackError: unknown) {
        rollbackFailure = rollbackError
      }
      if (rollbackFailure !== undefined) {
        throw new AggregateError([error, rollbackFailure], 'worktree bootstrap and its rollback both failed')
      }
      throw error
    }
    const row: WorktreeRow = {
      slug,
      seat: request.seat,
      branch,
      session,
      path,
      branchRef,
      createdAt: Date.now(),
      lockReason,
      lastReason: request.intent,
    }
    this.rows.set(slug, row)
    this.flushPersist()
    this.ctx.emit('worktree/spawned', { row, reason: request.intent })
    return { slug, seat: request.seat, branch, session, path, branchRef, lockReason, copied }
  }

  /**
   * Enumerate the live registry rows in spawn order — one row per live branch.
   * @returns fresh row snapshots.
   */
  list(): readonly WorktreeRow[] {
    return [...this.rows.values()]
  }

  /**
   * Look up one registry row by slug.
   * @param slug - the seam-minted slug.
   * @returns the row, or undefined when no live branch carries it.
   */
  row(slug: WorktreeSlug): WorktreeRow | undefined {
    return this.rows.get(slug)
  }

  /**
   * Lock an unlocked worktree with a reason.
   * @param slug - the worktree's slug.
   * @param reason - why the worktree is being locked; carried on the row, the git lock, and the event.
   * @param providerName - provider to use; same resolution as {@link spawn}.
   * @returns the committed row.
   */
  async lock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow> {
    const row = this.expectRow(slug)
    this.expectReason(reason, 'lock')
    if (row.lockReason !== undefined) {
      throw new WorktreeError(
        `worktree ${slug} is already locked (reason: ${JSON.stringify(row.lockReason)}); ` +
        'unlock with a reason before locking again',
        'ALREADY_LOCKED',
      )
    }
    const provider = this.resolveProvider(providerName)
    await provider.lock(row.path, reason)
    return this.commitRow(row, reason, reason, 'worktree/locked', reason)
  }

  /**
   * Remove an existing lock, recording why.
   * @param slug - the worktree's slug.
   * @param reason - why the fence is coming down; carried on the row and the event.
   * @param providerName - provider to use; same resolution as {@link spawn}.
   * @returns the committed row.
   */
  async unlock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow> {
    const row = this.expectRow(slug)
    this.expectReason(reason, 'unlock')
    if (row.lockReason === undefined) {
      throw new WorktreeError(`worktree ${slug} is not locked; nothing to unlock`, 'NOT_LOCKED')
    }
    const provider = this.resolveProvider(providerName)
    await provider.unlock(row.path)
    return this.commitRow(row, undefined, reason, 'worktree/unlocked', reason)
  }

  /**
   * Remove an unlocked worktree and delete its row. A locked worktree refuses
   * with its lock reason — the caller must unlock with a reason first. The
   * branch itself survives removal; reusing its name stays forbidden.
   * @param slug - the worktree's slug.
   * @param reason - why the worktree is being removed; carried on the event.
   * @param providerName - provider to use; same resolution as {@link spawn}.
   */
  async remove(slug: WorktreeSlug, reason: string, providerName?: string): Promise<void> {
    const row = this.expectRow(slug)
    this.expectReason(reason, 'remove')
    if (row.lockReason !== undefined) {
      throw new WorktreeError(
        `worktree ${slug} is locked (reason: ${JSON.stringify(row.lockReason)}); ` +
        'unlock with a reason before removing',
        'LOCKED',
      )
    }
    const provider = this.resolveProvider(providerName)
    await provider.remove(row.path)
    this.rows.delete(slug)
    this.flushPersist()
    this.ctx.emit('worktree/removed', { row, reason })
  }

  /**
   * Persist the registry mirror when this instance mounts with persistence
   * on; a no-op otherwise.
   */
  private flushPersist(): void {
    if (!this.persisted) return
    saveRegistryFile(registryFilePath(this.worktreesRoot), this.list())
  }

  /**
   * Resolve the operation's provider, failing loud with the reason.
   * @param providerName - explicit provider name, or undefined for single-provider resolution.
   * @returns the resolved provider.
   */
  private resolveProvider(providerName?: string): WorktreeProvider {
    if (providerName !== undefined) {
      const provider = this.providers.get(providerName)
      if (provider === undefined) {
        throw new WorktreeError(`no worktree provider registered under ${JSON.stringify(providerName)}`, 'NO_PROVIDER')
      }
      return provider
    }
    const [single] = this.providers.values()
    if (this.providers.size === 1 && single !== undefined) return single
    if (this.providers.size === 0) {
      throw new WorktreeError(
        'no worktree provider is registered; mount LocalGitWorktrees or pass a provider name',
        'NO_PROVIDER',
      )
    }
    const names = [...this.providers.keys()]
    throw new WorktreeError(
      `${names.length} worktree providers are registered (${names.join(', ')}); pass a provider name explicitly`,
      'NO_PROVIDER',
    )
  }

  /**
   * Validate the caller-supplied spawn fields in the admitting operation.
   * @param request - the raw spawn request.
   */
  private validateRequest(request: WorktreeSpawnRequest): void {
    if (!SEAT_PATTERN.test(request.seat)) {
      throw new WorktreeError(
        `invalid seat ${JSON.stringify(request.seat)}: must match ${SEAT_PATTERN_SOURCE}`,
        'SEAT_INVALID',
      )
    }
    if (request.intent.trim().length === 0) {
      throw new WorktreeError('spawn intent must be a non-empty description of the work', 'INTENT_INVALID')
    }
  }

  /**
   * Look up a live row or fail loud.
   * @param slug - the requested slug.
   * @returns the live row.
   */
  private expectRow(slug: WorktreeSlug): WorktreeRow {
    const row = this.rows.get(slug)
    if (row === undefined) {
      throw new WorktreeError(`no live worktree carries slug ${JSON.stringify(slug)}`, 'NO_ROW')
    }
    return row
  }

  /**
   * Require a non-empty operation reason; a refusal without a stated reason
   * would be exactly the silent fence this seam forbids.
   * @param reason - the caller's reason.
   * @param operation - operation name, for the error message.
   */
  private expectReason(reason: string, operation: string): void {
    if (reason.trim().length === 0) {
      throw new WorktreeError(`worktree ${operation} requires a non-empty reason`, 'REASON_INVALID')
    }
  }

  /**
   * Commit a row mutation after the provider operation succeeded, then
   * persist and publish the event at the commit point.
   * @param row - the row before the mutation.
   * @param lockReason - the new lock reason, or undefined to clear it.
   * @param lastReason - the mutation's reason, recorded on the row.
   * @param event - the event key matching the mutation.
   * @param reason - the mutation's reason, carried on the event payload.
   * @returns the committed row.
   */
  private commitRow(
    row: WorktreeRow,
    lockReason: string | undefined,
    lastReason: string,
    event: 'worktree/locked' | 'worktree/unlocked',
    reason: string,
  ): WorktreeRow {
    const committed: WorktreeRow = lockReason === undefined
      ? { ...omitLockReason(row), lastReason }
      : { ...row, lockReason, lastReason }
    this.rows.set(row.slug, committed)
    this.flushPersist()
    this.ctx.emit(event, { row: committed, reason })
    return committed
  }
}

/**
 * Rebuild a row without its lock field — the unlock commit state.
 * @param row - the row to strip.
 * @returns the row without `lockReason`.
 */
function omitLockReason(row: WorktreeRow): Omit<WorktreeRow, 'lockReason'> {
  const { lockReason: _stripped, ...rest } = row
  return rest
}

export { WorktreeService as default }
