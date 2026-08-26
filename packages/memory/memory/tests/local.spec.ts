/**
 * Local memory provider tests: round-trips, project scoping, path jail,
 * bounded results, and durable overwrite semantics against temp roots.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { LocalMemoryProvider } from '../src/local.ts'
import { MAX_ENTRY_BYTES } from '../src/scope.ts'

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
