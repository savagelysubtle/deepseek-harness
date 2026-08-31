/** Registry mirror persistence: round-trip, fresh-root tolerance, and loud corruption. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRegistryFile, registryFilePath, saveRegistryFile } from '../src/registry-file.ts'
import type { WorktreeRow } from '../src/types.ts'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-worktree-registry-'))
  dirs.push(dir)
  return join(dir, 'registry.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    slug: 'm1a-1-ab12cd34' as WorktreeRow['slug'],
    seat: 'steve',
    branch: 'steve/m1a-1-ab12cd34',
    session: 'steve.m1a-1-ab12cd34',
    path: '/tmp/repo.worktrees/steve-m1a-1-ab12cd34',
    branchRef: 'master',
    createdAt: 1_700_000_000_000,
    lockReason: 'steve steve.m1a-1-ab12cd34',
    lastReason: 'ship the feature',
    ...overrides,
  }
}

describe('loadRegistryFile', () => {
  it('serves an empty registry when the file does not exist', () => {
    expect(loadRegistryFile(tempFile())).toEqual([])
  })

  it('round-trips rows through save', () => {
    const path = tempFile()
    const rows = [row(), row({ slug: 'm1a-2-ef56ab90' as WorktreeRow['slug'], lockReason: undefined, lastReason: undefined })]
    saveRegistryFile(path, rows)
    expect(loadRegistryFile(path)).toEqual(rows)
  })

  it('fails loud naming the file for malformed content', () => {
    const path = tempFile()
    writeFileSync(path, 'not json', 'utf8')
    expect(() => loadRegistryFile(path)).toThrow(`${path}: registry is not valid JSON`)
  })

  it('rejects wrong versions, non-object rows, and bad fields', () => {
    const path = tempFile()
    saveRegistryFile(path, [row()])
    writeFileSync(path, JSON.stringify({ version: 2, rows: [] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('registry version must be 1')
    writeFileSync(path, JSON.stringify({ version: 1, rows: 'nope' }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('registry rows must be an array')
    writeFileSync(path, JSON.stringify({ version: 1, rows: [{ slug: 'ok', createdAt: 1 }] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: seat must be a non-empty string')
    writeFileSync(path, JSON.stringify({ version: 1, rows: [{ slug: 'ok' }] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: createdAt must be a safe integer')
    writeFileSync(path, JSON.stringify({ version: 1, rows: [row({ lockReason: 5 as unknown as string })] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: lockReason must be a string when present')
    writeFileSync(path, JSON.stringify({ version: 1, rows: [row({ lastReason: 7 as unknown as string })] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: lastReason must be a string when present')
    writeFileSync(path, JSON.stringify({ version: 1, rows: ['not-an-object'] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: not an object')
    writeFileSync(path, JSON.stringify({ version: 1, rows: [row({ slug: 'BAD SLUG' as WorktreeRow['slug'] })] }), 'utf8')
    expect(() => loadRegistryFile(path)).toThrow('corrupt registry row 0: invalid worktree slug')
  })

  it('surfaces non-ENOENT read failures unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-worktree-registry-dir-'))
    dirs.push(dir)
    expect(() => loadRegistryFile(dir)).toThrow()
  })

  it('rejects valid JSON that is not an object', () => {
    const path = tempFile()
    writeFileSync(path, '5', 'utf8')
    expect(() => loadRegistryFile(path)).toThrow(`${path}: registry must be a JSON object`)
  })
})

describe('registryFilePath', () => {
  it('lives under the worktrees root', () => {
    expect(registryFilePath('/srv/repo.worktrees')).toBe(join('/srv/repo.worktrees', 'registry.json'))
  })
})
