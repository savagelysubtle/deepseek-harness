/**
 * Regression coverage for SWD-148: `write()` must never silently destroy an
 * entry it replaces. Covers the retained-copy location and cap, the write
 * result's `replaced` reporting, invisibility to list()/search(), and the
 * fail-loud behavior when retention itself cannot happen.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

  it('four writers racing one path in quick succession leave every earlier content recoverable', async () => {
    const booted = await boot()
    try {
      // Mirrors the actual 2026-08-26 incident: four seats writing one fixed
      // anchor path within seconds of each other, one path, no locking.
      const bodies = ['writer-a anchor', 'writer-b anchor', 'writer-c anchor', 'writer-d anchor']
      for (const body of bodies) {
        await booted.provider.write(PROJECT, 'shared/anchor.md', body)
      }
      const retained = await retainedContents(booted.root, 'shared', 'anchor.md')
      expect(retained).toHaveLength(bodies.length - 1)
      for (const body of bodies.slice(0, -1)) {
        expect(retained).toContain(body)
      }
      expect(await booted.provider.read(PROJECT, 'shared/anchor.md')).toBe(bodies.at(-1))
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
