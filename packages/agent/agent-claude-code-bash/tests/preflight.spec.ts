import { existsSync, readFileSync, statSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SeatRefusalError } from '@deepseek-ai/dsh-sandbox-local'
import { fingerprintOf, makeScratchClone, probeLaunch, readSysctl, realPreflightDeps, runPreflight, USERNS_SYSCTLS } from '../src/preflight.ts'
import { realRunnerDeps } from '../src/runner.ts'
import { FakeHandle, FakeWorld, GIB, BWRAP, makeConfig, makePreflightDeps, containing } from './helpers.ts'

function healthyWorld(): FakeWorld {
  const world = new FakeWorld()
  world.launch.exit(0)
  world.stopExit = 0
  return world
}

describe('runPreflight', () => {
  it('passes when the binaries exist, the bus answers and `true` runs through the production launch and stops cleanly', async () => {
    const world = healthyWorld()
    const planned: unknown[] = []
    const base = makePreflightDeps(world)
    const result = await runPreflight(makeConfig(), { ...base, plan: (spec) => { planned.push(spec); return base.plan(spec) } })
    expect(result).toMatchObject({ ok: true, bwrap: BWRAP })
    expect(result.ok && result.fingerprint).toBe('/usr/bin/bwrap:1:2:3|7.0.0-test|kernel.unprivileged_userns_clone=1|kernel.apparmor_restrict_unprivileged_userns=0')
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({
      seat: 'preflight', command: 'true', cwd: '/scratch', deadlineS: 30, home: '/home/op', nodeDir: '/opt/node', xdgRuntimeDir: '/run/user/1000', bwrap: BWRAP,
    })
    expect(base.disposed).toBe(1)
    // The bus probe ran first, the launch second, the unit stop last.
    expect(world.spawns.map(spec => spec.argv.slice(0, 3).join(' '))).toEqual([
      'systemctl --user show-environment', 'systemd-run --scope bwrap', 'systemctl --user stop',
    ])
  })

  it('disposes the throwaway clone', async () => {
    const world = healthyWorld()
    const deps = makePreflightDeps(world)
    await runPreflight(makeConfig(), deps)
    expect(deps.disposed).toBe(1)
  })

  it('fails with binary-missing for each missing binary', async () => {
    for (const missing of ['/usr/bin/env', '/usr/bin/prlimit', '/usr/bin/bwrap', '/usr/bin/systemd-run', '/usr/bin/systemctl']) {
      const world = healthyWorld()
      world.binaryExists = path => !path.endsWith(`/${missing.split('/').pop()}`)
      const result = await runPreflight(makeConfig(), makePreflightDeps(world))
      expect(result.ok, missing).toBe(false)
      expect(!result.ok && result.failure.code).toBe('binary-missing')
      expect(world.spawns, missing).toHaveLength(0)
    }
  })

  it('names a tool that is on no PATH directory', async () => {
    const world = healthyWorld()
    world.binaryExists = path => !path.endsWith('/systemd-run')
    const result = await runPreflight(makeConfig(), makePreflightDeps(world))
    expect(!result.ok && result.failure.reason).toContain('systemd-run (not found in /usr/local/bin:/usr/bin:/bin)')
  })

  it('fails with xdg-runtime-dir when it is unset or relative', async () => {
    for (const xdgRuntimeDir of [undefined, 'run/user']) {
      const result = await runPreflight(makeConfig({ xdgRuntimeDir }), makePreflightDeps(healthyWorld()))
      expect(!result.ok && result.failure.code).toBe('xdg-runtime-dir')
    }
  })

  it('fails with user-bus when systemctl --user cannot answer, by exit code or by hanging', async () => {
    const world = healthyWorld()
    world.stopExit = 1
    const failed = await runPreflight(makeConfig(), makePreflightDeps(world))
    expect(!failed.ok && failed.failure).toMatchObject({ code: 'user-bus', reason: '`systemctl --user show-environment` exited 1' })

    const hung = new FakeWorld()
    hung.stopExit = 'hang'
    const timedOut = await runPreflight(makeConfig(), makePreflightDeps(hung))
    expect(!timedOut.ok && timedOut.failure.reason).toBe('`systemctl --user show-environment` systemctl did not finish within 10000 ms')
  })

  it('fails when bwrap vanishes between the file check and the attestation', async () => {
    const result = await runPreflight(makeConfig(), makePreflightDeps(healthyWorld(), { attest: () => undefined }))
    expect(!result.ok && result.failure).toMatchObject({ code: 'binary-missing', reason: 'bwrap disappeared from /usr/bin/bwrap' })
  })

  it('fails with plan-refused when the profile builder refuses, and still disposes the clone', async () => {
    const world = healthyWorld()
    const refusal = new SeatRefusalError('not-provisioned', 'missing dir', 'create it')
    const deps = makePreflightDeps(world, { plan: () => ({ ok: false, refusal }) })
    const result = await runPreflight(makeConfig(), deps)
    expect(!result.ok && result.failure).toEqual({ code: 'plan-refused', reason: 'not-provisioned: missing dir', remedy: 'create it' })
    expect(deps.disposed).toBe(1)
  })

  it('fails with launch-failed and shows the exit code and stderr when `true` does not exit 0', async () => {
    const world = healthyWorld()
    world.launch = new FakeHandle({ stderr: 'bwrap: No permissions to create new namespace' })
    world.launch.exit(1)
    const result = await runPreflight(makeConfig(), makePreflightDeps(world))
    expect(!result.ok && result.failure.code).toBe('launch-failed')
    expect(!result.ok && result.failure.reason).toBe('the probe command `true` did not run cleanly through the seat launch: exit 1; stderr: bwrap: No permissions to create new namespace')
    expect(!result.ok && result.failure.remedy).toContain('kernel.unprivileged_userns_clone')
  })

  it('describes a signal death, a kill and a launch that did not start', async () => {
    const signaled = healthyWorld()
    signaled.launch = new FakeHandle()
    signaled.launch.exit(null, 'SIGSEGV')
    expect((await runPreflight(makeConfig(), makePreflightDeps(signaled)))).toMatchObject({ failure: { reason: containing('exit none signal SIGSEGV') } })

    const killed = healthyWorld()
    killed.launch = new FakeHandle()
    killed.free = () => GIB / 2
    expect((await runPreflight(makeConfig(), makePreflightDeps(killed)))).toMatchObject({ failure: { code: 'launch-failed', reason: containing('it was killed (disk-floor)') } })

    const notStarted = healthyWorld()
    notStarted.launchThrows = new Error('ENOENT')
    expect((await runPreflight(makeConfig(), makePreflightDeps(notStarted)))).toMatchObject({
      failure: { code: 'launch-failed', reason: containing('it did not start; the launch could not be spawned: ENOENT') },
    })
  })

  it('fails with cannot-stop when the scope cannot be proven gone', async () => {
    const world = healthyWorld()
    world.stopSequence = [0, 1]
    const result = await runPreflight(makeConfig(), makePreflightDeps(world))
    expect(!result.ok && result.failure.code).toBe('cannot-stop')
    expect(!result.ok && result.failure.reason).toContain('user systemd bus was unreachable')
    expect(!result.ok && result.failure.remedy).toContain('systemctl --user status')
  })
})

