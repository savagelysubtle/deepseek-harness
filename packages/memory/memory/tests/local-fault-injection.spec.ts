/**
 * Fault-injection coverage for `local.ts` branches that no real filesystem
 * setup can isolate cleanly, plus branches that guard against a shape the
 * real `node:fs/promises` API never actually produces:
 *
 * - A directory's write permission gates both `link()` (adding a retained
 *   copy) and `unlink()` (pruning an old one) identically — chmod cannot
 *   fail the prune step alone while letting the same write's own retain
 *   step succeed (verified by hand: see `packages/memory/memory/tests/`
 *   PR discussion). A targeted failure on `unlink()` is the only way in.
 * - `error instanceof Error ? error.message : error` guards exist at every
 *   call site that talks to `node:fs/promises`, but that API always rejects
 *   with a genuine `Error`/`NodeJS.ErrnoException` — the `: error` side is
 *   unreachable through real I/O and only exercisable by injecting a
 *   non-Error rejection.
 *
 * Every mocked function delegates to the real implementation unless a test
 * has set the matching control flag, so every write in this file still
 * lands on disk — only the one injected failure per test is synthetic.
 * Flags are reset in `afterEach`; each test sets only the flag(s) its own
 * scenario needs, keyed to a path suffix distinct enough not to catch any
 * other call the same write() makes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { LocalMemoryProvider, MAX_RETAINED_VERSIONS } from '../src/local.ts'
import { projectSlug } from '../src/scope.ts'

const PROJECT = '/tmp/fictional/fault-injection-workspace'

const state = vi.hoisted(() => ({
  /** readFile: throw once (generic, non-ENOENT) for a path ending in this suffix, then delegate. */
  failReadOnceSuffix: undefined as string | undefined,
  /** readFile: always return this fixed content for a path ending in this suffix. */
  fixedReadSuffix: undefined as string | undefined,
  fixedReadValue: undefined as string | undefined,
  /** readFile: always throw ENOENT for a path ending in this suffix. */
  failReadEnoentSuffix: undefined as string | undefined,
  /** readFile: always throw with this code for a path ending in this suffix. */
  failReadErrorCodeSuffix: undefined as string | undefined,
  failReadErrorCode: undefined as string | undefined,
  /** readFile: always reject with a non-Error value for a path ending in this suffix. */
  failReadNonErrorSuffix: undefined as string | undefined,

  /** unlink: throw once (generic) for a path ending in this suffix, then delegate. */
  failUnlinkOnceSuffix: undefined as string | undefined,
  /** unlink: always throw ENOENT for a path ending in this suffix. */
  failUnlinkEnoentSuffix: undefined as string | undefined,
  /** unlink: always throw with this code for a path ending in this suffix. */
  failUnlinkErrorCodeSuffix: undefined as string | undefined,
  failUnlinkErrorCode: undefined as string | undefined,
  /** Counts every unlink call that matched failUnlinkErrorCodeSuffix, so a test can assert the
   *  acquire loop polled a bounded number of times rather than spinning. */
  failUnlinkErrorCodeCallCount: 0,
  /** unlink: always throw a plain Error carrying no `code` property, for a path ending in this
   *  suffix — exercises the acquire-timeout diagnostic's fallback when `.code` is undefined. */
  failUnlinkNoCodeSuffix: undefined as string | undefined,
  /** unlink: always throw (generic) for a path containing this substring. */
  failUnlinkContains: undefined as string | undefined,

  /** rename: always throw for a call whose destination ends in this suffix. */
  failRenameSuffix: undefined as string | undefined,
  /** writeFile: always throw for a non-temp path ending in this suffix (the rename fallback). */
  failWriteFileTargetSuffix: undefined as string | undefined,

  /** stat: always reject with a non-Error value for a path ending in this suffix. */
  failStatNonErrorSuffix: undefined as string | undefined,
  /** stat: always throw with this code for a path ending in this suffix. */
  failStatErrorCodeSuffix: undefined as string | undefined,
  failStatErrorCode: undefined as string | undefined,
  /** link: always reject with a non-Error value when the new-path argument contains this substring. */
  failLinkNonErrorContains: undefined as string | undefined,
  /** open: always reject with a non-Error value for a path ending in this suffix. */
  failOpenNonErrorSuffix: undefined as string | undefined,
  /** open: always throw with this code for a path ending in this suffix. */
  failOpenErrorCodeSuffix: undefined as string | undefined,
  failOpenErrorCode: undefined as string | undefined,
  /** open: always (persistently, not one-shot) throw EEXIST for a path ending in this suffix — simulates a
   *  contended lock file without ever touching real disk. */
  alwaysFailOpenEexistSuffix: undefined as string | undefined,
  /** open: throw EEXIST once for a path ending in this suffix, then delegate — simulates a lock file that
   *  appears contended on the first attempt (so the abandoned-lock branch runs) but was never actually
   *  created on real disk, so the real readFile/unlink calls against it genuinely reject ENOENT. */
  failOpenEexistOnceSuffix: undefined as string | undefined,
  /** mkdir: resolve immediately without touching real disk for a path starting with this prefix (write()
   *  mkdir's both the entry's own directory and the lock directory — both land under one scope dir). */
  alwaysResolveMkdirPrefix: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      // Every real call site in local.ts passes a string path with 'utf8'
      // encoding; only readFile's type signature also admits a FileHandle.
      const [path] = args
      const p = path as string
      if (state.failReadOnceSuffix !== undefined && p.endsWith(state.failReadOnceSuffix)) {
        state.failReadOnceSuffix = undefined
        throw Object.assign(new Error('EIO: injected one-shot read failure'), { code: 'EIO' })
      }
      if (state.fixedReadSuffix !== undefined && p.endsWith(state.fixedReadSuffix)) {
        return state.fixedReadValue
      }
      if (state.failReadEnoentSuffix !== undefined && p.endsWith(state.failReadEnoentSuffix)) {
        throw Object.assign(new Error('ENOENT: injected read failure'), { code: 'ENOENT' })
      }
      if (state.failReadErrorCodeSuffix !== undefined && p.endsWith(state.failReadErrorCodeSuffix)) {
        throw Object.assign(new Error(`injected read failure (${String(state.failReadErrorCode)})`), { code: state.failReadErrorCode })
      }
      if (state.failReadNonErrorSuffix !== undefined && p.endsWith(state.failReadNonErrorSuffix)) {
        throw 'injected non-Error read failure'
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
    unlink: (async (...args: Parameters<typeof actual.unlink>) => {
      const [path] = args
      const p = String(path)
      if (state.failUnlinkOnceSuffix !== undefined && p.endsWith(state.failUnlinkOnceSuffix)) {
        state.failUnlinkOnceSuffix = undefined
        throw Object.assign(new Error('EIO: injected one-shot unlink failure'), { code: 'EIO' })
      }
      if (state.failUnlinkEnoentSuffix !== undefined && p.endsWith(state.failUnlinkEnoentSuffix)) {
        throw Object.assign(new Error('ENOENT: injected unlink failure'), { code: 'ENOENT' })
      }
      if (state.failUnlinkErrorCodeSuffix !== undefined && p.endsWith(state.failUnlinkErrorCodeSuffix)) {
        state.failUnlinkErrorCodeCallCount += 1
        throw Object.assign(
          new Error(`injected unlink failure (${String(state.failUnlinkErrorCode)})`),
          { code: state.failUnlinkErrorCode },
        )
      }
      if (state.failUnlinkNoCodeSuffix !== undefined && p.endsWith(state.failUnlinkNoCodeSuffix)) {
        throw new Error('boom')
      }
      if (state.failUnlinkContains !== undefined && p.includes(state.failUnlinkContains)) {
        throw Object.assign(new Error('ENOSPC: injected prune-unlink failure'), { code: 'ENOSPC' })
      }
      return actual.unlink(...args)
    }),
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      const [, dest] = args
      const d = String(dest)
      if (state.failRenameSuffix !== undefined && d.endsWith(state.failRenameSuffix)) {
        throw Object.assign(new Error('EXDEV: injected rename failure'), { code: 'EXDEV' })
      }
      return actual.rename(...args)
    }),
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      // Every real call site in local.ts passes a string path; only
      // writeFile's type signature also admits a FileHandle.
      const [path] = args
      const p = path as string
      if (
        state.failWriteFileTargetSuffix !== undefined
        && p.endsWith(state.failWriteFileTargetSuffix)
        && !p.includes('.memory-tmp-')
      ) {
        throw Object.assign(new Error('ENOSPC: injected fallback-write failure'), { code: 'ENOSPC' })
      }
      return actual.writeFile(...args)
    }) as typeof actual.writeFile,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      const [path] = args
      const p = String(path)
      if (state.failStatNonErrorSuffix !== undefined && p.endsWith(state.failStatNonErrorSuffix)) {
        throw 'injected non-Error stat failure'
      }
      if (state.failStatErrorCodeSuffix !== undefined && p.endsWith(state.failStatErrorCodeSuffix)) {
        throw Object.assign(
          new Error(`injected stat failure (${String(state.failStatErrorCode)})`),
          { code: state.failStatErrorCode },
        )
      }
      return actual.stat(...args)
    }) as typeof actual.stat,
    link: (async (...args: Parameters<typeof actual.link>) => {
      const [, newPath] = args
      const p = String(newPath)
      if (state.failLinkNonErrorContains !== undefined && p.includes(state.failLinkNonErrorContains)) {
        throw 'injected non-Error link failure'
      }
      return actual.link(...args)
    }),
    open: (async (...args: Parameters<typeof actual.open>) => {
      const [path] = args
      const p = String(path)
      if (state.alwaysFailOpenEexistSuffix !== undefined && p.endsWith(state.alwaysFailOpenEexistSuffix)) {
        throw Object.assign(new Error('EEXIST: injected persistent open failure'), { code: 'EEXIST' })
      }
      if (state.failOpenEexistOnceSuffix !== undefined && p.endsWith(state.failOpenEexistOnceSuffix)) {
        state.failOpenEexistOnceSuffix = undefined
        throw Object.assign(new Error('EEXIST: injected one-shot open failure'), { code: 'EEXIST' })
      }
      if (state.failOpenNonErrorSuffix !== undefined && p.endsWith(state.failOpenNonErrorSuffix)) {
        throw 'injected non-Error open failure'
      }
      if (state.failOpenErrorCodeSuffix !== undefined && p.endsWith(state.failOpenErrorCodeSuffix)) {
        throw Object.assign(
          new Error(`injected open failure (${String(state.failOpenErrorCode)})`),
          { code: state.failOpenErrorCode },
        )
      }
      return actual.open(...args)
    }),
    mkdir: (async (...args: Parameters<typeof actual.mkdir>) => {
      const [path] = args
      const p = String(path)
      if (state.alwaysResolveMkdirPrefix !== undefined && p.startsWith(state.alwaysResolveMkdirPrefix)) {
        return undefined
      }
      return actual.mkdir(...args)
    }) as typeof actual.mkdir,
  }
})

