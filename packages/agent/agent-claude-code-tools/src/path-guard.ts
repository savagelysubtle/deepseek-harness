/**
 * Realpath-based path confinement. A candidate path is judged by where it really lands (symlinks
 * resolved, a not-yet-existing tail attached to its nearest existing ancestor), never by its
 * spelling, and compared to the allowed roots by whole path segments (`/a/b` is not inside `/a/bb`).
 * Guard-reachable: node builtins only, erasable TypeScript only.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/path-guard
 */

import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Characters that would be read as pattern syntax (or break a rule string) inside a permission rule. */
const UNSAFE_PATH_CHARS = /[*?[\]!#{}\\()\s\u0000-\u0008\u000e-\u001f\u007f]/

/** Characters that start a glob segment. */
const GLOB_CHARS = /[*?[\]{}!()]/

/** A group opener, separator or `~` that makes the next character start a new path inside a brace or extglob group. */
const GROUP_ESCAPE = /[{(,|][/~]/

/** Thrown when a directory cannot be used safely inside a generated permission rule. */
export class UnsafePathError extends Error {
  /** What was refused (for example `cwd` or `home`). */
  readonly subject: string
  /** The offending path. */
  readonly path: string

  /**
   * @param subject - what was refused.
   * @param path - the offending path.
   * @param reason - why.
   */
  constructor(subject: string, path: string, reason: string) {
    super(`${subject} ${JSON.stringify(path)} refused: ${reason}`)
    this.name = 'UnsafePathError'
    this.subject = subject
    this.path = path
  }
}

/** The outcome of one guard check. A pass carries no decision text: the hook only ever denies. */
export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/** The confinement the guard enforces; a view of the policy file. */
export interface GuardScope {
  /** The seat's working directory (a realpath); relative candidates resolve against it. */
  readonly cwd: string
  /** Roots a candidate must sit inside. */
  readonly allowedRoots: readonly string[]
  /** Prefixes a candidate may never sit inside. */
  readonly deniedPrefixes: readonly string[]
}

const PASS: Verdict = { ok: true }

function deny(reason: string): Verdict {
  return { ok: false, reason }
}

/**
 * Whether `target` is `root` or lies below it, compared by whole segments.
 * @param root - absolute directory.
 * @param target - absolute path.
 * @returns true when inside.
 */
export function isInside(root: string, target: string): boolean {
  return root === sep || target === root || target.startsWith(root + sep)
}

/**
 * Validate a directory that will be written into a permission rule: absolute, canonical (equal to
 * its own realpath, so no symlinks, `..` or trailing slash), a directory, not the filesystem root,
 * and free of glob metacharacters, parentheses, whitespace and control characters.
 * @param subject - label for the error (`cwd`, `home`).
 * @param path - the directory.
 * @returns the same path.
 * @throws {UnsafePathError} on any violation.
 */
export function assertCanonicalDir(subject: string, path: string): string {
  const refuse = (reason: string): never => {
    throw new UnsafePathError(subject, path, reason)
  }
  if (!isAbsolute(path) || resolve(path) !== path) refuse('it must be an absolute, normalised path')
  if (path === sep) refuse('the filesystem root is too broad')
  if (UNSAFE_PATH_CHARS.test(path)) refuse('it contains a glob metacharacter, parenthesis, whitespace or control character')
  let real = ''
  try {
    real = realpathSync(path)
  } catch {
    refuse('it cannot be resolved')
  }
  if (real !== path) refuse(`it is not canonical (its realpath is ${real})`)
  if (!statSync(path).isDirectory()) refuse('it is not a directory')
  return path
}

/** Realpath of `abs`, or of its nearest existing ancestor with the missing tail re-attached. */
function realOrAncestor(abs: string): { readonly real: string } | { readonly deny: string } {
  const tail: string[] = []
  for (let current = abs; ; current = dirname(current)) {
    try {
      return { real: join(realpathSync(current), ...[...tail].reverse()) }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { deny: `cannot resolve the path (${String(code)})` }
    }
    try {
      lstatSync(current)
      return { deny: 'the path is a dangling symlink' }
    } catch {
      // genuinely absent: move up and re-attach the name
    }
    tail.push(basename(current))
  }
}

/** Realpath of an existing directory or file, or undefined when it does not exist. */
function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Judge one path-valued tool argument.
 * Denies: empty or NUL-bearing values, a leading `~`, any `..` segment, a destination (after symlink
 * resolution) outside every allowed root, inside a denied prefix, or an existing regular file with
 * more than one hard link.
 * @param scope - the confinement.
 * @param candidate - the argument as the model wrote it (relative to `scope.cwd` or absolute).
 * @returns pass, or a deny with a one-line reason.
 */
export function checkPath(scope: GuardScope, candidate: string): Verdict {
  if (candidate === '') return deny('empty path')
  if (candidate.includes('\0')) return deny('path contains a NUL byte')
  if (candidate.startsWith('~')) return deny('path starts with ~')
  if (candidate.split('/').includes('..')) return deny('path contains a .. segment')
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(scope.cwd, candidate)
  const resolved = realOrAncestor(abs)
  if ('deny' in resolved) return deny(resolved.deny)
  const { real } = resolved
  if (!scope.allowedRoots.some((root) => {
    const realRoot = realOrUndefined(root)
    return realRoot !== undefined && isInside(realRoot, real)
  })) return deny(`path resolves outside the allowed roots (${real})`)
  for (const prefix of scope.deniedPrefixes) {
    const realPrefix = realOrUndefined(prefix)
    if (isInside(prefix, abs) || isInside(prefix, real) || (realPrefix !== undefined && isInside(realPrefix, real))) {
      return deny(`path is inside the protected location ${prefix}`)
    }
  }
  try {
    const stat = lstatSync(real)
    if (stat.isFile() && stat.nlink > 1) return deny('target is a hard-linked file')
  } catch {
    // a new file: nothing to inspect
  }
  return PASS
}

/**
 * Judge one glob-valued argument (the Glob `pattern`, the Grep `glob`). The pattern may not contain
 * `..` anywhere (a brace group could hide one), a leading `~` is refused, and the static directory
 * prefix (every segment before the first glob character) must itself pass {@link checkPath}.
 * @param scope - the confinement.
 * @param pattern - the glob as written.
 * @returns pass, or a deny with a one-line reason.
 */
export function checkGlob(scope: GuardScope, pattern: string): Verdict {
  if (pattern === '') return deny('empty glob')
  if (pattern.includes('\0')) return deny('glob contains a NUL byte')
  if (pattern.startsWith('~')) return deny('glob starts with ~')
  if (pattern.includes('..')) return deny('glob contains ..')
  if (GROUP_ESCAPE.test(pattern)) return deny('glob alternatives may not start a new path')
  if (hasSlashInsideGroup(pattern)) return deny('glob groups may not contain a path separator')
  return checkPath(scope, globStaticPrefix(pattern))
}

/** Whether a `/` appears between an opening `{` or `(` and its matching close (nesting counted). */
function hasSlashInsideGroup(pattern: string): boolean {
  let depth = 0
  for (const char of pattern) {
    if (char === '{' || char === '(') depth += 1
    else if ((char === '}' || char === ')') && depth > 0) depth -= 1
    else if (char === '/' && depth > 0) return true
  }
  return false
}

/**
 * The fixed directory part of a glob: every segment before the first one with a glob character
 * (`.` for a relative glob that starts with one, `/` for an absolute one).
 * @param pattern - the glob as written.
 * @returns the static prefix, relative or absolute as written.
 */
export function globStaticPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const firstGlob = segments.findIndex(segment => GLOB_CHARS.test(segment))
  const fixed = (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/')
  return isAbsolute(pattern) ? (fixed === '' ? sep : fixed) : (fixed === '' ? '.' : fixed)
}

/**
 * Whether searching `dir` recursively would reach a protected location that exists: the directory
 * (after symlink resolution) is, or lies above, an existing denied prefix.
 * @param scope - the confinement.
 * @param dir - the effective search directory (absolute, or relative to the cwd).
 * @returns the protected prefix it would reach, or undefined.
 */
export function reachesProtected(scope: GuardScope, dir: string): string | undefined {
  const resolved = realOrAncestor(isAbsolute(dir) ? resolve(dir) : resolve(scope.cwd, dir))
  if ('deny' in resolved) return undefined
  return scope.deniedPrefixes.find((prefix) => {
    const realPrefix = realOrUndefined(prefix)
    return realPrefix !== undefined && (isInside(resolved.real, prefix) || isInside(resolved.real, realPrefix))
  })
}

/**
 * Refuse a working directory on a case-insensitive filesystem: if a protected entry exists under
 * the cwd and its upper-case spelling resolves too, the deny rules (matched case-sensitively) and
 * the real files disagree.
 * @param cwd - the canonical cwd.
 * @param names - protected entry names relative to the cwd.
 * @param lstat - lstat implementation (replaceable for tests).
 * @throws {UnsafePathError} when an entry answers to its upper-case name.
 */
export function assertCaseSensitiveEntries(cwd: string, names: readonly string[], lstat: (path: string) => unknown = lstatSync): void {
  for (const name of names) {
    try {
      lstat(join(cwd, name))
    } catch {
      continue
    }
    try {
      lstat(join(cwd, name.toUpperCase()))
    } catch {
      continue
    }
    throw new UnsafePathError('cwd', cwd, `case-insensitive filesystem: ${name} also answers to ${name.toUpperCase()}, so deny rules would not match; use a case-sensitive filesystem`)
  }
}
