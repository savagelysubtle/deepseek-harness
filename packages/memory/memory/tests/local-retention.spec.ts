/**
 * Regression coverage for SWD-148: `write()` must never silently destroy an
 * entry it replaces, even when several writers race one path. Covers the
 * retained-copy location and cap, the write result's `replaced` reporting,
 * invisibility to list()/search(), the fail-loud behavior when retention
 * itself cannot happen, genuinely concurrent writers on one path (the actual
 * shape of the 2026-08-26 incident, not just sequential overwrites), and the
 * per-entry lock's stale-holder takeover so a dead process's lock cannot
 * wedge a write forever.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { LocalMemoryProvider, MAX_RETAINED_VERSIONS } from '../src/local.ts'

const PROJECT = '/tmp/fictional/retention-workspace'

/** One fresh provider over a fresh temp root; `done()` removes the root. */
interface Booted {
  provider: LocalMemoryProvider
  root: string
  done: () => Promise<void>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-retention-'))
  const provider = new LocalMemoryProvider(new Context(), { root })
  const done = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true })
  }
  return { provider, root, done }
}

/** The single project-scope directory under a freshly booted root. */
async function scopeDir(root: string): Promise<string> {
  const [name] = await readdir(root)
  return join(root, name as string)
}

/** Every retained copy's content for one entry, oldest filename first. */
async function retainedContents(root: string, relativeDir: string, basename: string): Promise<string[]> {
  const dir = join(await scopeDir(root), '.replaced', relativeDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const versions = names.filter(name => name.startsWith(`${basename}.`)).sort()
  return Promise.all(versions.map(name => readFile(join(dir, name), 'utf8')))
}

describe('write() retention (SWD-148)', () => {
  it('reports nothing replaced and creates no .replaced directory for a fresh path', async () => {
    const booted = await boot()
    try {
      const result = await booted.provider.write(PROJECT, 'fresh.md', 'first content')
      expect(result.replaced).toBeUndefined()
      const scope = await scopeDir(booted.root)
      await expect(readdir(join(scope, '.replaced'))).rejects.toThrow()
    } finally {
      await booted.done()
    }
  })

  it('overwriting an existing entry reports the replacement and keeps it recoverable', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'note.md', 'version one')
      const result = await booted.provider.write(PROJECT, 'note.md', 'version two')
      expect(result.replaced?.bytes).toBe(Buffer.byteLength('version one', 'utf8'))
      expect(typeof result.replaced?.modifiedAt).toBe('string')
      expect(new Date(result.replaced?.modifiedAt ?? '').toString()).not.toBe('Invalid Date')
      expect(await retainedContents(booted.root, '', 'note.md')).toEqual(['version one'])
      expect(await booted.provider.read(PROJECT, 'note.md')).toBe('version two')
    } finally {
      await booted.done()
    }
  })

  it('four genuinely overlapping writers racing one path leave every distinct content recoverable', async () => {
    const booted = await boot()
    try {
      // Genuinely concurrent, not four awaited writes in a row: every write
      // starts via Promise.all before any of the others is known to have
      // finished, so this actually exercises the per-entry lock's contention
      // path (one writer's retain-and-rename versus another's) the way the
      // 2026-08-26 incident did across four separate seat processes. Which
      // body ends up live is therefore not deterministic — only that none of
      // the four is ever lost is asserted.
      const bodies = ['writer-a anchor', 'writer-b anchor', 'writer-c anchor', 'writer-d anchor']
      await Promise.all(bodies.map(body => booted.provider.write(PROJECT, 'shared/anchor.md', body)))
      const live = await booted.provider.read(PROJECT, 'shared/anchor.md')
      const retained = await retainedContents(booted.root, 'shared', 'anchor.md')
      expect(retained).toHaveLength(bodies.length - 1)
      const everRecoverable = new Set([live, ...retained])
      for (const body of bodies) {
        expect(everRecoverable.has(body)).toBe(true)
      }
    } finally {
      await booted.done()
    }
  })

  it('two separately constructed providers over one root racing one path do not lose either write (cross-process proxy)', async () => {
    const booted = await boot()
    try {
      // A second, independently constructed provider over the SAME root
      // shares no in-memory state with the first — the only thing excluding
      // one from the other is the filesystem lock, which is exactly what a
      // second OS process would also depend on. This is the closest a
      // single-process suite can get to the actual multi-seat incident
      // without spawning a real child process.
      const other = new LocalMemoryProvider(new Context(), { root: booted.root })
      const bodyA = 'provider-a body'
      const bodyB = 'provider-b body'
      await Promise.all([
        booted.provider.write(PROJECT, 'cross/anchor.md', bodyA),
        other.write(PROJECT, 'cross/anchor.md', bodyB),
      ])
      const live = await booted.provider.read(PROJECT, 'cross/anchor.md')
      const retained = await retainedContents(booted.root, 'cross', 'anchor.md')
      expect(new Set([live, ...retained])).toEqual(new Set([bodyA, bodyB]))
    } finally {
      await booted.done()
    }
  })

  it('takes over a lock whose recorded holder process is no longer alive, instead of wedging the write', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'stale-lock.md', 'first content')
      const scope = await scopeDir(booted.root)
      const lockPath = join(scope, '.locks', 'stale-lock.md.lock')
      await mkdir(join(lockPath, '..'), { recursive: true })
      // A pid this large can never name a real, live process on any real
      // system — the write must treat it exactly like a holder that exited
      // without releasing, not wait out the full acquire timeout for it.
      await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), 'utf8')
      const result = await booted.provider.write(PROJECT, 'stale-lock.md', 'second content')
      expect(result.replaced?.bytes).toBe(Buffer.byteLength('first content', 'utf8'))
      expect(await booted.provider.read(PROJECT, 'stale-lock.md')).toBe('second content')
    } finally {
      await booted.done()
    }
  })

  it('prunes retained versions beyond the cap, keeping only the newest', async () => {
    const booted = await boot()
    try {
      const total = MAX_RETAINED_VERSIONS + 3
      for (let i = 0; i < total; i++) {
        await booted.provider.write(PROJECT, 'capped.md', `body ${i}`)
      }
      const retained = await retainedContents(booted.root, '', 'capped.md')
      expect(retained).toHaveLength(MAX_RETAINED_VERSIONS)
      const expectedKept = Array.from(
        { length: MAX_RETAINED_VERSIONS },
        (_, i) => `body ${total - 1 - MAX_RETAINED_VERSIONS + i}`,
      )
      for (const body of expectedKept) {
        expect(retained).toContain(body)
      }
      expect(retained).not.toContain('body 0')
      expect(retained).not.toContain('body 1')
      expect(await booted.provider.read(PROJECT, 'capped.md')).toBe(`body ${total - 1}`)
    } finally {
      await booted.done()
    }
  })

  it('never surfaces retained copies through list() or search()', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'visible.md', 'searchable needle one')
      await booted.provider.write(PROJECT, 'visible.md', 'searchable needle two')
      expect((await booted.provider.list(PROJECT)).map(entry => entry.path)).toEqual(['visible.md'])
      const matches = await booted.provider.search(PROJECT, 'needle')
      expect(matches).toHaveLength(1)
      expect(matches[0]?.path).toBe('visible.md')
    } finally {
      await booted.done()
    }
  })

  it('fails the write and leaves the original content intact when retaining fails', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'guarded.md', 'original content')
      const scope = await scopeDir(booted.root)
      // Retention needs `.replaced` to be a directory; forcing it to be a
      // plain file makes the recursive mkdir underneath it fail.
      await writeFile(join(scope, '.replaced'), 'not a directory', 'utf8')
      await expect(booted.provider.write(PROJECT, 'guarded.md', 'new content'))
        .rejects.toThrow(/could not retain the previous "guarded\.md"/)
      expect(await booted.provider.read(PROJECT, 'guarded.md')).toBe('original content')
    } finally {
      await booted.done()
    }
  })
})
