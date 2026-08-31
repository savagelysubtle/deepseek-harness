/**
 * Service lifecycle against a fake provider: spawn → list → lock → unlock →
 * remove, slug uniqueness, the forbidden-operation fences, the env gate,
 * registry rows, persistence, and disposal.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorktreeServiceModule, { resolveConfig, WorktreeError, WorktreeService } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { WorktreeProvider } from '../src/provider.ts'
import type { WorktreeAddSpec, WorktreeRow, WorktreeSlug } from '../src/types.ts'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-service-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** Scriptable in-memory fake; the service's fences are what varies here. */
class FakeProvider implements WorktreeProvider {
  readonly calls: string[] = []
  readonly adds: WorktreeAddSpec[] = []
  readonly createdPaths = new Set<string>()
  readonly branches = new Set<string>()
  reportPathExists = false
  reportBranchExists = false
  failRemove = false

  constructor(readonly name = 'fake') {}

  async pathExists(path: string): Promise<boolean> {
    return this.reportPathExists || this.createdPaths.has(path)
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.reportBranchExists || this.branches.has(branch)
  }

  async add(spec: WorktreeAddSpec): Promise<void> {
    this.calls.push(`add ${spec.path}`)
    this.adds.push(spec)
    this.createdPaths.add(spec.path)
    this.branches.add(spec.branch)
  }

  async lock(path: string, reason: string): Promise<void> {
    this.calls.push(`lock ${path}: ${reason}`)
  }

  async unlock(path: string): Promise<void> {
    this.calls.push(`unlock ${path}`)
  }

  async remove(path: string): Promise<void> {
    if (this.failRemove) throw new Error('simulated removal failure')
    this.calls.push(`remove ${path}`)
    this.createdPaths.delete(path)
  }

  async list() {
    return []
  }
}

interface Harness {
  ctx: Context
  service: WorktreeService
  provider: FakeProvider
  root: string
}

async function harness(config: Partial<Config> = {}, provider = new FakeProvider()): Promise<Harness> {
  const ctx = new Context()
  const root = fixtureRoot()
  await ctx.plugin(WorktreeServiceModule, {
    repoRoot: root,
    worktreesRoot: join(root, 'wt-root'),
    ...config,
  })
  ctx.plugin((scope) => {
    scope.effect(() => ctx.worktrees.registerProvider(provider), 'test.registerProvider')
  })
  return { ctx, service: ctx.worktrees, provider, root }
}

