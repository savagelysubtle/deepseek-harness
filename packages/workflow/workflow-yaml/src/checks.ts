/**
 * Pure text checks the compiler applies statically: the model denylist, workspace-confined
 * relative paths, and the environment-variable denylist. Runtime enforcement (catalog-resolved
 * model ids, symlink-aware path containment) belongs to the host; these checks reject the
 * obvious shapes at validation time. The model check is a cost guard, not a security boundary.
 * @module @deepseek-ai/dsh-workflow-yaml/checks
 */

/** A rejection reason, or `undefined` when the value is acceptable. */
export type CheckResult = string | undefined

/**
 * Fold a model id to a comparable form: NFKC, strip invisible format characters (zero-width and
 * friends), lowercase.
 * @param value - model id as written
 * @returns the NFKC-folded, invisible-character-free, lowercase text
 */
export function normalizeModelText(value: string): string {
  return value.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
}

/**
 * Reject any model id naming Fable in any spelling: case, full-width and other NFKC variants,
 * zero-width padding, `provider/` and `provider:` prefixes, path forms, date or version
 * suffixes, and separator-split spellings such as `f-a-b-l-e`.
 * @returns the rejection reason, or `undefined` when the id passes the static check
 * @param value - model id as written
 */
export function checkModelId(value: string): CheckResult {
  const folded = normalizeModelText(value)
  const squashed = folded.replace(/[^a-z0-9]/g, '')
  if (folded.includes('fable') || squashed.includes('fable')) {
    return `model "${value}" resolves to a denied model family (Fable is not allowed in workflows)`
  }
  return undefined
}

/**
 * Check every value of a tier-to-model table. Returns one reason per rejected tier.
 * @param table - tier name to model id
 * @returns the rejection reason for each denied tier
 */
export function checkTierTable(table: Record<string, string>): Record<string, string> {
  const rejected: Record<string, string> = {}
  for (const [tier, model] of Object.entries(table)) {
    const reason = checkModelId(model)
    if (reason !== undefined) rejected[tier] = reason
  }
  return rejected
}

/**
 * Reject a path that could leave the workspace: empty, NUL, absolute (POSIX, Windows drive, UNC,
 * home-relative), backslashes, or any `..` segment. Symlink escapes are the host's runtime check.
 * @param value - path as written in the workflow
 * @returns a rejection reason, or undefined when the path is acceptable
 */
export function checkRelativePath(value: string): CheckResult {
  if (value.length === 0) return 'path must not be empty'
  if (value.includes('\0')) return 'path must not contain a NUL byte'
  if (value.length > 512) return 'path is longer than 512 characters'
  if (value.includes('\\')) return 'path must use forward slashes only (no backslashes)'
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return 'path must be relative to the workspace, not absolute'
  if (value.startsWith('~')) return 'path must be relative to the workspace, not home-relative'
  if (value.split('/').includes('..')) return 'path must not contain ".." segments'
  return undefined
}

/** Environment variables a workflow may never set (compared upper-cased). */
const ENV_DENIED_EXACT = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'IFS', 'BASH_ENV', 'ENV', 'SHELLOPTS',
  'BASHOPTS', 'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE', 'NODE_OPTIONS',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5LIB',
  'PERL5OPT', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS',
  'EDITOR', 'PAGER', 'BROWSER', 'VISUAL', 'LESSOPEN', 'LESSCLOSE',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'CLASSPATH', 'GOFLAGS', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'ZDOTDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
])
const ENV_DENIED_PREFIX = ['LD_', 'DYLD_', 'GIT_', 'DSH_', 'WF_', 'BASH_FUNC_', 'NPM_CONFIG_', 'SSH_', 'GPG_', 'SSL_CERT_', 'CURL_CA_']

/**
 * Names a workflow may set on a command: identifier-shaped and not on the denylist.
 * @param name - environment variable name
 * @returns a rejection reason, or undefined when the name is allowed
 */
export function checkEnvName(name: string): CheckResult {
  if (name.startsWith('__') || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    return `environment variable name "${name}" must match [A-Za-z_][A-Za-z0-9_]{0,63}`
  }
  const upper = name.toUpperCase()
  const denied = ENV_DENIED_EXACT.has(upper) || ENV_DENIED_PREFIX.some(prefix => upper.startsWith(prefix)) || upper.endsWith('_PROXY')
  if (denied) {
    return `environment variable "${name}" is not allowed in a workflow (it can change how commands are found or loaded; `
      + 'WF_ names are reserved for node outputs)'
  }
  return undefined
}
