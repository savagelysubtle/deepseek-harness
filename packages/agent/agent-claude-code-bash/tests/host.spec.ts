import { describe, expect, it } from 'vitest'
import { SandboxHost } from '../src/host.ts'
import { RECHECK_MS } from '../src/limits.ts'
import { BWRAP, FakeHandle, FakeWorld, GIB, makeConfig, makePreflightDeps } from './helpers.ts'

function setup(): { world: FakeWorld; deps: ReturnType<typeof makePreflightDeps>; host: SandboxHost; warnings: string[] } {
  const world = new FakeWorld()
  world.stopExit = 0
  world.makeLaunch = () => {
    const handle = new FakeHandle()
    handle.exit(0)
    return handle
  }
  const deps = makePreflightDeps(world)
  const warnings: string[] = []
  const host = new SandboxHost(makeConfig(), deps, (message) => { warnings.push(message) })
  return { world, deps, host, warnings }
}

const launches = (world: FakeWorld): number => world.spawns.filter(spec => spec.argv[0] === 'systemd-run').length

describe('SandboxHost: start and ensureReady', () => {
  it('a passing first preflight makes the host ready without another run', async () => {
    const { host, world } = setup()
    expect((await host.start()).ok).toBe(true)
    expect(launches(world)).toBe(1)
    expect(await host.ensureReady()).toBeUndefined()
    expect(launches(world)).toBe(1)
  })

  it('a failing first preflight is warn-logged with the code, reason and remedy, and refuses calls', async () => {
    const { host, warnings, deps, world } = setup()
    deps.runner.hostEnvNames()
    const failing = makePreflightDeps(world, { attest: () => undefined })
    const sad = new SandboxHost(makeConfig(), failing, (message) => { warnings.push(message) })
    expect((await sad.start()).ok).toBe(false)
    expect(warnings[0]).toBe('agent-claude-code-bash: sandbox preflight failed, bash calls are refused: binary-missing: bwrap disappeared from /usr/bin/bwrap (install bubblewrap)')
    expect(await sad.ensureReady()).toContain('binary-missing')
    expect(host).toBeDefined()
  })

  it('runs the preflight again when the bwrap binary, the kernel or a user-namespace sysctl changed', async () => {
    const { host, world, deps } = setup()
    await host.start()
    deps.sysctlValues['kernel.unprivileged_userns_clone'] = '0'
    expect(await host.ensureReady()).toBeUndefined()
    expect(launches(world)).toBe(2)
    expect(await host.ensureReady()).toBeUndefined()
    expect(launches(world)).toBe(2)
  })

  it('a changed environment that no longer passes refuses calls and is not retried within the recheck window', async () => {
    const { host, world, deps, warnings } = setup()
    await host.start()
    world.stopExit = 1
    deps.sysctlValues['kernel.apparmor_restrict_unprivileged_userns'] = '1'
    const first = await host.ensureReady()
    expect(first).toContain('user-bus: `systemctl --user show-environment` exited 1')
    const spawned = world.spawns.length
    expect(await host.ensureReady()).toBe(first)
    expect(world.spawns).toHaveLength(spawned)
    expect(warnings.filter(line => line.includes('preflight failed'))).toHaveLength(1)
    // After the window, and with the environment fixed, a call proves the sandbox healthy again.
    world.clock += RECHECK_MS * 2
    world.stopExit = 0
    expect(await host.ensureReady()).toBeUndefined()
    expect(world.spawns.length).toBeGreaterThan(spawned)
  })

  it('degraded refuses until a preflight passes; the next call re-runs it and clears the flag', async () => {
    const { host, world, warnings } = setup()
    await host.start()
    host.markDegraded('the scope survived')
    expect(warnings.at(-1)).toBe('agent-claude-code-bash: sandbox marked degraded, calls are refused until a preflight passes: the scope survived')
    expect(await host.ensureReady()).toBeUndefined()
    expect(launches(world)).toBe(2)
  })

  it('keeps the reason that was recorded first', async () => {
    const { host, world } = setup()
    await host.start()
    world.stopExit = 1
    host.markDegraded('first')
    host.markDegraded('second')
    const reason = await host.ensureReady()
    expect(reason).toContain('user-bus')
    host.markDegraded('third')
    expect(await host.ensureReady()).toBe(reason)
  })

  it('concurrent calls share one preflight run', async () => {
    const { host, world } = setup()
    await host.start()
    host.markDegraded('x')
    const results = await Promise.all([host.ensureReady(), host.ensureReady(), host.ensureReady()])
    expect(results).toEqual([undefined, undefined, undefined])
    expect(launches(world)).toBe(2)
  })

  it('refuses everything once unloaded', async () => {
    const { host } = setup()
    await host.start()
    host.unload()
    expect(await host.ensureReady()).toBe('the sandbox plugin was unloaded')
  })
})