describe('spawn → list → lock → unlock → remove lifecycle', () => {
  it('spawns locked, derives every name from seat + slug, and publishes the row', async () => {
    const { service, provider } = await harness()
    const result = await service.spawn({ seat: 'steve', intent: 'ship the login fix' })
    expect(result.branch).toBe(`steve/${result.slug}`)
    expect(result.session).toBe(`steve.${result.slug}`)
    expect(result.path).toBe(join(service.worktreesRoot, `steve-${result.slug}`))
    expect(result.lockReason).toBe(`steve ${result.session}`)
    expect(result.branchRef).toBe('master')
    expect(result.copied).toEqual([])
    expect(provider.adds).toEqual([{
      path: result.path,
      branch: result.branch,
      mainRef: 'master',
      lockReason: result.lockReason,
    }])
    const row = service.row(result.slug)
    expect(row).toMatchObject({
      slug: result.slug,
      seat: 'steve',
      branch: result.branch,
      session: result.session,
      path: result.path,
      branchRef: 'master',
      lockReason: result.lockReason,
      lastReason: 'ship the login fix',
    })
    expect(typeof row?.createdAt).toBe('number')
    expect(service.list()).toHaveLength(1)
  })

  it('honors an explicit main ref over the configured default', async () => {
    const { service, provider } = await harness({ mainRef: 'develop' })
    const result = await service.spawn({ seat: 'steve', intent: 'work', mainRef: 'release/1' })
    expect(result.branchRef).toBe('release/1')
    expect(provider.adds[0]?.mainRef).toBe('release/1')
  })

  it('locks and unlocks with reasons, updating the row each time', async () => {
    const { service, provider } = await harness()
    const { slug, path } = await service.spawn({ seat: 'steve', intent: 'work' })
    // The worktree is born locked (spawn reason on the fence); locking again
    // refuses until an unlock brings the fence down.
    await expect(service.lock(slug, 'round one')).rejects.toThrow('already locked')
    const unlocked = await service.unlock(slug, 'round one starting')
    expect(unlocked.lastReason).toBe('round one starting')
    expect('lockReason' in unlocked).toBe(false)
    const locked = await service.lock(slug, 'round two')
    expect(locked.lockReason).toBe('round two')
    expect(locked.lastReason).toBe('round two')
    expect(provider.calls).toContain(`lock ${path}: round two`)
    const settled = await service.unlock(slug, 'round finished')
    expect(settled.lockReason).toBeUndefined()
    expect(settled.lastReason).toBe('round finished')
  })

  it('removes an unlocked worktree and deletes its row', async () => {
    const { service, provider } = await harness()
    const { slug, path } = await service.spawn({ seat: 'steve', intent: 'work' })
    await service.unlock(slug, 'handing over')
    await service.remove(slug, 'work merged')
    expect(provider.calls).toContain(`remove ${path}`)
    expect(service.row(slug)).toBeUndefined()
    expect(service.list()).toEqual([])
  })

  it('emits lifecycle events at each commit point', async () => {
    const { ctx, service } = await harness()
    const events: string[] = []
    ctx.on('worktree/spawned', () => events.push('spawned'))
    ctx.on('worktree/locked', () => events.push('locked'))
    ctx.on('worktree/unlocked', () => events.push('unlocked'))
    ctx.on('worktree/removed', () => events.push('removed'))
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await service.unlock(slug, 'starting work')
    await service.lock(slug, 'busy')
    await service.unlock(slug, 'done')
    await service.remove(slug, 'cleaned up')
    expect(events).toEqual(['spawned', 'unlocked', 'locked', 'unlocked', 'removed'])
  })
})

describe('slug minting at spawn', () => {
  it('mints unique slugs, branches, and paths across parallel rounds', async () => {
    const { service } = await harness()
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      service.spawn({ seat: index % 2 === 0 ? 'steve' : 'alfred', intent: 'parallel round' })))
    expect(new Set(results.map(result => result.slug)).size).toBe(12)
    expect(new Set(results.map(result => result.branch)).size).toBe(12)
    expect(new Set(results.map(result => result.path)).size).toBe(12)
    expect(service.list()).toHaveLength(12)
  })
})

