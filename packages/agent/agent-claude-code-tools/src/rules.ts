/**
 * Generated permission rules. Claude Code path rules are gitignore-style: `//abs` is an absolute
 * path, `/abs` is project-relative. Only `Read(...)` and `Edit(...)` are real path specifiers (Read
 * covers Grep and Glob; Edit covers Write, MultiEdit and NotebookEdit), so no `Write(...)` or
 * `Grep(...)` rule is ever emitted.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/rules
 */

import { join } from 'node:path'
import type { PolicyRole } from './contributors.ts'
import { assertCanonicalDir, assertCaseSensitiveEntries, isInside, UnsafePathError } from './path-guard.ts'

/** Home-relative locations a seat may never read or write. Directories end in `/**` in rules. */
const HOME_DENIED: readonly { readonly rel: string; readonly dir: boolean }[] = [
  { rel: '.claude', dir: true },
  { rel: '.claude.json', dir: false },
  { rel: '.ssh', dir: true },
  { rel: '.config/gh', dir: true },
  { rel: '.dsh', dir: true },
  { rel: '.agents', dir: true },
]

/** Locations inside the working directory a seat may never read or write. */
const CWD_DENIED: readonly { readonly rel: string; readonly dir: boolean }[] = [
  { rel: '.git', dir: true },
  { rel: '.claude', dir: true },
  { rel: '.mcp.json', dir: false },
  { rel: '.husky', dir: true },
]

/** The generated rules for one seat. */
export interface GeneratedRules {
  /** `permissions.deny` entries (role-independent). */
  readonly deny: string[]
  /** `permissions.allow` entries for native file tools (coder only). */
  readonly allow: string[]
  /** Absolute prefixes the hook must always refuse. */
  readonly deniedPrefixes: string[]
  /** Absolute roots the hook lets file tools touch. */
  readonly allowedRoots: string[]
}

/**
 * One rule string for an absolute path.
 * @param tool - `Read` or `Edit`.
 * @param abs - absolute path.
 * @param dir - whether to cover everything below it.
 * @returns the entries for the path: for a directory both the bare path (a worktree `.git` is a file) and `/**`;
 *   the `//` prefix replaces the path's leading slash, for example `Read(//home/me/.ssh)` and `Read(//home/me/.ssh/**)`.
 */
function rule(tool: 'Read' | 'Edit', abs: string, dir: boolean): string[] {
  const bare = `${tool}(/${abs})`
  return dir ? [bare, `${tool}(/${abs}/**)`] : [bare]
}

/**
 * Generate the deny and allow rules for a seat.
 * @param role - `lead` gets the deny set only; `coder` also gets Read/Edit limited to the cwd.
 * @param cwd - the seat's working directory; must be canonical and free of pattern characters.
 * @param home - the operator's home directory; same requirement.
 * @returns the rules plus the matching absolute prefixes and roots for the policy file.
 * @throws {UnsafePathError} when `cwd` or `home` is unusable in a rule, the cwd is the home directory or sits inside a
 *   protected home location, or the cwd is on a case-insensitive filesystem.
 */
export function generateRules(role: PolicyRole, cwd: string, home: string): GeneratedRules {
  assertCanonicalDir('cwd', cwd)
  assertCanonicalDir('home', home)
  if (cwd === home) throw new UnsafePathError('cwd', cwd, 'it is the home directory itself; start the seat in a project directory below it')
  assertCaseSensitiveEntries(cwd, CWD_DENIED.map(entry => entry.rel))
  const deniedPrefixes: string[] = []
  const deny: string[] = []
  const entries = [
    ...HOME_DENIED.map(entry => ({ abs: join(home, entry.rel), dir: entry.dir })),
    ...CWD_DENIED.map(entry => ({ abs: join(cwd, entry.rel), dir: entry.dir })),
  ]
  for (const entry of entries) {
    if (isInside(entry.abs, cwd)) throw new UnsafePathError('cwd', cwd, `it sits inside the protected location ${entry.abs}; start the seat in a project directory elsewhere`)
    deniedPrefixes.push(entry.abs)
    deny.push(...rule('Read', entry.abs, entry.dir), ...rule('Edit', entry.abs, entry.dir))
  }
  const coder = role === 'coder'
  return {
    deny,
    allow: coder ? [`Read(/${cwd}/**)`, `Edit(/${cwd}/**)`] : [],
    deniedPrefixes,
    allowedRoots: coder ? [cwd] : [],
  }
}