describe('SandboxHost: busy flag, clones, plan, run, disk', () => {
  it('allows one call at a time per seat', () => {
    const { host } = setup()
    expect(host.acquire('a')).toBe(true)
    expect(host.acquire('a')).toBe(false)
    expect(host.acquire('b')).toBe(true)
    host.release('a')
    expect(host.acquire('a')).toBe(true)
  })

  it('re-tests a clone once per verdict with its real directory, and not again after success', async () => {
    const { host, world } = setup()
    await host.start()
    expect(await host.verifyClone('coder-one', '/work/clone')).toBeUndefined()
    expect(launches(world)).toBe(2)
    expect(await host.verifyClone('coder-one', '/work/clone')).toBeUndefined()
    expect(launches(world)).toBe(2)
    // A new verdict (the environment changed) clears what was verified.
    host.markDegraded('x')
    await host.ensureReady()
    expect(await host.verifyClone('coder-one', '/work/clone')).toBeUndefined()
    expect(launches(world)).toBe(4)
  })

  it('does not remember a failed re-test', async () => {
    const { host, world } = setup()
    await host.start()
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stderr: 'bwrap: nope' })
      handle.exit(1)
      return handle
    }
    expect(await host.verifyClone('coder-one', '/work/clone')).toMatchObject({ code: 'launch-failed' })
    expect(await host.verifyClone('coder-one', '/work/clone')).toMatchObject({ code: 'launch-failed' })
  })

  it('builds the plan from host values and the per-call fields only', async () => {
    const { host } = setup()
    await host.start()
    const planned = host.plan({ seat: 'coder-one', callId: 'c1', command: 'ls', cwd: '/work/clone', workdir: '/work/clone/sub', deadlineS: 60 })
    expect(planned).toMatchObject({ ok: true, plan: { chdir: '/work/clone/sub' } })
  })

  it('runs a plan through the runner', async () => {
    const { host } = setup()
    await host.start()
    const outcome = await host.run({ plan: (host.plan({ seat: 'coder-one', callId: 'c1', command: 'ls', cwd: '/work/clone', deadlineS: 60 }) as unknown as { plan: never }).plan, cwd: '/work/clone', deadlineMs: 1000, floorBytes: GIB })
    expect(outcome.exitCode).toBe(0)
  })

  it('lowDisk compares against the floor, and an unreadable filesystem counts as low and warns', () => {
    const { host, world, warnings } = setup()
    expect(host.lowDisk('/work/clone')).toBe(false)
    world.free = () => GIB - 1
    expect(host.lowDisk('/work/clone')).toBe(true)
    world.free = () => { throw new Error('statfs gone') }
    expect(host.lowDisk('/work/clone')).toBe(true)
    expect(warnings.at(-1)).toBe('agent-claude-code-bash: cannot sample free space of /work/clone: statfs gone')
  })

  it('mints call ids that fit the unit-name alphabet and do not repeat', () => {
    const { host } = setup()
    const ids = new Set(Array.from({ length: 50 }, () => host.newCallId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^c[0-9a-f]{12}$/)
    expect(BWRAP.path).toBe('/usr/bin/bwrap')
  })
})

describe('SandboxHost: a preflight that throws', () => {
  const enospc = (): never => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }

  it('at mount is a typed failure with a warning, not a rejection', async () => {
    const { world, warnings } = setup()
    const deps = makePreflightDeps(world, { makeScratch: enospc })
    const host = new SandboxHost(makeConfig(), deps, (message) => { warnings.push(message) })
    const result = await host.start()
    expect(result).toMatchObject({ ok: false, failure: { code: 'preflight-error' } })
    expect(warnings.at(-1)).toContain('preflight-error: the sandbox check could not complete: ENOSPC: no space left on device')
    expect(await host.ensureReady()).toContain('preflight-error')
  })

  it('on a recheck becomes the refusal reason, is throttled, and recovers once the host condition is fixed', async () => {
    const { host, world, deps, warnings } = setup()
    await host.start()
    host.markDegraded('the scope survived')
    deps.makeScratch = enospc
    const reason = await host.ensureReady()
    expect(reason).toContain('preflight-error: the sandbox check could not complete: ENOSPC')
    const spawned = world.spawns.length
    expect(await host.ensureReady()).toBe(reason)
    expect(world.spawns).toHaveLength(spawned)
    expect(warnings.filter(line => line.includes('preflight failed'))).toHaveLength(1)
    world.clock += RECHECK_MS * 2
    deps.makeScratch = () => ({ dir: '/scratch', dispose: () => undefined })
    expect(await host.ensureReady()).toBeUndefined()
  })

  it('in the fingerprint (an unreadable sysctl) is recorded once per window with its reason, and a thrown non-Error is described', async () => {
    const { host, world, deps, warnings } = setup()
    await host.start()
    deps.sysctl = () => { throw 'EACCES on /proc/sys\nsecond line' }
    const reason = await host.ensureReady()
    expect(reason).toContain('preflight-error: the sandbox check could not complete: EACCES on /proc/sys second line')
    expect(await host.ensureReady()).toBe(reason)
    expect(warnings.filter(line => line.includes('preflight failed'))).toHaveLength(1)
    world.clock += RECHECK_MS * 2
    deps.sysctl = () => 'absent'
    expect(await host.ensureReady()).toBeUndefined()
  })
})

describe('SandboxHost: unload aborts running calls', () => {
  it('kills a run in flight through the stop ladder, with or without a call signal', async () => {
    for (const withSignal of [false, true]) {
      const { host, world } = setup()
      await host.start()
      world.makeLaunch = () => new FakeHandle()
      const planned = host.plan({ seat: 'coder-one', callId: 'c1', command: 'sleep 9', cwd: '/work/clone', deadlineS: 60 })
      if (!planned.ok) throw new Error('plan refused')
      const running = host.run({
        plan: planned.plan, cwd: '/work/clone', deadlineMs: 60_000, floorBytes: GIB,
        ...withSignal ? { signal: new AbortController().signal } : {},
      })
      host.unload()
      const outcome = await running
      expect(outcome.killReason).toBe('abort')
      expect(outcome.stop).toBe('stopped')
    }
  })
})
