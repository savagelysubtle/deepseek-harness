/**
 * Failure-mapping and porcelain-parsing paths of the local git provider,
 * driven through the injected exec seam, plus the registerProvider disposer
 * edge the lifecycle tests cannot reach.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeServiceModule, { LocalGitWorktreeProvider, WorktreeService } from '../src/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-seam-'))
  roots.push(root)
  return root
}

/** Provider whose git calls fail exactly as the injected script says. */
function failingProvider(script: (args: readonly string[]) => Promise<string>): LocalGitWorktreeProvider {
  return new LocalGitWorktreeProvider({ repoRoot: fixtureRoot(), exec: script })
}

describe('git failure mapping', () => {
  it('carries git stderr in the refusal when the child reports it', async () => {
    const provider = failingProvider(async () => {
      throw { code: 128, stderr: 'fatal: something broke\n' }
    })
    await expect(provider.branchExists('steve/slug')).rejects.toThrow('failed: fatal: something broke')
  })

  it('falls back to the exit code when stderr is empty', async () => {
    const provider = failingProvider(async () => {
      throw { code: 69, stderr: undefined }
    })
    await expect(provider.remove('/no/path')).rejects.toThrow('failed with exit code 69')
  })

  it('reports an unknown exit code for non-numeric failures', async () => {
    const provider = failingProvider(async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    })
    await expect(provider.lock('/no/path', 'r')).rejects.toThrow('failed with exit code unknown')
    await expect(provider.unlock('/no/path')).rejects.toThrow('failed with exit code unknown')
    await expect(provider.list()).rejects.toThrow('failed with exit code unknown')
  })

  it('resolves branchExists true when the ref check succeeds', async () => {
    const provider = failingProvider(async () => '')
    await expect(provider.branchExists('steve/slug')).resolves.toBe(true)
  })

  it('keeps foreign failures as the cause of the mapped refusal', async () => {
    const provider = failingProvider(async () => {
      throw new Error('not git')
    })
    const error = await provider.branchExists('steve/slug').then(
      () => { throw new Error('expected rejection') },
      (failure: unknown) => failure as Error & { cause?: unknown },
    )
    expect(error.message).toContain('failed with exit code unknown')
    expect(((error.cause as Error).cause as Error).message).toBe('not git')
  })

  it('treats rev-parse exit 1 as absence and keeps other codes as errors', async () => {
    let calls = 0
    const provider = failingProvider(async () => {
      calls += 1
      if (calls === 1) throw { code: 1, stderr: '' }
      throw { code: 128, stderr: 'fatal: not a git repository' }
    })
    await expect(provider.branchExists('steve/absent')).resolves.toBe(false)
    await expect(provider.branchExists('steve/broken')).rejects.toThrow('not a git repository')
  })
})

describe('porcelain parsing', () => {
  it('parses detached worktrees and bare locked lines without inventing values', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abcdef1234',
      'branch refs/heads/master',
      '',
      'worktree /repo/wt-locked',
      'HEAD abcdef5678',
      'branch refs/heads/steve/slug',
      'locked round two',
      '',
      'worktree /repo/wt-detached',
      'HEAD abcdef9012',
      'detached',
      '',
      'worktree /repo/wt-bare-locked',
      'HEAD abcdef3456',
      'locked',
      '',
    ].join('\n')
    const provider = new LocalGitWorktreeProvider({
      repoRoot: fixtureRoot(),
      exec: async (args) => {
        expect(args).toEqual(['worktree', 'list', '--porcelain'])
        return porcelain
      },
    })
    expect(await provider.list()).toEqual([
      { path: '/repo', branch: 'master', locked: false },
      { path: '/repo/wt-locked', branch: 'steve/slug', locked: true, lockReason: 'round two' },
      { path: '/repo/wt-detached', locked: false },
      { path: '/repo/wt-bare-locked', locked: true },
    ])
  })
})

describe('provider disposer edge', () => {
  it('a stale disposer never removes a re-registered successor', async () => {
    const ctx = new Context()
    const root = fixtureRoot()
    await ctx.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot: join(root, 'wt-root') })
    const service: WorktreeService = ctx.worktrees
    const first = service.registerProvider(new LocalGitWorktreeProvider({ repoRoot: root }))
    first()
    const second = service.registerProvider(new LocalGitWorktreeProvider({ repoRoot: root }))
    first()
    expect(service.listProviders()).toEqual(['local-git'])
    second()
    expect(service.listProviders()).toEqual([])
  })
})
