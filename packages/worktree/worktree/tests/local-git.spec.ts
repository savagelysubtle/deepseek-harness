/**
 * The local git provider against a real fixture repository: the spawn →
 * lock → unlock → remove lifecycle over actual git, the creation lock reason,
 * the copy-list bootstrap with a real `.env`, and git failure mapping.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeServiceModule, { LocalGitWorktrees, WorktreeService } from '../src/index.ts'

const execFileAsync = promisify(execFile)

const roots: string[] = []
const contexts: Context[] = []

interface Fixture {
  ctx: Context
  service: WorktreeService
  root: string
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })
  return stdout
}

/** Real git repository with one commit, and the seam mounted with its local provider. */
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-git-'))
  roots.push(root)
  await git(root, ['init', '-b', 'master'])
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), 'fixture\n', 'utf8')
  await git(root, ['add', 'README.md'])
  await git(root, ['commit', '-m', 'init'])

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot: join(root, 'wt-root'), mainRef: 'master' })
  await ctx.plugin(LocalGitWorktrees)
  return { ctx, service: ctx.worktrees, root }
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('local git provider lifecycle', () => {
  it('creates a locked worktree on a new branch and lists it as git sees it', async () => {
    const { service, root } = await fixture()
    const result = await service.spawn({ seat: 'steve', intent: 'ship the login fix' })

    expect(readFileSync(join(result.path, '.git'), 'utf8')).toContain('gitdir')
    await expect(git(root, ['rev-parse', '--verify', `refs/heads/${result.branch}`])).resolves.toBeDefined()

    const listed = await service.getProvider('local-git')?.list() ?? []
    const entry = listed.find(candidate => candidate.path === result.path)
    expect(entry).toMatchObject({ branch: result.branch, locked: true, lockReason: result.lockReason })
  })

  it('walks spawn → list → lock → unlock → remove over real git', async () => {
    const { service, root } = await fixture()
    const spawned = await service.spawn({ seat: 'steve', intent: 'work' })
    expect(service.list().map(row => row.branch)).toEqual([spawned.branch])

    const unlocked = await service.unlock(spawned.slug, 'round one starting')
    expect(unlocked.lockReason).toBeUndefined()
    const locked = await service.lock(spawned.slug, 'round two')
    expect(locked.lockReason).toBe('round two')
    await service.unlock(spawned.slug, 'round finished')
    await service.remove(spawned.slug, 'work merged')

    const remaining = await service.getProvider('local-git')?.list() ?? []
    expect(remaining.find(entry => entry.path === spawned.path)).toBeUndefined()
    await expect(git(root, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(spawned.path)
  })

  it('refuses removing a locked worktree until unlock carries a reason', async () => {
    const { service } = await fixture()
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await expect(service.remove(slug, 'work merged'))
      .rejects.toThrow(/is locked \(reason: "steve steve\.[^"]+"\)/)
    await service.unlock(slug, 'cleared for removal')
    await expect(service.remove(slug, 'work merged')).resolves.toBeUndefined()
  })

  it('copies the .env copy-list bootstrap into the fresh worktree', async () => {
    const { service, root } = await fixture()
    writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=sk-fixture\n', 'utf8')
    writeFileSync(join(root, '.worktree-include'), '.env\n', 'utf8')
    const result = await service.spawn({ seat: 'steve', intent: 'work' })
    expect(result.copied).toEqual(['.env'])
    expect(readFileSync(join(result.path, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-fixture\n')
  })

  it('reports an empty copy list without .worktree-include', async () => {
    const { service } = await fixture()
    const result = await service.spawn({ seat: 'steve', intent: 'work' })
    expect(result.copied).toEqual([])
  })

  it('maps git failures to loud errors carrying stderr', async () => {
    const { service } = await fixture()
    await expect(service.spawn({ seat: 'steve', intent: 'work', mainRef: 'no-such-ref' }))
      .rejects.toThrow(/failed.*invalid reference: no-such-ref/s)
    expect(service.list()).toEqual([])
  })

  it('refuses the spawn before any git mutation when the env key is missing', async () => {
    const { service } = await fixture()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('DEEPSEEK_API_KEY')
    expect((await service.getProvider('local-git')?.list() ?? []).length).toBe(1) // only the main checkout
  })
})

describe('git environment hygiene', () => {
  it('strips inherited GIT_DIR so the child addresses the configured repo', async () => {
    const { service } = await fixture()
    const previous = process.env['GIT_DIR']
    process.env['GIT_DIR'] = '/definitely/not/a/git/dir'
    try {
      const result = await service.spawn({ seat: 'steve', intent: 'work' })
      expect(readFileSync(join(result.path, '.git'), 'utf8')).toContain('gitdir')
    } finally {
      if (previous !== undefined) process.env['GIT_DIR'] = previous
      else delete process.env['GIT_DIR']
    }
  })
})

describe('provider mount', () => {
  it('unregisters the local provider when the mounting fiber is disposed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-git-'))
    roots.push(root)
    await git(root, ['init', '-b', 'master'])
    await git(root, ['config', 'user.email', 'test@example.com'])
    await git(root, ['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'README.md'), 'fixture\n', 'utf8')
    await git(root, ['add', 'README.md'])
    await git(root, ['commit', '-m', 'init'])

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot: join(root, 'wt-root') })
    const fiber = await ctx.plugin(LocalGitWorktrees)
    expect(ctx.worktrees.listProviders()).toEqual(['local-git'])
    await fiber.dispose()
    expect(ctx.worktrees.listProviders()).toEqual([])
  })

  it('creates the worktrees root on demand', async () => {
    const { service, root } = await fixture()
    await service.spawn({ seat: 'steve', intent: 'work' })
    expect(existsSync(join(root, 'wt-root'))).toBe(true)
  })
})
