/** Project-scope slug derivation: the namespace key is the project anchor's hash. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import { afterEach, describe, expect, it } from 'vitest'
import { projectSlug } from '../src/scope.ts'

/**
 * Marker filename that makes a directory its own anchor root (see
 * `ANCHOR_MARKER_FILENAME` in `@deepseek-ai/dsh-named-sessions`'s
 * `src/anchor.ts`). Duplicated here as a literal, matching this file's
 * existing practice of duplicating small fixture helpers rather than
 * importing another package's internals; content is never read, so an
 * empty file is enough to plant one.
 */
const MARKER_FILENAME = '.dsh-anchor'

const created: string[] = []

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A fresh scratch directory registered for cleanup. */
function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `dsh-slug-${prefix}-`))
  created.push(path)
  return path
}

/** A named directory inside one scratch root, so the slug's basename is known. */
function namedDir(prefix: string, name: string): string {
  const path = join(scratch(prefix), name)
  mkdirSync(path)
  return path
}

/** Run git with a fixed throwaway identity; the probe repos never touch a remote. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=slug@test', '-c', 'user.name=slug', ...args], {
    cwd,
    stdio: 'ignore',
  })
}

/** One committed repository plus a linked worktree, both under one temp root. */
function makeRepoWithWorktree(): { repo: string; worktree: string } {
  const root = scratch('repo')
  const repo = join(root, 'repo')
  const worktree = join(root, 'wt')
  mkdirSync(repo)
  git(repo, ['init', '-q', '.'])
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
  git(repo, ['worktree', 'add', '-q', worktree])
  return { repo, worktree }
}

/**
 * One committed repository plus a linked worktree NESTED inside it (this
 * org's own `.worktrees/` convention). Nesting matters here: the marker
 * walk from the worktree must pass through the repository root to find a
 * marker planted there, which a sibling worktree never would.
 */
function makeRepoWithNestedWorktree(): { repo: string; worktree: string } {
  const root = scratch('repo')
  const repo = join(root, 'repo')
  const worktree = join(repo, '.worktrees', 'wt')
  mkdirSync(repo)
  git(repo, ['init', '-q', '.'])
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
  mkdirSync(join(repo, '.worktrees'), { recursive: true })
  git(repo, ['worktree', 'add', '-q', worktree])
  return { repo, worktree }
}

describe('project scope slug', () => {
  it('gives every worktree of one repository the same scope directory', () => {
    const { repo, worktree } = makeRepoWithWorktree()
    const slug = projectSlug(worktree)
    expect(slug).toBe(projectSlug(repo))
    // The readable half names the repository the anchor belongs to, not the
    // worktree checkout directory.
    expect(slug).toMatch(/^repo-[0-9a-z]{6}$/)
  })

  it('keeps distinct scopes for distinct non-git directories', () => {
    const plain = namedDir('plain', 'workspace-a')
    const other = namedDir('plain', 'workspace-b')
    const slug = projectSlug(plain)
    expect(slug).toMatch(/^workspace-a-[0-9a-z]{6}$/)
    expect(slug).not.toBe(projectSlug(other))
    expect(projectSlug(plain)).toBe(slug)
  })

  it('keeps two same-named repositories distinct through the anchor hash', () => {
    const first = makeRepoWithWorktree()
    const second = makeRepoWithWorktree()
    const slug = projectSlug(first.repo)
    expect(slug).toMatch(/^repo-[0-9a-z]{6}$/)
    expect(slug).not.toBe(projectSlug(second.repo))
  })

  it('still derives a scope when the anchor probe fails on an invalid repository', () => {
    const broken = join(scratch('broken'), 'broken')
    mkdirSync(join(broken, '.git'), { recursive: true })
    const slug = projectSlug(broken)
    expect(slug).toMatch(/^broken-[0-9a-z]{6}$/)
    expect(projectSlug(broken)).toBe(slug)
  })

  it('derives a scope from an absent working directory without throwing', () => {
    const absent = join(scratch('absent'), 'gone', 'deeper')
    expect(projectSlug(absent)).toMatch(/^deeper-[0-9a-z]{6}$/)
  })

  it('falls back to the project default for a degenerate root-level git anchor', () => {
    // A repository anchored directly at the filesystem root owns no readable
    // directory name; the slug keeps the project default and stays stable.
    const slug = projectSlug('/.git')
    expect(slug).toMatch(/^[A-Za-z0-9._-]{1,64}-[0-9a-z]{6}$/)
    expect(projectSlug('/.git')).toBe(slug)
  })

  it('rejects an empty cwd', () => {
    expect(() => projectSlug('')).toThrow('memory: project cwd must be a non-empty path')
  })
})

describe('project scope slug marker', () => {
  it('scopes a marker-anchored directory to itself, basename from the marker directory', () => {
    const dir = namedDir('marker-plain', 'my-scratch-project')
    writeFileSync(join(dir, MARKER_FILENAME), '')
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    const slug = projectSlug(sub)
    expect(slug).toMatch(/^my-scratch-project-[0-9a-z]{6}$/)
    expect(projectSlug(dir)).toBe(slug)
  })

  it('lets a marker in a plain subdirectory win over the enclosing repository, basename from the marker dir', () => {
    const repo = namedDir('marker-sub', 'host-repo')
    git(repo, ['init', '-q', '.'])
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const sub = join(repo, 'marked-sub')
    mkdirSync(sub)
    writeFileSync(join(sub, MARKER_FILENAME), '')
    const slug = projectSlug(sub)
    // Basename comes from the marker directory itself, not a `.git`-stripped
    // parent — the marker anchor is a plain directory, never a `.git` path.
    expect(slug).toMatch(/^marked-sub-[0-9a-z]{6}$/)
    expect(slug).not.toBe(projectSlug(repo))
  })

  it('gives a repository-root marker the same scope from a nested worktree as from the main checkout', () => {
    const { repo, worktree } = makeRepoWithNestedWorktree()
    writeFileSync(join(repo, MARKER_FILENAME), '')
    const slug = projectSlug(repo)
    // Regression guard: comparing against `git rev-parse --show-toplevel`
    // instead of the common dir's parent would break this tie the other
    // way when evaluated from inside the worktree.
    expect(projectSlug(worktree)).toBe(slug)
    expect(slug).toMatch(/^repo-[0-9a-z]{6}$/)
  })

  it('does not let an outer marker leak into a nested repository scope', () => {
    const outer = scratch('marker-outer')
    writeFileSync(join(outer, MARKER_FILENAME), '')
    const nestedRepo = join(outer, 'nested-repo')
    mkdirSync(nestedRepo)
    git(nestedRepo, ['init', '-q', '.'])
    git(nestedRepo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    // Git wins (the marker is shallower than the nested repository), so the
    // basename still comes from the `.git`-stripped nested repo directory.
    expect(projectSlug(nestedRepo)).toMatch(/^nested-repo-[0-9a-z]{6}$/)
  })

  it('flows one marker through both projectSlug and deriveNamedSessionId together', () => {
    const dir = namedDir('marker-flow', 'flow-project')
    writeFileSync(join(dir, MARKER_FILENAME), '')
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    // One marker backs both the memory scope slug and the named-session id:
    // evaluating from the marked directory and from a subdirectory beneath
    // it must agree on both, because both hash the same `projectAnchor`.
    expect(projectSlug(sub)).toBe(projectSlug(dir))
    expect(deriveNamedSessionId('robin', sub)).toBe(deriveNamedSessionId('robin', dir))
  })
})
