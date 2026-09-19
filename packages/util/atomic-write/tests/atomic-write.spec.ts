import { lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

// Controls + call recorder for the node:fs/promises mock below, used only by
// the durability tests that must inject a filesystem failure no real
// temp-dir setup can trigger deterministically (a rename failure whose
// cleanup also fails; an unsupported or faulted directory fsync). Every
// other test in this file uses the real filesystem untouched — the mock
// delegates to the real implementation unless a control flag is set, and
// every test that sets one resets it in `afterEach`.
const fsControl = vi.hoisted(() => ({
  forceRenameFailure: false,
  forceRmFailure: false,
  forceDirSyncUnsupported: false,
  forceDirSyncRealError: false,
  syncCalls: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
      const [path, flags] = args
      const handle = await actual.open(...args)
      // Wrap only `sync` so every other FileHandle method (close, chmod,
      // writeFile, …) runs unmodified against the real handle.
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'sync') {
            return async (): Promise<void> => {
              fsControl.syncCalls.push(String(path))
              // Directory flushes open with flags 'r'; temp-file writes open
              // with 'wx'. Only the directory-flush sync is ever faulted.
              if (flags === 'r' && fsControl.forceDirSyncUnsupported) {
                const error = new Error('EINVAL: invalid argument, fsync') as NodeJS.ErrnoException
                error.code = 'EINVAL'
                throw error
              }
              if (flags === 'r' && fsControl.forceDirSyncRealError) {
                const error = new Error('simulated directory flush I/O failure: EIO') as NodeJS.ErrnoException
                error.code = 'EIO'
                throw error
              }
              return target.sync()
            }
          }
          // `Reflect.get` is typed `any`; narrow it before use so the proxy
          // stays type-safe and the lint baseline does not move.
          const value: unknown = Reflect.get(target, prop, receiver)
          if (typeof value !== 'function') return value
          return (value as (this: unknown, ...args: never[]) => unknown).bind(target)
        },
      })
    },
    async rename(...args: Parameters<typeof actual.rename>): ReturnType<typeof actual.rename> {
      if (fsControl.forceRenameFailure) throw new Error('simulated rename failure: disk full')
      return actual.rename(...args)
    },
    async rm(...args: Parameters<typeof actual.rm>): ReturnType<typeof actual.rm> {
      if (fsControl.forceRmFailure) throw new Error('simulated cleanup failure: permission denied')
      return actual.rm(...args)
    },
  }
})

afterEach(() => {
  fsControl.forceRenameFailure = false
  fsControl.forceRmFailure = false
  fsControl.forceDirSyncUnsupported = false
  fsControl.forceDirSyncRealError = false
  fsControl.syncCalls.length = 0
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('fsyncs the temp file and the containing directory (fails if either flush is removed)', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFileAtomic(target, 'content', { mode: 0o600 })
    // Exactly two syncs: the staged temp file, then the directory the
    // rename landed in. A regression that drops either flush drops a call
    // here, not just a byte in the file — reading the file back afterward
    // would pass against the broken (unflushed) implementation too.
    expect(fsControl.syncCalls).toHaveLength(2)
    expect(fsControl.syncCalls.some(path => path.includes('.tmp'))).toBe(true)
    expect(fsControl.syncCalls).toContain(dir)
  })

  it('surfaces the original rename failure, never a cleanup failure that masks it', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    fsControl.forceRenameFailure = true
    fsControl.forceRmFailure = true
    let caught: unknown
    try {
      await writeFileAtomic(target, 'content', { mode: 0o600 })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    // The rename failure — the actual reason the write failed — must reach
    // the caller...
    expect((caught as Error).message).toContain('simulated rename failure')
    // ...never masked by the unrelated failure of the best-effort temp-file
    // cleanup that ran afterward.
    expect((caught as Error).message).not.toContain('simulated cleanup failure')
  })

  it('still succeeds when the directory flush is unsupported (e.g. EINVAL under an overlay filesystem, or Windows)', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.forceDirSyncUnsupported = true
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).resolves.toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe('content')
  })

  it('surfaces a real directory-flush I/O failure rather than swallowing it', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.forceDirSyncRealError = true
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow(/simulated directory flush I\/O failure/)
  })
})

describe('withFileLock', () => {
  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })
})
