/** Project-anchor resolution: git common-dir anchoring, fallbacks, and the worktree-sharing contract. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
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
