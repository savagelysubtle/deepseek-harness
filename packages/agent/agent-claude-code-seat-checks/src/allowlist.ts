/**
 * The allowlist applied to what `git config --list -z` printed for a clone. Git parses the file; this module only
 * judges already-normalised keys and values. Anything not listed is refused with its key named, because a key
 * outside the list can make a later host-side git command run code (`core.hooksPath`, `core.fsmonitor`, `filter.*`,
 * `remote.*.uploadpack`, `credential.helper`, `include.path`, and so on).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/allowlist
 */

/** One record of `git config --list -z`: the key and, unless the key was a bare boolean, its value. */
export interface ConfigRecord {
  /** The key as git printed it. */
  readonly key: string
  /** The value, or `undefined` for a key written without `=` (git reads it as true). */
  readonly value: string | undefined
}

/** Why a record was refused: `config-key` (the key is not listed) or `config-value` (the key is listed but the value is not). */
export interface AllowlistViolation {
  /** Machine-readable code. */
  readonly code: 'config-key' | 'config-value'
  /** The key involved. */
  readonly key: string
  /** What is wrong, without the remedy. */
  readonly reason: string
}

const PLAIN_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'user.name',
  'user.email',
  'init.defaultbranch',
])

const FALSE_VALUES: ReadonlySet<string> = new Set(['false', 'no', 'off', '0', ''])
const CONTROL = /[\u0000-\u001f\u007f]/u
const WEB_URL = /^(?:https|ssh):\/\/(?:[A-Za-z0-9][A-Za-z0-9._~%+-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?(?:\/[^\s]*)?$/u
const SCP_URL = /^(?:[A-Za-z0-9][A-Za-z0-9._~%+-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*:(?!\/\/)[^\s:][^\s]*$/u
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const REMOTE_KEY = /^remote\.(.+)\.(url|fetch)$/u
const BRANCH_KEY = /^branch\.(.+)\.(remote|merge)$/u

function violation(code: AllowlistViolation['code'], key: string, reason: string): AllowlistViolation {
  return { code, key, reason }
}

function remoteUrlProblem(value: string): string | undefined {
  if (value.includes('::')) return 'a value containing `::` selects a remote helper that runs a program'
  if (CONTROL.test(value)) return 'the value holds a control character'
  if (value.startsWith('/')) return undefined
  if (WEB_URL.test(value) || SCP_URL.test(value)) return undefined
  return 'the url must be an absolute local path, an https:// or ssh:// url, or an scp-style host:path'
}

/**
 * Judge the records of one clone's config.
 * @param records - the parsed `git config --list -z` output.
 * @returns the first violation, or `undefined` when every record is allowed.
 */
export function checkConfigRecords(records: readonly ConfigRecord[]): AllowlistViolation | undefined {
  for (const record of records) {
    const key = record.key.toLowerCase()
    if (key === 'core.bare') {
      if (record.value === undefined || !FALSE_VALUES.has(record.value.toLowerCase())) {
        return violation('config-value', record.key, 'core.bare must be false in a working clone')
      }
      continue
    }
    if (PLAIN_KEYS.has(key)) continue
    if (REMOTE_KEY.test(key)) {
      const kind = (REMOTE_KEY.exec(key) as RegExpExecArray)[2]
      if (record.value === undefined) return violation('config-value', record.key, 'the key has no value')
      if (kind === 'url') {
        const problem = remoteUrlProblem(record.value)
        if (problem !== undefined) return violation('config-value', record.key, problem)
      } else if (CONTROL.test(record.value)) {
        return violation('config-value', record.key, 'the value holds a control character')
      }
      continue
    }
    if (BRANCH_KEY.test(key)) {
      const kind = (BRANCH_KEY.exec(key) as RegExpExecArray)[2]
      if (record.value === undefined) return violation('config-value', record.key, 'the key has no value')
      if (kind === 'remote' && !PLAIN_NAME.test(record.value)) {
        return violation('config-value', record.key, 'branch.<name>.remote must be a plain remote name')
      }
      if (kind === 'merge' && CONTROL.test(record.value)) return violation('config-value', record.key, 'the value holds a control character')
      continue
    }
    return violation('config-key', record.key, 'the key is not on the allowlist for a coder clone')
  }
  return undefined
}