describe('forbidden operations', () => {
  it('refuses to spawn into an existing path — force-add stays unrepresentable', async () => {
    const { service, provider } = await harness()
    provider.reportPathExists = true
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow(/already exists.*force-reusing it.*forbidden/)
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toBeInstanceOf(WorktreeError)
    expect(provider.calls).toEqual([])
  })

  it('refuses branch reuse before the provider runs', async () => {
    const { service, provider } = await harness()
    provider.reportBranchExists = true
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow(/branch "steve\/[0-9a-z-]+" already exists; branch reuse is forbidden/)
    expect(provider.calls).toEqual([])
  })

  it('refuses removing a locked worktree, carrying the lock reason', async () => {
    const { service } = await harness()
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await expect(service.remove(slug, 'work merged'))
      .rejects.toThrow(/is locked \(reason: "steve steve\.[^"]+"\); unlock with a reason before removing/)
    expect(service.row(slug)).toBeDefined()
  })

  it('refuses re-locking a locked worktree, carrying the existing reason', async () => {
    const { service } = await harness()
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await expect(service.lock(slug, 'another reason'))
      .rejects.toThrow(/already locked \(reason: "steve steve\.[^"]+"\); unlock with a reason before locking again/)
  })

  it('refuses unlocking an unlocked worktree', async () => {
    const { service } = await harness()
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await service.unlock(slug, 'freeing the fence')
    await expect(service.unlock(slug, 'again')).rejects.toThrow('is not locked; nothing to unlock')
  })

  it('refuses every operation on an unknown slug', async () => {
    const { service } = await harness()
    const slug = 'm1a-9-deadbeef' as WorktreeSlug
    await expect(service.lock(slug, 'r')).rejects.toThrow('no live worktree carries slug')
    await expect(service.unlock(slug, 'r')).rejects.toThrow('no live worktree carries slug')
    await expect(service.remove(slug, 'r')).rejects.toThrow('no live worktree carries slug')
  })

  it('refuses empty reasons — a fence without a stated reason is silent', async () => {
    const { service } = await harness()
    const { slug } = await service.spawn({ seat: 'steve', intent: 'work' })
    await expect(service.lock(slug, '  ')).rejects.toThrow('worktree lock requires a non-empty reason')
    await expect(service.unlock(slug, '')).rejects.toThrow('worktree unlock requires a non-empty reason')
    await service.unlock(slug, 'valid reason')
    await expect(service.remove(slug, '')).rejects.toThrow('worktree remove requires a non-empty reason')
  })
})

describe('env-presence gate', () => {
  it('refuses the spawn before any mutation when the key is missing', async () => {
    const { service, provider } = await harness()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('work session requires DEEPSEEK_API_KEY in the environment')
    expect(provider.calls).toEqual([])
    expect(service.list()).toEqual([])
  })
})

describe('request validation', () => {
  it('rejects seats outside the session-name grammar', async () => {
    const { service } = await harness()
    await expect(service.spawn({ seat: 'bad seat', intent: 'work' }))
      .rejects.toThrow('invalid seat "bad seat"')
    await expect(service.spawn({ seat: '-leading', intent: 'work' })).rejects.toBeInstanceOf(WorktreeError)
  })

  it('rejects a blank intent', async () => {
    const { service } = await harness()
    await expect(service.spawn({ seat: 'steve', intent: '  ' }))
      .rejects.toThrow('spawn intent must be a non-empty description of the work')
  })
})

describe('provider resolution and registration', () => {
  it('resolves the single registered provider by omission and refuses ambiguity', async () => {
    const first = await harness()
    await expect(first.service.spawn({ seat: 'steve', intent: 'work' })).resolves.toBeDefined()
    await first.ctx.fiber.dispose()

    const second = new Context()
    const root = fixtureRoot()
    await second.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot: join(root, 'wt-root') })
    for (const name of ['one', 'two']) {
      await second.plugin((scope) => {
        scope.effect(() => second.worktrees.registerProvider(new FakeProvider(name)), `register ${name}`)
      })
    }
    await expect(second.worktrees.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('2 worktree providers are registered (one, two); pass a provider name explicitly')
    await expect(second.worktrees.spawn({ seat: 'steve', intent: 'work' }, 'one')).resolves.toBeDefined()
    await second.fiber.dispose()
  })

  it('fails loud for an unknown explicit provider and for no provider at all', async () => {
    const { service } = await harness()
    await expect(service.spawn({ seat: 'steve', intent: 'work' }, 'ghost'))
      .rejects.toThrow('no worktree provider registered under "ghost"')

    const bare = new Context()
    const root = fixtureRoot()
    await bare.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot: join(root, 'wt-root') })
    await expect(bare.worktrees.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('no worktree provider is registered')
    await bare.fiber.dispose()
  })

  it('refuses duplicate provider names and keeps the winning disposer', async () => {
    const { service } = await harness()
    const first = service.registerProvider(new FakeProvider('dup'))
    expect(() => service.registerProvider(new FakeProvider('dup')))
      .toThrow('worktree provider "dup" is already registered')
    first()
    expect(service.listProviders()).toEqual(['fake'])
  })

  it('proves disposal: a disposed fiber unregisters exactly its provider', async () => {
    const { ctx, service } = await harness()
    const fiber = await ctx.plugin((scope) => {
      scope.effect(() => ctx.worktrees.registerProvider(new FakeProvider('extra')), 'test.extra')
    })
    expect(service.listProviders()).toEqual(['fake', 'extra'])
    await fiber.dispose()
    expect(service.listProviders()).toEqual(['fake'])
  })
})