afterEach(() => {
  state.failReadOnceSuffix = undefined
  state.fixedReadSuffix = undefined
  state.fixedReadValue = undefined
  state.failReadEnoentSuffix = undefined
  state.failReadErrorCodeSuffix = undefined
  state.failReadErrorCode = undefined
  state.failReadNonErrorSuffix = undefined
  state.failUnlinkOnceSuffix = undefined
  state.failUnlinkEnoentSuffix = undefined
  state.failUnlinkErrorCodeSuffix = undefined
  state.failUnlinkErrorCode = undefined
  state.failUnlinkErrorCodeCallCount = 0
  state.failUnlinkNoCodeSuffix = undefined
  state.failUnlinkContains = undefined
  state.failRenameSuffix = undefined
  state.failWriteFileTargetSuffix = undefined
  state.failStatNonErrorSuffix = undefined
  state.failStatErrorCodeSuffix = undefined
  state.failStatErrorCode = undefined
  state.failLinkNonErrorContains = undefined
  state.failOpenNonErrorSuffix = undefined
  state.failOpenErrorCodeSuffix = undefined
  state.failOpenErrorCode = undefined
  state.alwaysFailOpenEexistSuffix = undefined
  state.failOpenEexistOnceSuffix = undefined
  state.alwaysResolveMkdirPrefix = undefined
})

