/** Project-anchor resolution: git common-dir anchoring, fallbacks, and the worktree-sharing contract. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ANCHOR_MARKER_FILENAME,
  deriveNamedSessionId,
  lockPathForToken,
  namedLockPath,
  namedSessionToken,
  projectAnchor,
} from '../src/index.ts'

const created: string[] = []

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A fresh scratch directory registered for cleanup. */
function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `dsh-anchor-${prefix}-`))
  created.push(path)
  return path
}

/** Run git with a fixed throwaway identity; the probe repos never touch a remote. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=anchor@test', '-c', 'user.name=anchor', ...args], {
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
 * One committed repository plus a linked worktree NESTED inside it, the way
 * this org's own `.worktrees/` convention places one. Nesting matters for
 * the worktree-invariance regression test below: the marker walk from the
 * worktree must pass through the repository root to find a marker planted
 * there, which a sibling worktree (outside the repository directory) would
 * never do.
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

/** Plant an `.dsh-anchor` marker in `dir`; content is never read, so empty is enough. */
function plantMarker(dir: string): void {
  writeFileSync(join(dir, ANCHOR_MARKER_FILENAME), '')
}

// None of the fixtures below ever create an `.dsh-anchor` marker, so every
// case in this describe block exercises only the pre-marker code path (the
// `findMarkerDir` walk always returns undefined) — they are unaffected by
// the marker feature by construction, not merely "still passing".
describe('project anchor', () => {
  it('anchors every worktree of one repository on the shared common dir', () => {
    const { repo, worktree } = makeRepoWithWorktree()
    const expected = realpathSync(join(repo, '.git'))
    expect(projectAnchor(repo)).toBe(expected)
    expect(projectAnchor(worktree)).toBe(expected)
    // A subdirectory probes through a relative common-dir print; resolve
    // must land on the same anchor.
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    expect(projectAnchor(sub)).toBe(expected)
  })

  it('derives one named-session id from every worktree of one repository', () => {
    const { repo, worktree } = makeRepoWithWorktree()
    const fromWorktree = deriveNamedSessionId('robin', worktree)
    expect(fromWorktree).toBe(deriveNamedSessionId('robin', repo))
    expect(namedSessionToken(String(fromWorktree))).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps two repositories from deriving the same name into one session id', () => {
    const first = makeRepoWithWorktree()
    const second = makeRepoWithWorktree()
    expect(projectAnchor(first.repo)).not.toBe(projectAnchor(second.repo))
    expect(deriveNamedSessionId('robin', first.repo)).not.toBe(deriveNamedSessionId('robin', second.repo))
  })

  it('falls back to the directory itself outside a git repository', () => {
    const plain = scratch('plain')
    const other = scratch('other')
    expect(projectAnchor(plain)).toBe(realpathSync(plain))
    expect(projectAnchor(plain)).not.toBe(projectAnchor(other))
    const id = deriveNamedSessionId('worker', plain)
    expect(id).not.toBe(deriveNamedSessionId('worker', other))
    // Cached: the same cwd derives the same id without re-probing.
    expect(deriveNamedSessionId('worker', plain)).toBe(id)
  })

  it('falls back without throwing when the probe fails on an invalid repository', () => {
    const broken = join(scratch('broken'), 'broken')
    mkdirSync(join(broken, '.git'), { recursive: true })
    expect(projectAnchor(broken)).toBe(realpathSync(broken))
    // The id/lock algebra holds through the fallback: one derivation.
    const token = namedSessionToken(String(deriveNamedSessionId('torn', broken))) ?? ''
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(namedLockPath('torn', broken)).toBe(lockPathForToken(token))
  })

  it('resolves an absent working directory to its literal path without throwing', () => {
    const absent = join(scratch('absent'), 'gone', 'deeper')
    expect(projectAnchor(absent)).toBe(absent)
  })
})

describe('project anchor marker', () => {
  it('anchors on the marker directory when no git repository is anywhere above it', () => {
    const dir = scratch('marker-plain')
    plantMarker(dir)
    // Evaluate from a subdirectory beneath the marker, not the marker
    // directory itself, so this exercises the upward `findMarkerDir` walk
    // rather than only the self-check.
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    expect(projectAnchor(sub)).toBe(realpathSync(dir))
    expect(projectAnchor(dir)).toBe(realpathSync(dir))
  })

  it('lets a marker in a plain subdirectory win over the enclosing repository root', () => {
    const repo = scratch('marker-sub')
    git(repo, ['init', '-q', '.'])
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    plantMarker(sub)
    const gitAnchor = realpathSync(join(repo, '.git'))
    expect(projectAnchor(sub)).toBe(realpathSync(sub))
    expect(projectAnchor(sub)).not.toBe(gitAnchor)
  })

  it('keeps a repository-root marker worktree-invariant against the MAIN CHECKOUT root, not the worktree toplevel', () => {
    const { repo, worktree } = makeRepoWithNestedWorktree()
    plantMarker(repo)
    const fromRepo = projectAnchor(repo)
    const fromWorktree = projectAnchor(worktree)
    // This is the regression test for comparing against
    // `git rev-parse --show-toplevel` instead of `dirname(gitCommonDir)`:
    // show-toplevel from inside the nested worktree returns the worktree's
    // own (deeper) root, which would make the tie break the other way here
    // and split the worktree off from the main checkout's anchor.
    expect(fromWorktree).toBe(fromRepo)
    expect(fromRepo).toBe(realpathSync(repo))
  })

  it('does not let an outer marker leak into a nested repository', () => {
    const outer = scratch('marker-outer')
    plantMarker(outer)
    const nestedRepo = join(outer, 'nested-repo')
    mkdirSync(nestedRepo)
    git(nestedRepo, ['init', '-q', '.'])
    git(nestedRepo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    const gitAnchor = realpathSync(join(nestedRepo, '.git'))
    expect(projectAnchor(nestedRepo)).toBe(gitAnchor)
    expect(projectAnchor(nestedRepo)).not.toBe(realpathSync(outer))
  })

  it('flows one marker through both projectAnchor and deriveNamedSessionId together', () => {
    const dir = scratch('marker-flow')
    plantMarker(dir)
    const sub = join(dir, 'sub')
    mkdirSync(sub)
    // A named-session id derived from the marked subdirectory must key off
    // the marker anchor, not the subdirectory itself or a git fallback.
    expect(deriveNamedSessionId('robin', sub)).toBe(deriveNamedSessionId('robin', dir))
  })
})