describe('copy-list bootstrap and rollback', () => {
  it('copies listed files into the fresh worktree and reports them', async () => {
    const { service, root } = await harness()
    writeFileSync(join(root, '.env'), 'KEY=value\n', 'utf8')
    writeFileSync(join(root, '.worktree-include'), '# secrets\n.env\n', 'utf8')
    const result = await service.spawn({ seat: 'steve', intent: 'work' })
    expect(result.copied).toEqual(['.env'])
    expect(readFileSync(join(result.path, '.env'), 'utf8')).toBe('KEY=value\n')
  })

  it('rolls the worktree back when the bootstrap fails, leaving no row', async () => {
    const { service, provider, root } = await harness()
    writeFileSync(join(root, '.worktree-include'), '.env\n', 'utf8')
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('lists ".env" but the file does not exist')
    const spawnedPath = provider.adds[0]?.path
    expect(provider.calls).toContain(`unlock ${spawnedPath}`)
    expect(provider.calls).toContain(`remove ${spawnedPath}`)
    expect(service.list()).toEqual([])
  })

  it('surfaces an aggregate when the rollback itself fails', async () => {
    const { service, provider, root } = await harness()
    provider.failRemove = true
    writeFileSync(join(root, '.worktree-include'), '.env\n', 'utf8')
    await expect(service.spawn({ seat: 'steve', intent: 'work' }))
      .rejects.toThrow('worktree bootstrap and its rollback both failed')
    expect(service.list()).toEqual([])
  })
})

describe('registry rows and persistence', () => {
  it('keeps one row per live branch across seats', async () => {
    const { service } = await harness()
    const steve = await service.spawn({ seat: 'steve', intent: 'work' })
    const alfred = await service.spawn({ seat: 'alfred', intent: 'work' })
    expect(service.list().map(row => row.branch)).toEqual([steve.branch, alfred.branch])
    await service.unlock(steve.slug, 'done')
    await service.remove(steve.slug, 'merged')
    expect(service.list().map(row => row.branch)).toEqual([alfred.branch])
  })

  it('mirrors rows to the registry file and reloads them in the next process', async () => {
    const root = fixtureRoot()
    const config = { repoRoot: root, worktreesRoot: join(root, 'wt-root'), persist: true }
    const first = new Context()
    await first.plugin(WorktreeServiceModule, config)
    await first.plugin((scope) => {
      scope.effect(() => first.worktrees.registerProvider(new FakeProvider()), 'test.registerProvider')
    })
    const spawned = await first.worktrees.spawn({ seat: 'steve', intent: 'work' })
    await first.fiber.dispose()

    const file = join(root, 'wt-root', 'registry.json')
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { version: number; rows: WorktreeRow[] }
    expect(persisted.version).toBe(1)
    expect(persisted.rows).toHaveLength(1)

    const second = new Context()
    await second.plugin(WorktreeServiceModule, config)
    expect(second.worktrees.list().map(row => row.slug)).toEqual([spawned.slug])
    expect(second.worktrees.row(spawned.slug)?.lastReason).toBe('work')
    await second.fiber.dispose()
  })

  it('fails loud at mount on a corrupt registry file', async () => {
    const root = fixtureRoot()
    const worktreesRoot = join(root, 'wt-root')
    mkdirSync(worktreesRoot, { recursive: true })
    writeFileSync(join(worktreesRoot, 'registry.json'), 'garbage', 'utf8')
    const ctx = new Context()
    await expect(ctx.plugin(WorktreeServiceModule, { repoRoot: root, worktreesRoot, persist: true }))
      .rejects.toThrow('registry is not valid JSON')
  })
})

describe('config resolution', () => {
  it('derives the worktrees root as the <basename>.worktrees sibling by default', () => {
    const root = fixtureRoot()
    const resolved = resolveConfig({ repoRoot: root })
    expect(resolved.worktreesRoot).toBe(join(dirname(root), `${basename(root)}.worktrees`))
    expect(resolved.mainRef).toBe('master')
    expect(resolved.persist).toBe(false)
  })

  it('fails loud on a missing, relative, or nonexistent repoRoot', () => {
    expect(() => resolveConfig({})).toThrow('repoRoot must be set')
    expect(() => resolveConfig({ repoRoot: 'relative/path' })).toThrow('repoRoot must be an absolute path')
    expect(() => resolveConfig({ repoRoot: '/definitely/not/a/real/dir-w2' })).toThrow('is not an existing directory')
    expect(() => resolveConfig({ repoRoot: '/tmp', mainRef: '  ' })).toThrow('mainRef must be a non-empty ref')
    expect(() => resolveConfig({ repoRoot: '/tmp', worktreesRoot: 'relative' })).toThrow('worktreesRoot must be an absolute path')
  })
})
