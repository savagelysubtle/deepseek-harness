/**
 * Host-side check of the one path the model chooses: the optional `cwd` argument of a call. Everything else
 * about the clone (its `.git` shape, hard links, the provisioned `node_modules` cache directories, free space)
 * is checked by the profile builder, which refuses with a typed code. This module only decides which
 * directory inside the clone the command starts in, and refuses anything that could leave it.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/provision-check
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** The outcome of resolving the `cwd` argument. */
export type WorkdirResult =
  | { readonly ok: true; readonly workdir: string }
  | { readonly ok: false; readonly reason: string }

/** Filesystem reads of the check; tests inject failures the host cannot produce. */
export interface WorkdirFs {
  /** Canonical path; throws an errno error when the path does not exist. */
  realpath(path: string): string
  /** Whether the path is a directory (symlinks followed). */
  isDirectory(path: string): boolean
}

const realFs: WorkdirFs = {
  realpath: path => realpathSync(path),
  isDirectory: path => statSync(path).isDirectory(),
}

/** `inner` equals or lies inside `outer` (both canonical absolute paths). */
function inside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve the directory a command starts in.
 * @param clone - the seat's canonical working directory (the clone root, pinned by the policy provider).
 * @param requested - the model's `cwd` argument, when it gave one.
 * @param fs - filesystem reads (default the real one).
 * @returns the canonical directory (symlinks inside the clone are resolved here, so the profile builder never sees one),
 *   or the reason the argument was refused: not absolute, starts with `-`, holds a NUL or newline, does not exist, is
 *   not a directory, or resolves outside the clone.
 */
export function resolveWorkdir(clone: string, requested: string | undefined, fs: WorkdirFs = realFs): WorkdirResult {
  if (requested === undefined) return { ok: true, workdir: clone }
  if (requested.startsWith('-')) return { ok: false, reason: 'cwd must be an absolute path and may not start with "-"' }
  if (!isAbsolute(requested) || /[\0\n]/u.test(requested)) {
    return { ok: false, reason: 'cwd must be an absolute path without NUL or newline characters' }
  }
  let real: string
  let directory: boolean
  try {
    real = fs.realpath(requested)
    directory = fs.isDirectory(real)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: `cwd ${requested} does not exist` }
    return { ok: false, reason: `cwd ${requested} cannot be resolved (${code ?? 'unknown error'})` }
  }
  if (!inside(clone, real)) return { ok: false, reason: `cwd ${requested} resolves outside the working directory ${clone}` }
  if (!directory) return { ok: false, reason: `cwd ${requested} is not a directory` }
  return { ok: true, workdir: real }
}
