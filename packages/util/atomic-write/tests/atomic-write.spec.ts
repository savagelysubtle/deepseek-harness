import { access, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
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
  // Faults the TEMP file's own sync (flags 'wx'), not the directory flush
  // (flags 'r') — this fires while `handle` is still open/truthy, inside the
  // writeFileAtomic try block, so the catch's cleanup must close that live handle.
  forceTempSyncFailure: false,
  // Faults the temp handle's own `close()` (flags 'wx') on top of a temp
  // sync failure, so the catch's best-effort `.close().catch(() => undefined)`
  // actually has something to swallow.
  forceTempCloseFailure: false,
  syncCalls: [] as string[],
  // withFileLock contention controls: a lock-sibling `wx` create rejects with
  // EEXIST either a bounded number of times (then falls through to the real
  // filesystem) or indefinitely, so the retry/backoff/timeout paths can be
  // driven under fake timers without ever creating a real contending holder.
  forceLockEexistCount: 0,
  forceLockAlwaysEexist: false,
  // Once `forceLockEexistCount` is spent, the lock-create write that would
  // otherwise fall through to the real filesystem instead resolves
  // immediately as a successful create — and the matching release `rm`
  // (tracked via `fakeHeldLockPath`) resolves immediately too — so neither
  // call touches the real filesystem. Only the fake-timer contention test
  // sets this: a real fs call awaited inside an advanced tick is
  // timing-dependent under load (SWD-80 lineage), so every call that tick
  // awaits must be mocked, including the one the EEXIST budget runs out on.
  fakeLockIoAfterBudget: false,
  fakeHeldLockPath: undefined as string | undefined,
  rmCalls: [] as string[],
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
              if (flags === 'wx' && fsControl.forceTempSyncFailure) {
                const error = new Error('simulated temp write failure: ENOSPC') as NodeJS.ErrnoException
                error.code = 'ENOSPC'
                throw error
              }
              return target.sync()
            }
          }
          if (prop === 'close' && flags === 'wx' && fsControl.forceTempCloseFailure) {
            return async (): Promise<void> => {
              const error = new Error('simulated temp close failure: EBADF') as NodeJS.ErrnoException
              error.code = 'EBADF'
              throw error
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
      const [path] = args
      fsControl.rmCalls.push(String(path))
      if (fsControl.forceRmFailure) throw new Error('simulated cleanup failure: permission denied')
      if (fsControl.fakeHeldLockPath !== undefined && path === fsControl.fakeHeldLockPath) {
        fsControl.fakeHeldLockPath = undefined
        return undefined
      }
      return actual.rm(...args)
    },
    async writeFile(...args: Parameters<typeof actual.writeFile>): ReturnType<typeof actual.writeFile> {
      const [path] = args
      if (typeof path === 'string' && path.endsWith('.lock')) {
        if (fsControl.forceLockAlwaysEexist || fsControl.forceLockEexistCount > 0) {
          if (fsControl.forceLockEexistCount > 0) fsControl.forceLockEexistCount -= 1
          const error = new Error('EEXIST: file already exists, open') as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }
        if (fsControl.fakeLockIoAfterBudget) {
          fsControl.fakeHeldLockPath = path
          return undefined
        }
      }
      return actual.writeFile(...args)
    },
  }
})

afterEach(() => {
  fsControl.forceRenameFailure = false
  fsControl.forceRmFailure = false
  fsControl.forceDirSyncUnsupported = false
  fsControl.forceDirSyncRealError = false
  fsControl.forceTempSyncFailure = false
  fsControl.forceTempCloseFailure = false
  fsControl.syncCalls.length = 0
  fsControl.forceLockEexistCount = 0
  fsControl.forceLockAlwaysEexist = false
  fsControl.fakeLockIoAfterBudget = false
  fsControl.fakeHeldLockPath = undefined
  fsControl.rmCalls.length = 0
  vi.useRealTimers()
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

  it('creates parent directories with the configured dirMode instead of the mkdir default', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600, dirMode: 0o700 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, 'nested', 'deep'))).mode & 0o777).toBe(0o700)
    }
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

  it('closes the still-open temp handle when the write itself fails before rename', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.forceTempSyncFailure = true
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 }))
      .rejects.toThrow(/simulated temp write failure/)
    // The failure happened before the rename, with the handle still open —
    // the catch's `if (handle) await handle.close()` must have run (a leaked
    // fd would otherwise block cleanup of the temp sibling below).
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('swallows a failure closing the still-open temp handle, surfacing only the original write error', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.forceTempSyncFailure = true
    fsControl.forceTempCloseFailure = true
    let caught: unknown
    try {
      await writeFileAtomic(target, 'content', { mode: 0o600 })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    // The original write failure — not the secondary close failure that
    // happened while cleaning up the still-open handle — is what reaches the caller.
    expect((caught as Error).message).toContain('simulated temp write failure')
    expect((caught as Error).message).not.toContain('simulated temp close failure')
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

  it('acquires an uncontended lock, runs the operation, and releases the lock on success', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    const lockPath = `${target}.lock`

    const result = await withFileLock(target, async () => 'the operation ran')
    expect(result).toBe('the operation ran')
    await expect(access(lockPath)).rejects.toThrow()
  })

  it('releases the lock even when the operation throws', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    const lockPath = `${target}.lock`

    await expect(withFileLock(target, async () => {
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    await expect(access(lockPath)).rejects.toThrow()
  })

  it(
    'retries past transient lock contention (EEXIST) and succeeds once the holder releases it',
    async () => {
      const dir = await scratch()
      const target = join(dir, 'doc.yaml')
      const lockPath = `${target}.lock`
      // Two forced EEXIST attempts, exercising the exponential backoff
      // (20ms, then 40ms) before the third `wx` create succeeds. The third
      // create (and its matching release) is served by the mock too — see
      // `fakeLockIoAfterBudget` — so no real fs call is ever awaited inside
      // an advanced fake-timer tick, which would be timing-dependent under
      // load (SWD-80 lineage).
      fsControl.forceLockEexistCount = 2
      fsControl.fakeLockIoAfterBudget = true

      vi.useFakeTimers()
      const resultPromise = withFileLock(target, async () => 'done')
      await vi.advanceTimersByTimeAsync(20)
      await vi.advanceTimersByTimeAsync(40)
      await expect(resultPromise).resolves.toBe('done')
      // Flush any lingering microtasks from the resolved promise chain
      // before switching back to real timers and asserting.
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()

      await expect(access(lockPath)).rejects.toThrow()
      expect(fsControl.rmCalls).toContain(lockPath)
    },
  )

  it('fails with a named timeout error when the lock is never released', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    fsControl.forceLockAlwaysEexist = true
    let ran = false

    vi.useFakeTimers()
    const resultPromise = withFileLock(target, async () => { ran = true })
    // Attach the rejection assertion before advancing the clock, so the
    // promise never has an instant where it is rejected with no handler
    // attached yet.
    const assertion = expect(resultPromise).rejects.toThrow(/timed out waiting for the writer lock/)
    // Exceeds the 2s deadline; the exponential backoff (20, 40, 80, 160,
    // 200, 200, ...) crosses it well before 2.5s of advanced virtual time.
    await vi.advanceTimersByTimeAsync(2_500)
    await assertion
    vi.useRealTimers()

    expect(ran).toBe(false)
    // A timed-out contender never held the lock, so it must not attempt to
    // release one — the holder it never acquired is not its to touch.
    expect(fsControl.rmCalls).toEqual([])
  })
})
