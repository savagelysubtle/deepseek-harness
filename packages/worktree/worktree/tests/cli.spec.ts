/**
 * The `dsh-worktree` CLI surface: argument parsing, the JSON output contract,
 * refusal formatting, and the stateless spawn → list → lock → unlock → remove
 * lifecycle across separate invocations against a real fixture repository
 * (the registry mirror carries rows between invocations).
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as cli from '../src/cli.ts'
import { parseWorktreeSlug } from '../src/slug.ts'
import type { WorktreeRow, WorktreeSpawnResult } from '../src/types.ts'

const execFileAsync = promisify(execFile)

const roots: string[] = []
const originalStdout = cli.internals.stdout
const originalStderr = cli.internals.stderr

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
})

afterEach(() => {
  cli.internals.stdout = originalStdout
  cli.internals.stderr = originalStderr
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-cli-'))
  roots.push(root)
  return root
}

interface Fixture {
  /** Parent fixture directory, removed on teardown. */
  root: string
  /** The real git repository the CLI addresses via `--repo-root`. */
  repoRoot: string
  /** The worktree parent directory the CLI addresses via `--worktrees-root`. */
  worktreesRoot: string
}

/** Real git repository with one commit; the CLI runs against it via flags. */
async function fixture(): Promise<Fixture> {
  const root = tempRoot()
  const repoRoot = join(root, 'repo')
  const worktreesRoot = join(root, 'wt-root')
  await execFileAsync('git', ['init', '-b', 'master', repoRoot], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
  writeFileSync(join(repoRoot, 'README.md'), 'fixture\n', 'utf8')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
  return { root, repoRoot, worktreesRoot }
}

/** Run one CLI invocation in-process, capturing both output streams. */
async function run(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  cli.internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  cli.internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
  const code = await cli.runWorktreeCli([...argv])
  return { code, out, err }
}

describe('argument parsing', () => {
  it('parses every subcommand with its required and optional flags', () => {
    expect(cli.parseWorktreeCliArgs(['spawn', '--seat', 'steve', '--intent', 'ship it', '--main-ref', 'develop']))
      .toEqual({ kind: 'spawn', seat: 'steve', intent: 'ship it', mainRef: 'develop' })
    expect(cli.parseWorktreeCliArgs(['list'])).toEqual({ kind: 'list' })
    const slug = parseWorktreeSlug('m1a-9-deadbeef')
    expect(cli.parseWorktreeCliArgs(['lock', '--slug', slug, '--reason', 'round one']))
      .toEqual({ kind: 'lock', slug, reason: 'round one' })
    expect(cli.parseWorktreeCliArgs(['unlock', '--slug', slug, '--reason', 'r']).kind).toBe('unlock')
    expect(cli.parseWorktreeCliArgs(['remove', '--slug', slug, '--reason', 'r']).kind).toBe('remove')
  })

  it('selects help from --help or -h anywhere in the argv', () => {
    expect(cli.parseWorktreeCliArgs(['--help'])).toEqual({ kind: 'help' })
    expect(cli.parseWorktreeCliArgs(['spawn', '--seat', 'steve', '--help'])).toEqual({ kind: 'help' })
  })

  it('refuses unknown flags, missing values, missing flags, and malformed slugs', () => {
    expect(() => cli.parseWorktreeCliArgs(['list', '--wat'])).toThrow('unknown argument: --wat')
    expect(() => cli.parseWorktreeCliArgs(['spawn', '--seat'])).toThrow('missing value for --seat')
    expect(() => cli.parseWorktreeCliArgs(['spawn', '--seat', 'steve'])).toThrow('missing required flag --intent')
    expect(() => cli.parseWorktreeCliArgs(['lock', '--slug', 'NOT A SLUG', '--reason', 'r']))
      .toThrow('invalid worktree slug')
    expect(() => cli.parseWorktreeCliArgs([])).toThrow('usage: dsh-worktree')
  })
})

describe('invocation output contract', () => {
  it('prints usage on stdout and exits 0 for --help', async () => {
    const { code, out, err } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toBe(cli.USAGE)
    expect(err).toBe('')
  })

  it('prints the usage text with exactly one trailing newline', () => {
    expect(cli.USAGE.endsWith('\n')).toBe(true)
    expect(cli.USAGE.endsWith('\n\n')).toBe(false)
  })

  it('prints a parse refusal on stderr and exits 1 before any service is built', async () => {
    const { root, repoRoot } = await fixture()
    const { code, out, err } = await run(['list', '--wat', '--repo-root', repoRoot])
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('unknown argument: --wat')
    // The parse fails before construction, so the default worktrees sibling
    // (created at service mount with persistence on) is never made.
    expect(existsSync(join(root, 'repo.worktrees'))).toBe(false)
  })
})

describe('stateless lifecycle over real git', () => {
  it('spawns through the CLI and prints the spawn result JSON', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    const { code, out, err } = await run([
      'spawn', '--seat', 'steve', '--intent', 'ship the login fix',
      '--repo-root', repoRoot, '--worktrees-root', worktreesRoot,
    ])
    expect(code).toBe(0)
    expect(err).toBe('')
    const result = JSON.parse(out) as WorktreeSpawnResult
    expect(result.seat).toBe('steve')
    expect(result.branch).toBe(`steve/${result.slug}`)
    expect(result.session).toBe(`steve.${result.slug}`)
    expect(result.path).toBe(join(worktreesRoot, `steve-${result.slug}`))
    expect(result.branchRef).toBe('master')
    expect(result.lockReason).toBe(`steve ${result.session}`)
    expect(existsSync(result.path)).toBe(true)
    // The registry mirror carries the row to the next invocation.
    const persisted = JSON.parse(readFileSync(join(worktreesRoot, 'registry.json'), 'utf8')) as { rows: WorktreeRow[] }
    expect(persisted.rows.map(row => row.slug)).toEqual([result.slug])
  })

  it('lists rows minted by an earlier invocation', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    const flags = ['--repo-root', repoRoot, '--worktrees-root', worktreesRoot]
    const spawn = await run(['spawn', '--seat', 'steve', '--intent', 'work', ...flags])
    const minted = JSON.parse(spawn.out) as WorktreeSpawnResult

    const { code, out } = await run(['list', ...flags])
    expect(code).toBe(0)
    const rows = JSON.parse(out) as WorktreeRow[]
    expect(rows.map(row => row.slug)).toEqual([minted.slug])
    expect(rows[0]?.seat).toBe('steve')
    expect(rows[0]?.lockReason).toBe(`steve ${minted.session}`)
  })

  it('walks spawn → unlock → lock → unlock → remove across invocations', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    const flags = ['--repo-root', repoRoot, '--worktrees-root', worktreesRoot]
    const spawn = await run(['spawn', '--seat', 'steve', '--intent', 'work', ...flags])
    const { slug } = JSON.parse(spawn.out) as WorktreeSpawnResult

    // Born locked: re-locking refuses with the creation reason, code first.
    const relock = await run(['lock', '--slug', slug, '--reason', 'again', ...flags])
    expect(relock.code).toBe(1)
    expect(relock.err).toContain('ALREADY_LOCKED: ')
    expect(relock.err).toContain('is already locked')

    const unlocked = await run(['unlock', '--slug', slug, '--reason', 'round one starting', ...flags])
    expect(unlocked.code).toBe(0)
    const unlockedRow = JSON.parse(unlocked.out) as WorktreeRow
    expect(unlockedRow.slug).toBe(slug)
    expect(unlockedRow.lockReason).toBeUndefined()
    expect(unlockedRow.lastReason).toBe('round one starting')

    const locked = await run(['lock', '--slug', slug, '--reason', 'round two', ...flags])
    expect(locked.code).toBe(0)
    expect((JSON.parse(locked.out) as WorktreeRow).lockReason).toBe('round two')

    const removeLocked = await run(['remove', '--slug', slug, '--reason', 'too soon', ...flags])
    expect(removeLocked.code).toBe(1)
    expect(removeLocked.err).toContain('LOCKED: ')

    await run(['unlock', '--slug', slug, '--reason', 'work merged', ...flags])
    const removed = await run(['remove', '--slug', slug, '--reason', 'cleanup', ...flags])
    expect(removed.code).toBe(0)
    expect(JSON.parse(removed.out)).toEqual({ removed: slug })

    const empty = await run(['list', ...flags])
    expect(JSON.parse(empty.out)).toEqual([])
  })

  it('refuses an unknown slug with the seam NO_ROW code', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    const { code, err } = await run([
      'unlock', '--slug', 'm1a-9-deadbeef', '--reason', 'r',
      '--repo-root', repoRoot, '--worktrees-root', worktreesRoot,
    ])
    expect(code).toBe(1)
    expect(err).toContain('NO_ROW: ')
    expect(err).toContain('no live worktree carries slug')
  })

  it('honors --main-ref over the configured default', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    await execFileAsync('git', ['branch', 'develop'], { cwd: repoRoot })
    const { code, out } = await run([
      'spawn', '--seat', 'steve', '--intent', 'work', '--main-ref', 'develop',
      '--repo-root', repoRoot, '--worktrees-root', worktreesRoot,
    ])
    expect(code).toBe(0)
    expect((JSON.parse(out) as WorktreeSpawnResult).branchRef).toBe('develop')
  })
})

