/** Copy-list parsing (gitignore syntax, v1 literal contract) and the bootstrap copy. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyListEntries, parseCopyList, readCopyList, WORKTREE_INCLUDE_FILENAME } from '../src/copy-list.ts'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-copylist-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('parseCopyList', () => {
  it('keeps literal paths, skips blanks and comments, and deduplicates', () => {
    expect(parseCopyList('\n# the env secrets\n.env\n  .env  \nconfig/app.json\n')).toEqual(['.env', 'config/app.json'])
  })

  it('rejects unsupported syntax with the offending line number', () => {
    for (const [line, detail] of [
      ['*.env', 'glob patterns are not supported'],
      ['assets/?', 'glob patterns are not supported'],
      ['!ignored', 'negation is not supported'],
      ['docs/', 'directory entries are not supported'],
      ['//anchored', 'entry must be a repo-root-relative file path'],
      ['../outside', 'entry must stay inside the repository'],
    ] as const) {
      const content = `.env\n${line}\n`
      expect(() => parseCopyList(content), line).toThrow(`${WORKTREE_INCLUDE_FILENAME} line 2: ${detail}`)
    }
  })

  it('honors a leading slash anchor as repo-root-relative', () => {
    expect(parseCopyList('/.env')).toEqual(['.env'])
  })
})

describe('readCopyList', () => {
  it('copies nothing when the list file does not exist', () => {
    expect(readCopyList(fixtureRoot())).toEqual([])
  })

  it('surfaces non-ENOENT read failures unchanged', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, WORKTREE_INCLUDE_FILENAME))
    expect(() => readCopyList(root)).toThrow()
  })

  it('reads the list from the repository root', () => {
    const root = fixtureRoot()
    writeFileSync(join(root, WORKTREE_INCLUDE_FILENAME), '.env\n', 'utf8')
    expect(readCopyList(root)).toEqual(['.env'])
  })
})

describe('copyListEntries', () => {
  it('copies listed files into the worktree, creating parent directories', () => {
    const root = fixtureRoot()
    const worktree = join(root, 'wt')
    writeFileSync(join(root, '.env'), 'KEY=value\n', 'utf8')
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'app.json'), '{}\n', 'utf8')
    expect(copyListEntries(root, worktree, ['.env', 'config/app.json'])).toEqual(['.env', 'config/app.json'])
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('KEY=value\n')
    expect(readFileSync(join(worktree, 'config', 'app.json'), 'utf8')).toBe('{}\n')
  })

  it('fails loud when a listed file is missing at the repo root', () => {
    const root = fixtureRoot()
    expect(() => copyListEntries(root, join(root, 'wt'), ['.env']))
      .toThrow(`${WORKTREE_INCLUDE_FILENAME} lists ".env" but the file does not exist at the repository root`)
  })

  it('surfaces non-ENOENT copy failures unchanged', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, '.env'))
    expect(() => copyListEntries(root, join(root, 'wt'), ['.env'])).toThrow()
  })
})
