/**
 * Local memory provider tests: round-trips, project scoping, path jail,
 * bounded results, and durable overwrite semantics against temp roots.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { LocalMemoryProvider } from '../src/local.ts'
import { MAX_ENTRY_BYTES, MAX_ENTRY_PATH_LENGTH, MAX_LIST_ENTRIES } from '../src/scope.ts'

const PROJECT_A = '/tmp/fictional/workspace-a'
const PROJECT_B = '/tmp/fictional/workspace-b'

/** One fresh provider over a fresh temp root; `done()` removes the root. */
interface Booted {
  provider: LocalMemoryProvider
  root: string
  done: () => Promise<void>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const provider: LocalMemoryProvider = new LocalMemoryProvider(new Context(), { root })
  const done = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true })
  }
  return { provider, root, done }
}

describe('project scope derivation', () => {
  it('maps the same cwd to one slug directory and different cwds apart', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'a.md', 'alpha')
      await booted.provider.write(PROJECT_A, 'b.md', 'beta')
      await booted.provider.write(PROJECT_B, 'a.md', 'other project')
      const scopes = (await readdir(booted.root)).sort()
      expect(scopes).toHaveLength(2)
      expect(scopes[0]).toMatch(/^workspace-a-[0-9a-z]{6}$/)
      expect((await booted.provider.list(PROJECT_A)).map(entry => entry.path)).toEqual(['a.md', 'b.md'])
      expect(await booted.provider.read(PROJECT_B, 'a.md')).toBe('other project')
    } finally {
      await booted.done()
    }
  })

  it('treats two same-named checkouts at different absolute paths as distinct projects', async () => {
    const booted = await boot()
    try {
      await booted.provider.write('/repos/app', 'one.md', 'first checkout')
      await booted.provider.write('/other/app', 'one.md', 'second checkout')
      expect(await booted.provider.read('/repos/app', 'one.md')).toBe('first checkout')
      expect(await booted.provider.read('/other/app', 'one.md')).toBe('second checkout')
    } finally {
      await booted.done()
    }
  })
})