describe('configuration and environment refusals', () => {
  it('defaults the repo root to the current directory', async () => {
    const { root, repoRoot } = await fixture()
    const worktreesRoot = join(root, 'cwd-wt-root')
    const previousCwd = process.cwd()
    process.chdir(repoRoot)
    try {
      const { code, out } = await run(['spawn', '--seat', 'steve', '--intent', 'work', '--worktrees-root', worktreesRoot])
      expect(code).toBe(0)
      const result = JSON.parse(out) as WorktreeSpawnResult
      expect(result.branchRef).toBe('master')
      expect(result.path).toBe(join(worktreesRoot, `steve-${result.slug}`))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('reports a nonexistent --repo-root on stderr and exits 1', async () => {
    const { code, out, err } = await run(['list', '--repo-root', '/definitely/not/a/real/dir-cli'])
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('is not an existing directory')
  })

  it('surfaces the env gate as an ENV_MISSING refusal for spawn only', async () => {
    const { repoRoot, worktreesRoot } = await fixture()
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const spawn = await run([
      'spawn', '--seat', 'steve', '--intent', 'work',
      '--repo-root', repoRoot, '--worktrees-root', worktreesRoot,
    ])
    expect(spawn.code).toBe(1)
    expect(spawn.err).toContain('ENV_MISSING: ')
    expect(spawn.err).toContain('DEEPSEEK_API_KEY')
    // The gate lives in spawn; listing the empty registry needs no key.
    const listed = await run(['list', '--repo-root', repoRoot, '--worktrees-root', worktreesRoot])
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out)).toEqual([])
  })
})

describe('bin entry resolution', () => {
  /** The CLI module's URL, the second argument the bin guard passes. */
  const entryUrl = pathToFileURL(join(import.meta.dirname, '../src/cli.ts')).href

  it('matches the entry by direct path and through a symlink', () => {
    const dir = tempRoot()
    const direct = join(import.meta.dirname, '../src/cli.ts')
    expect(cli.isEntryInvocation(direct, entryUrl)).toBe(true)
    // The invoked spelling resolves to the same file, so it matches — the
    // case an unresolved URL comparison silently fails on.
    const linkPath = join(dir, 'alias.ts')
    symlinkSync(realpathSync(direct), linkPath)
    expect(cli.isEntryInvocation(linkPath, entryUrl)).toBe(true)
  })

  it('answers false for another module and for a missing file without throwing', () => {
    const dir = tempRoot()
    // This spec is a real, existing file that is not the entry module.
    expect(cli.isEntryInvocation(join(import.meta.dirname, 'cli.spec.ts'), entryUrl)).toBe(false)
    expect(cli.isEntryInvocation(join(dir, 'missing.ts'), entryUrl)).toBe(false)
  })

  it('runs the real bin entry: --help prints usage and exits 0', () => {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', join(import.meta.dirname, '../src/cli.ts'), '--help'],
      { encoding: 'utf8' },
    )
    expect(stdout).toBe(cli.USAGE)
  })
})
