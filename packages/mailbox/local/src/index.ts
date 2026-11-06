/**
 * The local mailbox provider plugin: one SQLite file hosts every address's
 * queue, mounted as provider `local` on `ctx.mailbox`. The service resolves
 * its config once at construction, opens the store loud (a foreign or
 * newer-versioned database fails the mount), and closes the database when the
 * owning fiber disposes.
 *
 * @module @deepseek-ai/dsh-mailbox-local
 */

import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { defaultDshHome, dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { openMailboxDatabase, SqliteMailboxStore } from './sqlite.ts'

export { PROVIDER_NAME, SCHEMA_VERSION, SqliteMailboxStore, openMailboxDatabase } from './sqlite.ts'
export type { MailboxClock, MessageRow } from './types.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). Missing directories and databases
   * are created owner-only; existing file modes are preserved. Absent:
   * `<dsh home>/mailbox/mailbox.db`.
   */
  readonly path?: string
}

/** Schema for {@link Config}. A blank path fails here rather than at open. */
export const Config: Schema<Config> = z.object({
  path: z.string().min(1),
})

/**
 * Explicit config resolution for the database location: the single place a
 * configured path becomes a concrete one.
 * @param configured - the raw config value.
 * @returns the absolute database path, the harness-home default, or the
 *   untouched `:memory:` sentinel.
 * @throws when the configured path is blank (schema admits the empty check late).
 */
export function resolveMailboxPath(configured?: string): string {
  if (configured === undefined) return dshHomePath('mailbox', 'mailbox.db')
  const trimmed = configured.trim()
  if (trimmed.length === 0) throw new Error('mailbox-local path must be a non-empty filesystem path')
  // The sentinel stays unresolved: resolving it would name a literal file,
  // while SQLite reads bare `:memory:` as the in-process database.
  return trimmed === ':memory:' ? ':memory:' : resolve(trimmed)
}

/** Inputs of {@link shouldWarnLiveMailbox}. */
export interface LiveMailboxGuardInput {
  /** The resolved database path the mount is about to open. */
  readonly resolvedPath: string
  /** The REAL operating-system-derived harness home (`~/.dsh`), never `DSH_HOME`. */
  readonly home: string
  /** Raw `DSH_ORG_REGISTRY` value, if any. */
  readonly registryEnv: string | undefined
}

/** Outcome of {@link shouldWarnLiveMailbox}. */
export interface LiveMailboxGuardResult {
  readonly warn: boolean
  readonly message: string
}

/**
 * Decide whether a mount would pair the LIVE mailbox database with a
 * throwaway org registry (the mix that put test mail into the live queue).
 * Warns only when the resolved path is `<home>/mailbox/mailbox.db`, the
 * registry env is set, and it names a file other than `<home>/org/registry.yml`.
 * Never throws: any failure inside the check yields "no warning".
 * @param input - resolved path, real home, and raw registry env.
 * @returns whether to warn, and the message naming both paths.
 */
export function shouldWarnLiveMailbox(input: LiveMailboxGuardInput): LiveMailboxGuardResult {
  const none: LiveMailboxGuardResult = { warn: false, message: '' }
  try {
    const registryRaw = input.registryEnv?.trim()
    if (registryRaw === undefined || registryRaw.length === 0) return none
    const livePath = resolve(input.home, 'mailbox', 'mailbox.db')
    const liveRegistry = resolve(input.home, 'org', 'registry.yml')
    const registry = resolve(expandHomePath(registryRaw))
    if (input.resolvedPath === ':memory:' || resolve(input.resolvedPath) !== livePath) return none
    if (registry === liveRegistry) return none
    return {
      warn: true,
      message:
        `mailbox-local is opening the LIVE mailbox database ${livePath} while DSH_ORG_REGISTRY points at ${registry}, `
        + `not the live registry ${liveRegistry}; test mail would land in the live queue. `
        + 'To use a throwaway mailbox, set the mailbox-local config path (or DSH_HOME) to a temp directory, '
        + 'or unset DSH_ORG_REGISTRY.',
    }
  } catch {
    return none
  }
}

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files keep their modes; errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity against another principal replacing the directory entry.
 * @param path - the database file to reserve.
 */
function createDatabaseFile(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open one mailbox database for writing, establishing the owner-only file
 * mode when this caller is the first writer: the missing directory is created
 * `0o700`, a missing file reserved `0o600`. The shared sequence for every
 * writer of this store — plugin mount and `dsh-mailbox` CLI alike — so an
 * out-of-harness first write never falls back to the ambient umask.
 * @param path - resolved database path (`:memory:` skips filesystem setup).
 * @returns the open handle from {@link openMailboxDatabase}.
 */
export function openLocalMailbox(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    createDatabaseFile(path)
  }
  return openMailboxDatabase(path)
}

/**
 * Mount the SQLite store as mailbox provider {@link PROVIDER_NAME}. Load via
 * the Loader (`inject: ['mailbox']`) or construct directly in tests; either
 * way the provider unregisters and the database closes on fiber disposal.
 */
export class MailboxLocal extends Service {
  /** The registry this provider mounts onto. */
  static inject = ['mailbox']

  static Config: Schema<Config> = Config

  private readonly store: SqliteMailboxStore

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mailboxLocal')
    const path = resolveMailboxPath(config.path)
    // Advisory only: warn about live-mailbox + throwaway-registry, never refuse or throw.
    try {
      const guard = shouldWarnLiveMailbox({
        resolvedPath: path,
        home: defaultDshHome(),
        registryEnv: process.env.DSH_ORG_REGISTRY,
      })
      if (guard.warn) ctx.logger.warn(guard.message)
    } catch {
      // The guard must never alter mount behavior.
    }
    // Synchronous open: a foreign or incompatible database rejects the mount
    // itself, leaving nothing half-registered behind.
    this.store = new SqliteMailboxStore(openLocalMailbox(path))
    ctx.effect(() => {
      const dispose = ctx.mailbox.registerProvider(this.store)
      return () => {
        dispose()
        this.store.close()
      }
    }, 'mailbox-local.registerProvider')
  }
}

export default MailboxLocal