/** One fresh provider over a fresh temp root; `done()` removes the root. */
interface Booted {
  provider: LocalMemoryProvider
  root: string
  done: () => Promise<void>
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-fault-'))
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

/** The scope directory `PROJECT` will resolve to, computed without requiring it to exist yet. */
function scopeDirForProject(root: string): string {
  return join(root, projectSlug(PROJECT))
}

/**
 * Flushes the microtask queue well past any realistic promise-chain depth.
 * `Promise.resolve()` never touches a timer (fake or real) or the event
 * loop's I/O phases, so looping it is exactly as deterministic as a single
 * microtask flush, just with enough rounds to outlast the chain.
 */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

describe('acquireEntryLock fault injection', () => {
  it('wraps a non-Error rejection creating the lock file in the usual "could not create" message', async () => {
    const booted = await boot()
    try {
      state.failOpenNonErrorSuffix = 'nonerror-open.md.lock'
      await expect(booted.provider.write(PROJECT, 'nonerror-open.md', 'content'))
        .rejects.toThrow(/could not create the write lock for "nonerror-open\.md" \(injected non-Error open failure\)/)
    } finally {
      await booted.done()
    }
  })

  it('fails loud, naming the entry, when the write lock cannot even be created (EACCES, not EEXIST)', async () => {
    const booted = await boot()
    try {
      // Moved here from the chmod-based version in local-retention.spec.ts:
      // a real chmod denies root's own writes too, so running the suite as
      // root silently turned this into a no-op instead of exercising the
      // EACCES path. Injecting the error code directly is deterministic
      // regardless of who runs the suite.
      state.failOpenErrorCodeSuffix = 'unlockable.md.lock'
      state.failOpenErrorCode = 'EACCES'
      await expect(booted.provider.write(PROJECT, 'unlockable.md', 'y'))
        .rejects.toThrow(/could not create the write lock for "unlockable\.md" \(injected open failure \(EACCES\)\)/)
    } finally {
      await booted.done()
    }
  })

  it('treats a lock file it cannot even read as abandoned rather than wedging the write', async () => {
    const booted = await boot()
    try {
      const scope = scopeDirForProject(booted.root)
      const lockPath = join(scope, '.locks', 'readfail-acquire.md.lock')
      await mkdir(join(lockPath, '..'), { recursive: true })
      // Real, present lock file — contention is real; only the read of it
      // (inside entryLockHolderLive) is injected to fail once.
      await writeFile(lockPath, JSON.stringify({ pid: 1 }), 'utf8')
      state.failReadOnceSuffix = 'readfail-acquire.md.lock'
      const result = await booted.provider.write(PROJECT, 'readfail-acquire.md', 'content')
      expect(result.replaced).toBeUndefined()
      expect(await booted.provider.read(PROJECT, 'readfail-acquire.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })

  it('retries past a failed (non-ENOENT) cleanup unlink of an abandoned lock instead of giving up', async () => {
    const booted = await boot()
    try {
      const scope = scopeDirForProject(booted.root)
      const lockPath = join(scope, '.locks', 'unlinkfail-abandoned.md.lock')
      await mkdir(join(lockPath, '..'), { recursive: true })
      // A pid this large can never be a live process, so this lock reads as
      // abandoned on the real (non-mocked) read; only its cleanup unlink is
      // injected to fail once, with a non-ENOENT code (EIO) — that falls
      // through to the same poll delay a live-holder retry uses, so this
      // write waits out one real LOCK_POLL_INTERVAL_MS before the second
      // iteration's unlink succeeds for real, rather than retrying instantly.
      await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647 }), 'utf8')
      state.failUnlinkOnceSuffix = 'unlinkfail-abandoned.md.lock'
      const result = await booted.provider.write(PROJECT, 'unlinkfail-abandoned.md', 'content')
      expect(result.replaced).toBeUndefined()
      expect(await booted.provider.read(PROJECT, 'unlinkfail-abandoned.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })

  it('fails loud after the acquire timeout when a genuinely live process still holds the lock', async () => {
    const booted = await boot()
    try {
      // Moved here from the real-fs version in local-retention.spec.ts: that
      // version left open() and readFile() real, so every poll iteration did
      // genuine (if small) libuv work alongside the faked 20ms delay(). Under
      // CPU load the real I/O fell behind the virtual clock's stepped
      // advances and the loop never observed the deadline within the step
      // budget — settled stayed undefined and the test timed out.
      //
      // write() and acquireEntryLock each start with a real await too —
      // write() mkdir's the entry's own directory before even computing the
      // lock path, and acquireEntryLock mkdir's the lock directory before
      // its loop or deadline exist — so both needed mocking: an
      // advanceTimersByTimeAsync call made before one of those real mkdir
      // continuations gets a turn finds no fake timer registered yet and
      // advances nothing, which is what made earlier stepped attempts need
      // an ever-larger step budget instead of a fixed one. With mkdir, open
      // and readFile all mocked, nothing on the awaited path is real I/O, so
      // the whole loop is pure microtask + fake-timer resolution and a
      // single bounded advance is deterministic.
      // This test process's own pid is genuinely alive for the whole test,
      // so the holder-liveness check (a synchronous process.kill(pid, 0)
      // probe, not filesystem-based) stays real rather than mocked.
      state.alwaysResolveMkdirPrefix = scopeDirForProject(booted.root)
      state.alwaysFailOpenEexistSuffix = 'contended.md.lock'
      state.fixedReadSuffix = 'contended.md.lock'
      state.fixedReadValue = JSON.stringify({ pid: process.pid })
      vi.useFakeTimers()
      try {
        const writing = booted.provider.write(PROJECT, 'contended.md', 'new content')
        let settled: unknown
        writing.then(
          (value) => { settled = { ok: true, value } },
          (error: unknown) => { settled = { ok: false, error } },
        )
        // One jump spanning the acquire timeout plus one more poll interval
        // (matching local.ts's LOCK_ACQUIRE_TIMEOUT_MS and
        // LOCK_POLL_INTERVAL_MS), then a microtask flush so the loop's final
        // iteration — including the throw and the write() promise's own
        // rejection — has actually run before asserting.
        await vi.advanceTimersByTimeAsync(5_000 + 20)
        await flushMicrotasks()
        expect(settled).toMatchObject({ ok: false })
        const { error } = settled as { ok: false; error: unknown }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(
          /could not acquire the write lock for "contended\.md" — another process is still writing it after waiting 5000ms/,
        )
      } finally {
        vi.useRealTimers()
      }
    } finally {
      await booted.done()
    }
  })

  it('fails loud, naming the entry, the lock path, and the last unlink error code, when an abandoned lock can never be removed', async () => {
    const booted = await boot()
    try {
      // Same deterministic-loop setup as the live-holder timeout test above:
      // mkdir, open and readFile are all mocked so nothing on the awaited
      // path is real I/O, letting a single bounded fake-timer advance carry
      // the whole poll loop through to its deadline.
      state.alwaysResolveMkdirPrefix = scopeDirForProject(booted.root)
      state.alwaysFailOpenEexistSuffix = 'unremovable.md.lock'
      // A pid this large can never be a live process (same value the
      // real-fs "retries past a failed cleanup unlink" test above uses), so
      // this lock reads as abandoned on every iteration — the branch under
      // test, not the live-holder one.
      state.fixedReadSuffix = 'unremovable.md.lock'
      state.fixedReadValue = JSON.stringify({ pid: 2_147_483_647 })
      // The cleanup unlink never succeeds — stands in for a directory
      // occupying the lock path, or a permission that blocks unlink but not
      // open/readFile.
      state.failUnlinkErrorCodeSuffix = 'unremovable.md.lock'
      state.failUnlinkErrorCode = 'EPERM'
      vi.useFakeTimers()
      try {
        const writing = booted.provider.write(PROJECT, 'unremovable.md', 'new content')
        let settled: unknown
        writing.then(
          (value) => { settled = { ok: true, value } },
          (error: unknown) => { settled = { ok: false, error } },
        )
        // One jump spanning the acquire timeout plus one more poll interval,
        // then a microtask flush so the loop's final iteration — including
        // the throw and the write() promise's own rejection — has actually
        // run before asserting.
        await vi.advanceTimersByTimeAsync(5_000 + 20)
        await flushMicrotasks()
        expect(settled).toMatchObject({ ok: false })
        const { error } = settled as { ok: false; error: unknown }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(
          /could not acquire the write lock for "unremovable\.md" — the abandoned/,
        )
        expect((error as Error).message).toMatch(
          /lock at ".*unremovable\.md\.lock" could not be removed after waiting/,
        )
        expect((error as Error).message).toMatch(/5000ms \(last unlink error: EPERM\)/)
        // Bounded polling: roughly timeout / poll-interval (5000 / 20 = 250)
        // attempts, not an unbounded spin.
        expect(state.failUnlinkErrorCodeCallCount).toBeGreaterThan(0)
        expect(state.failUnlinkErrorCodeCallCount).toBeLessThan(500)
      } finally {
        vi.useRealTimers()
      }
    } finally {
      await booted.done()
    }
  })

  it('retries past an ENOENT unlink race on an abandoned lock without taking the poll delay', async () => {
    const booted = await boot()
    try {
      // The lock file is only ever pretended to exist: the one-shot EEXIST
      // injection makes the first open() attempt believe it is contended,
      // but nothing was ever actually written to disk at lockPath. So the
      // real (unmocked) readFile inside entryLockHolderLive genuinely
      // rejects ENOENT — read as "not live" (abandoned), same as any other
      // read failure — and the real (unmocked) unlink that follows also
      // genuinely rejects ENOENT. That is exactly the branch under test:
      // treated as a race already won by another taker, not a removal
      // failure, so it must continue immediately rather than fall through
      // to the deadline/poll-delay path. The second, delegated open() call
      // then genuinely succeeds, since nothing was ever there to begin with.
      state.failOpenEexistOnceSuffix = 'enoent-race.md.lock'
      vi.useFakeTimers()
      try {
        // Fake timers make delay()'s setTimeout never fire on its own: if
        // the ENOENT branch still fell through to the poll delay, this
        // await would hang until Vitest's own test timeout instead of
        // settling — there is no advanceTimersByTimeAsync call here at all.
        const result = await booted.provider.write(PROJECT, 'enoent-race.md', 'content')
        expect(result.replaced).toBeUndefined()
        expect(await booted.provider.read(PROJECT, 'enoent-race.md')).toBe('content')
      } finally {
        vi.useRealTimers()
      }
    } finally {
      await booted.done()
    }
  })

  it('falls back to the unlink error itself in the acquire-timeout diagnostic when it carries no error code', async () => {
    const booted = await boot()
    try {
      state.alwaysResolveMkdirPrefix = scopeDirForProject(booted.root)
      state.alwaysFailOpenEexistSuffix = 'codeless.md.lock'
      state.fixedReadSuffix = 'codeless.md.lock'
      state.fixedReadValue = JSON.stringify({ pid: 2_147_483_647 })
      // A plain Error with no `code` property at all — the diagnostic must
      // still name something useful instead of printing "undefined".
      state.failUnlinkNoCodeSuffix = 'codeless.md.lock'
      vi.useFakeTimers()
      try {
        const writing = booted.provider.write(PROJECT, 'codeless.md', 'new content')
        let settled: unknown
        writing.then(
          (value) => { settled = { ok: true, value } },
          (error: unknown) => { settled = { ok: false, error } },
        )
        await vi.advanceTimersByTimeAsync(5_000 + 20)
        await flushMicrotasks()
        expect(settled).toMatchObject({ ok: false })
        const { error } = settled as { ok: false; error: unknown }
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(
          /could not acquire the write lock for "codeless\.md" — the abandoned/,
        )
        expect((error as Error).message).toContain('boom')
      } finally {
        vi.useRealTimers()
      }
    } finally {
      await booted.done()
    }
  })
})

describe('entry-lock release fault injection', () => {
  it('treats the lock file already being gone at release time as nothing to clean up', async () => {
    const booted = await boot()
    try {
      state.failReadEnoentSuffix = 'release-enoent.md.lock'
      await expect(booted.provider.write(PROJECT, 'release-enoent.md', 'content')).resolves.toMatchObject({ path: 'release-enoent.md' })
      expect(await booted.provider.read(PROJECT, 'release-enoent.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })

  it('surfaces a non-ENOENT failure reading the lock file back at release time', async () => {
    const booted = await boot()
    try {
      state.failReadErrorCodeSuffix = 'release-eacces.md.lock'
      state.failReadErrorCode = 'EACCES'
      await expect(booted.provider.write(PROJECT, 'release-eacces.md', 'content'))
        .rejects.toThrow(/injected read failure \(EACCES\)/)
      // The write itself already landed — only the lock release afterward
      // failed — so the content is not lost even though write() rejected.
      expect(await booted.provider.read(PROJECT, 'release-eacces.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })

  it('skips releasing a lock that now records a different holder (taken over)', async () => {
    const booted = await boot()
    try {
      state.fixedReadSuffix = 'takenover.md.lock'
      state.fixedReadValue = JSON.stringify({ pid: 999_999_999 })
      await expect(booted.provider.write(PROJECT, 'takenover.md', 'content')).resolves.toMatchObject({ path: 'takenover.md' })
      const scope = await scopeDir(booted.root)
      // Release must not have removed a lock it no longer owns.
      await expect(readFile(join(scope, '.locks', 'takenover.md.lock'), 'utf8')).resolves.toBeTypeOf('string')
    } finally {
      await booted.done()
    }
  })

  it('swallows an ENOENT unlink failure releasing its own still-matching lock', async () => {
    const booted = await boot()
    try {
      state.failUnlinkEnoentSuffix = 'release-unlink-enoent.md.lock'
      await expect(booted.provider.write(PROJECT, 'release-unlink-enoent.md', 'content'))
        .resolves.toMatchObject({ path: 'release-unlink-enoent.md' })
      expect(await booted.provider.read(PROJECT, 'release-unlink-enoent.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })

  it('surfaces a non-ENOENT unlink failure releasing its own still-matching lock', async () => {
    const booted = await boot()
    try {
      state.failUnlinkErrorCodeSuffix = 'release-unlink-eacces.md.lock'
      state.failUnlinkErrorCode = 'EACCES'
      await expect(booted.provider.write(PROJECT, 'release-unlink-eacces.md', 'content'))
        .rejects.toThrow(/injected unlink failure \(EACCES\)/)
      expect(await booted.provider.read(PROJECT, 'release-unlink-eacces.md')).toBe('content')
    } finally {
      await booted.done()
    }
  })
})

describe('read() fault injection', () => {
  it('wraps a non-Error rejection from readFile in the usual "no entry" message', async () => {
    const booted = await boot()
    try {
      state.failReadNonErrorSuffix = 'nonerror-read.md'
      await expect(booted.provider.read(PROJECT, 'nonerror-read.md'))
        .rejects.toThrow(/no entry "nonerror-read\.md"/)
    } finally {
      await booted.done()
    }
  })
})

describe('search() fault injection', () => {
  it('skips an entry that vanishes between list() and the read search() performs on it', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'stable.md', 'needle here')
      await booted.provider.write(PROJECT, 'vanished.md', 'needle here too')
      state.failReadEnoentSuffix = 'vanished.md'
      const matches = await booted.provider.search(PROJECT, 'needle')
      expect(matches.map(match => match.path)).toEqual(['stable.md'])
    } finally {
      await booted.done()
    }
  })
})

describe('write() rename-fallback fault injection', () => {
  it('surfaces the original rename failure when the same-directory fallback write also fails', async () => {
    const booted = await boot()
    try {
      state.failRenameSuffix = 'rename-fallback-fail.md'
      state.failWriteFileTargetSuffix = 'rename-fallback-fail.md'
      await expect(booted.provider.write(PROJECT, 'rename-fallback-fail.md', 'content'))
        .rejects.toThrow(/injected rename failure/)
    } finally {
      await booted.done()
    }
  })
})

describe('retainExisting() fault injection', () => {
  it('wraps a non-Error rejection from stat in the usual "could not check entry" message', async () => {
    const booted = await boot()
    try {
      state.failStatNonErrorSuffix = 'nonerror-stat.md'
      await expect(booted.provider.write(PROJECT, 'nonerror-stat.md', 'content'))
        .rejects.toThrow(/could not check entry "nonerror-stat\.md" before writing/)
    } finally {
      await booted.done()
    }
  })

  it('fails loud, naming the entry, when an existing entry cannot even be stat-ed (EACCES, not ENOENT)', async () => {
    const booted = await boot()
    try {
      // Moved here from the chmod-based version in local-retention.spec.ts:
      // chmod-ing a directory to deny writes denies root's writes too, so the
      // real-fs version silently passed when the suite runs as root instead
      // of exercising the EACCES branch. Injecting the error code directly is
      // deterministic regardless of who runs the suite.
      await booted.provider.write(PROJECT, 'perm/entry.md', 'first content')
      state.failStatErrorCodeSuffix = 'perm/entry.md'
      state.failStatErrorCode = 'EACCES'
      await expect(booted.provider.write(PROJECT, 'perm/entry.md', 'second content'))
        .rejects.toThrow(/could not check entry "perm\/entry\.md" before writing/)
    } finally {
      await booted.done()
    }
  })

  it('wraps a non-Error rejection from link in the usual "could not retain" message, keeping the original content', async () => {
    const booted = await boot()
    try {
      await booted.provider.write(PROJECT, 'nonerror-link.md', 'version one')
      state.failLinkNonErrorContains = 'nonerror-link.md.'
      await expect(booted.provider.write(PROJECT, 'nonerror-link.md', 'version two'))
        .rejects.toThrow(/could not retain the previous "nonerror-link\.md"/)
      expect(await booted.provider.read(PROJECT, 'nonerror-link.md')).toBe('version one')
    } finally {
      await booted.done()
    }
  })
})

describe('pruneRetained() fault injection', () => {
  it('warns, counting every retained version that failed to delete, and keeps them all on disk', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const booted = await boot()
    try {
      state.failUnlinkContains = '.replaced'
      const total = MAX_RETAINED_VERSIONS + 2
      for (let i = 0; i < total; i++) {
        await booted.provider.write(PROJECT, 'prune-fail.md', `body ${String(i)}`)
      }
      const scope = await scopeDir(booted.root)
      const retainedDir = join(scope, '.replaced')
      const versions = (await readdir(retainedDir)).filter(name => name.startsWith('prune-fail.md.'))
      // Every prune-unlink was injected to fail, so nothing was actually
      // removed: all "total - 1" replaced versions are still on disk.
      expect(versions).toHaveLength(total - 1)
      expect(warnSpy).toHaveBeenCalled()
      for (const [message] of warnSpy.mock.calls) {
        expect(message).toMatch(
          /^memory: failed to prune \d+ retained version\(s\) of "prune-fail\.md" under .+ — history for this entry may grow unbounded$/,
        )
      }
    } finally {
      warnSpy.mockRestore()
      await booted.done()
    }
  })
})