describe('probeLaunch', () => {
  it('uses the given directory and seat and returns undefined on success', async () => {
    const world = healthyWorld()
    const specs: Array<{ seat: string; cwd: string; callId: string }> = []
    const deps = makePreflightDeps(world, { plan: (spec) => { specs.push(spec); return makePreflightDeps(world).plan(spec) } })
    expect(await probeLaunch(makeConfig(), BWRAP, '/work/clone', deps, 'coder-one')).toBeUndefined()
    expect(specs[0]).toMatchObject({ seat: 'coder-one', cwd: '/work/clone' })
    expect(specs[0]?.callId).toMatch(/^p[0-9a-f]{12}$/)
  })
})

describe('fingerprintOf', () => {
  it('changes with the bwrap identity, the kernel release and either sysctl', () => {
    const deps = makePreflightDeps(new FakeWorld())
    const base = fingerprintOf(BWRAP, deps)
    expect(fingerprintOf({ ...BWRAP, ino: '9' }, deps)).not.toBe(base)
    expect(fingerprintOf({ ...BWRAP, mtimeNs: '9' }, deps)).not.toBe(base)
    expect(fingerprintOf({ ...BWRAP, size: '9' }, deps)).not.toBe(base)
    expect(fingerprintOf(undefined, deps)).toContain('missing')
    deps.sysctlValues[USERNS_SYSCTLS[0] as string] = '0'
    expect(fingerprintOf(BWRAP, deps)).not.toBe(base)
    deps.sysctlValues[USERNS_SYSCTLS[0] as string] = '1'
    deps.sysctlValues[USERNS_SYSCTLS[1] as string] = '1'
    expect(fingerprintOf(BWRAP, deps)).not.toBe(base)
    deps.sysctlValues[USERNS_SYSCTLS[1] as string] = '0'
    expect(fingerprintOf(BWRAP, { ...deps, release: () => '8.0' })).not.toBe(base)
    Reflect.deleteProperty(deps.sysctlValues, USERNS_SYSCTLS[0] as string)
    expect(fingerprintOf(BWRAP, deps)).toContain('=absent')
  })
})

describe('real helpers', () => {
  it('readSysctl reads a real value, maps a missing file to absent and rethrows other errors', () => {
    expect(readSysctl('kernel.ostype')).toBe('Linux')
    expect(readSysctl('kernel.no_such_sysctl_here')).toBe('absent')
    expect(() => readSysctl('kernel.ostype.child')).toThrow()
  })

  it('makeScratchClone builds a directory the profile builder accepts as a clone, and removes it', () => {
    const scratch = makeScratchClone('/tmp')
    try {
      expect(scratch.dir.startsWith('/tmp/dsh-bash-preflight-')).toBe(true)
      expect(readFileSync(join(scratch.dir, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
      expect(readFileSync(join(scratch.dir, '.git', 'config'), 'utf8')).toBe('[core]\n')
      expect(statSync(join(scratch.dir, '.git', 'objects')).isDirectory()).toBe(true)
    } finally {
      scratch.dispose()
    }
    expect(existsSync(scratch.dir)).toBe(false)
  })

  it('realPreflightDeps wires the real functions around the given runner', () => {
    const runner = realRunnerDeps(() => new FakeHandle(), () => undefined)
    const deps = realPreflightDeps(runner)
    expect(deps.runner).toBe(runner)
    expect(deps.release()).toBe(release())
    expect(deps.sysctl('kernel.ostype')).toBe('Linux')
    expect(deps.attest('/definitely/not/here')).toBeUndefined()
    expect(deps.attest('/usr/bin/env')).toMatchObject({ path: '/usr/bin/env' })
    expect(deps.plan).toBeTypeOf('function')
    expect(deps.makeScratch).toBe(makeScratchClone)
  })
})
