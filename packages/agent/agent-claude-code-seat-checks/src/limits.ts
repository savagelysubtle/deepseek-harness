/**
 * Constants of the seat checks: contributor ids, the clone-state limits, the scrubbed environment
 * git runs
 * under and the entries a coder clone must not carry. Nothing here depends on the host; the values
 * the
 * operator may change live in the plugin config.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/limits
 */

/** Prefix of every log line and note this package writes. */
export const LOG_PREFIX = 'agent-claude-code-seat-checks:'

/** Readiness contributor id of the guard boot canary; it provides the `canary` requirement. */
export const CANARY_ID = 'guard-boot-canary'

/** Default timeout of the guard boot canary, in milliseconds. */
export const DEFAULT_CANARY_TIMEOUT_MS = 20_000

/** Where git is looked for when the config names no path. */
export const GIT_CANDIDATES: readonly string[] = ['/usr/bin/git', '/usr/local/bin/git']

/**
 * Largest `.git/config` the check reads, in bytes. A bigger file could bury a key past a truncated
 * read.
 */
export const MAX_CONFIG_BYTES = 64 * 1024

/** Longest a `git config` run may take, in milliseconds. */
export const GIT_TIMEOUT_MS = 5000

/**
 * Largest `git config` output accepted, in bytes (four times the largest config; git re-prints each
 * value once).
 */
export const GIT_MAX_OUTPUT = 4 * MAX_CONFIG_BYTES

/** The environment `git config` runs under: nothing inherited, no system or global config. */
export const SCRUBBED_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  LC_ALL: 'C',
})

/**
 * Entries below `.git` that must not exist in a coder clone (each one redirects or adds
 * host-executable state).
 */
export const FORBIDDEN_GIT_ENTRIES: readonly string[] = [
  'commondir',
  'gitdir',
  'dsh-hooks',
  'config.worktree',
  'worktrees',
  'objects/info/alternates',
  'objects/info/http-alternates',
]

/** The only file names allowed in `.git/hooks`. */
export const HOOK_SAMPLE_SUFFIX = '.sample'

/**
 * The scrub commands, appended to every refusal. A clone that install-lefthook touched needs
 * `.git/dsh-hooks`,
 * `.git/config.worktree` and the keys `core.hooksPath`, `extensions.worktreeConfig` and
 * `merge.dsh-translation-pairing.driver` removed.
 */
export const SCRUB_REMEDY =
  'Remedy, run outside any seat: remove the named path with `rm -rf <path>`, '
  + 'or remove the named key with '
  + '`GIT_CONFIG_NOSYSTEM=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null '
  + 'config --file <clone>/.git/config --unset-all <key>`; '
  + 'for hooks run `find <clone>/.git/hooks -type f ! -name "*.sample" -delete`; '
  + 'or provision a fresh clone with '
  + '`pnpm install --offline --ignore-scripts --config.package-import-method=copy`'