describe('read/write/list/search round-trips', () => {
  it('creates nested directories implicitly and reads frontmatter back verbatim', async () => {
    const booted = await boot()
    try {
      const content = '---\n.topic: auth\n---\n\n# Auth notes\nUse scheme SSO everywhere.\n'
      const result = await booted.provider.write(PROJECT_A, 'todo/deep/auth.md', content)
      expect(result).toEqual({ path: 'todo/deep/auth.md', bytes: Buffer.byteLength(content, 'utf8') })
      expect(await booted.provider.read(PROJECT_A, 'todo/deep/auth.md')).toBe(content)
    } finally {
      await booted.done()
    }
  })

  it('overwrites completely rather than appending', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'state.md', 'old long state '.repeat(50))
      await booted.provider.write(PROJECT_A, 'state.md', 'new')
      expect(await booted.provider.read(PROJECT_A, 'state.md')).toBe('new')
    } finally {
      await booted.done()
    }
  })

  it('lists recursively, sorted by path, skipping dotfiles and temp files', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'spec/z.md', 'z')
      await booted.provider.write(PROJECT_A, 'a-top.md', 'top')
      await booted.provider.write(PROJECT_A, 'done/archived.md', 'history')
      await booted.provider.write(PROJECT_A, '.hidden.md', 'ignored')
      expect((await booted.provider.list(PROJECT_A)).map(entry => entry.path)).toEqual([
        'a-top.md',
        'done/archived.md',
        'spec/z.md',
      ])
    } finally {
      await booted.done()
    }
  })

  it('searches case-insensitively across entries with line numbers', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'notes/env.md', 'line one\nThe DSN lives in SUPABASE_URL.\nlast line\n')
      await booted.provider.write(PROJECT_A, 'notes/other.md', 'unrelated\n')
      expect(await booted.provider.search(PROJECT_A, 'supabase_url')).toEqual([
        { path: 'notes/env.md', line: 2, excerpt: 'The DSN lives in SUPABASE_URL.' },
      ])
      expect(await booted.provider.search(PROJECT_A, 'missing-string')).toEqual([])
    } finally {
      await booted.done()
    }
  })

  it('bounds search by the requested limit and rejects empty queries', async () => {
    const booted = await boot()
    try {
      let body = ''
      for (let i = 1; i <= 30; i++) body += `needle ${i}\n`
      await booted.provider.write(PROJECT_A, 'bulk.md', body)
      expect(await booted.provider.search(PROJECT_A, 'needle', 5)).toHaveLength(5)
      expect(await booted.provider.search(PROJECT_A, 'needle')).toHaveLength(30)
      await expect(booted.provider.search(PROJECT_A, '')).rejects.toThrow(/non-empty/)
    } finally {
      await booted.done()
    }
  })

  it('rejects a search query over 512 characters', async () => {
    const booted = await boot()
    try {
      await expect(booted.provider.search(PROJECT_A, 'x'.repeat(513)))
        .rejects.toThrow(/exceeds 512 characters/)
    } finally {
      await booted.done()
    }
  })

  it('stops scanning further entries once an earlier entry already filled the limit', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'first.md', 'needle one\nneedle two\n')
      await booted.provider.write(PROJECT_A, 'second.md', 'needle three\n')
      const matches = await booted.provider.search(PROJECT_A, 'needle', 2)
      expect(matches).toHaveLength(2)
      expect(matches.every(match => match.path === 'first.md')).toBe(true)
    } finally {
      await booted.done()
    }
  })

  it('skips an entry larger than the complete-entry limit during search without reading it', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT_A, 'small.md', 'needle here')
      const scope = (await readdir(booted.root))[0] as string
      // Bypass write()'s own size guard: a file can land on disk beyond
      // MAX_ENTRY_BYTES through means other than this provider (migrated
      // content, direct disk edits), and search() must still skip it by
      // size alone, never attempting to read it.
      await writeFile(join(booted.root, scope, 'oversized.md'), `needle\n${'x'.repeat(MAX_ENTRY_BYTES)}`, 'utf8')
      const matches = await booted.provider.search(PROJECT_A, 'needle')
      expect(matches.every(match => match.path === 'small.md')).toBe(true)
      expect(matches.some(match => match.path === 'oversized.md')).toBe(false)
    } finally {
      await booted.done()
    }
  })

  it('enforces the complete-entry byte bound on write', async () => {
    const booted = await boot()
    try {
      const oversized = 'x'.repeat(MAX_ENTRY_BYTES + 1)
      await expect(booted.provider.write(PROJECT_A, 'big.md', oversized))
        .rejects.toThrow(`complete-entry limit is ${String(MAX_ENTRY_BYTES)}`)
      await expect(booted.provider.list(PROJECT_A)).resolves.toEqual([])
    } finally {
      await booted.done()
    }
  })

  it('fails loud on an absent read, naming slug and path', async () => {
    const booted = await boot()
    try {
      await expect(booted.provider.read(PROJECT_A, 'ghost.md'))
        .rejects.toThrow(/^memory\(workspace-a-\w{6}\): no entry "ghost\.md"/)
    } finally {
      await booted.done()
    }
  })

  it('caps list() at MAX_LIST_ENTRIES even when more entries exist on disk', async () => {
    const booted = await boot()
    try {
      const total = MAX_LIST_ENTRIES + 1
      await Promise.all(
        Array.from({ length: total }, (_, index) => {
          const name = `n${String(index).padStart(5, '0')}.md`
          return booted.provider.write(PROJECT_A, name, 'x')
        }),
      )
      const entries = await booted.provider.list(PROJECT_A)
      expect(entries).toHaveLength(MAX_LIST_ENTRIES)
      const paths = entries.map(entry => entry.path)
      expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
    } finally {
      await booted.done()
    }
  }, 30_000)
})

describe('path jail', () => {
  it.each([
    '/etc/passwd',
    '../escape.md',
    'sub/../../escape.md',
    '..',
    'sub/../..',
    '..\\..\\win-style.md',
    '',
    '   ',
    './',
    'bad\0nul.md',
  ])('rejects %j before writing anything', async (badPath) => {
    const booted = await boot()
    try {
      await expect(booted.provider.write(PROJECT_A, badPath, 'x')).rejects.toThrow(/^memory:/)
      await expect(booted.provider.list(PROJECT_A)).resolves.toEqual([])
    } finally {
      await booted.done()
    }
  })

  it('rejects a path over MAX_ENTRY_PATH_LENGTH characters', async () => {
    const booted = await boot()
    try {
      await expect(booted.provider.write(PROJECT_A, 'x'.repeat(MAX_ENTRY_PATH_LENGTH + 1), 'x'))
        .rejects.toThrow(new RegExp(`exceeds ${String(MAX_ENTRY_PATH_LENGTH)} characters`))
    } finally {
      await booted.done()
    }
  })

  it('collapses redundant separators and current-directory segments', async () => {
    const booted = await boot()
    try {
      const result = await booted.provider.write(PROJECT_A, 'topic//v2././file.md', 'ok')
      expect(result.path).toBe('topic/v2./file.md')
      expect(await booted.provider.read(PROJECT_A, 'topic/v2./file.md')).toBe('ok')
    } finally {
      await booted.done()
    }
  })
})
