/**
 * Project-anchor resolution when `realpathSync` itself cannot resolve a
 * directory that `existsSync`/`findMarkerDir` already found: `resolveAnchor`
 * degrades to the un-realpathed directory string rather than throwing (see
 * anchor.ts:166-178). Real filesystem calls almost never hit this — the
 * directories exist throughout the test — so these two branches are driven
 * with a one-shot `realpathSync` fault injected via a `node:fs` mock,
 * matching the control-flag pattern used elsewhere in this suite
 * (subprocess-local/tests/spawn.spec.ts).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANCHOR_MARKER_FILENAME, projectAnchor } from '../src/index.ts'

const failRealpath = vi.hoisted(() => new Set<string>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      if (failRealpath.has(String(args[0]))) {
        throw Object.assign(new Error(`simulated realpath failure for ${String(args[0])}`), { code: 'EIO' })
      }
      return actual.realpathSync(...args)
    }) as typeof actual.realpathSync,
  }
})

const created: string[] = []

afterEach(() => {
  failRealpath.clear()
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A fresh scratch directory registered for cleanup. */
function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `dsh-anchor-realpath-${prefix}-`))
  created.push(path)
  return path
}

/** Plant an `.dsh-anchor` marker in `dir`; content is never read, so empty is enough. */
function plantMarker(dir: string): void {
  writeFileSync(join(dir, ANCHOR_MARKER_FILENAME), '')
}

/** Run git with a fixed throwaway identity; the probe repos never touch a remote. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=anchor@test', '-c', 'user.name=anchor', ...args], {
    cwd,
    stdio: 'ignore',
  })
}

describe('project anchor marker — realpath fallback', () => {
  it('falls back to the marker directory itself when realpath cannot resolve it (no enclosing repository)', () => {
    const dir = scratch('plain')
    plantMarker(dir)
    failRealpath.add(dir)
    // No git anywhere above `dir`, so resolveGitCommonDir never succeeds and
    // never calls realpathSync at all: this exercises line 170's `?? markerDir`
    // fallback (gitCommonDir undefined) in isolation from line 173.
    expect(projectAnchor(dir)).toBe(dir)
  })

  it('falls back to the un-realpathed git-main-root when realpath cannot resolve it, with a marker tied at the root', () => {
    const repo = scratch('repo')
    git(repo, ['init', '-q', '.'])
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
    plantMarker(repo)
    // The git-common-dir probe itself (resolveGitCommonDir) must still resolve
    // normally — only the SECOND realpath call, on dirname(gitCommonDir),
    // is made to fail, isolating line 173's fallback from line 170's.
    failRealpath.add(repo)
    const result = projectAnchor(repo)
    // Marker sits exactly at the (unresolved) git main root: the tie goes to
    // the marker, and both candidates degrade to the literal, un-realpathed
    // directory string — `repo` itself was never passed through the faulted
    // realpathSync, so this is exactly the fallback value line 173 produces.
    expect(result).toBe(repo)
  })
})
