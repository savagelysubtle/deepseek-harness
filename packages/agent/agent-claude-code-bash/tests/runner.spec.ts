import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { exactEnv, execToExit, freeBytesOf, realRunnerDeps, runPlan, sleepMs } from '../src/runner.ts'
import type { RunRequest } from '../src/runner.ts'
import { FakeHandle, FakeWorld, GIB, makePlan } from './helpers.ts'

function request(over: Partial<RunRequest> = {}): RunRequest {
  return { plan: makePlan(), cwd: '/work/clone', deadlineMs: 5000, floorBytes: GIB, ...over }
}

describe('exactEnv', () => {
  it('sets exactly the launch environment and tombstones every other host variable', () => {
    const env = exactEnv({ XDG_RUNTIME_DIR: '/run/user/1', PATH: '/usr/bin' }, ['HOME', 'PATH', 'ANTHROPIC_API_KEY'])
    expect(env).toEqual({ HOME: undefined, PATH: '/usr/bin', ANTHROPIC_API_KEY: undefined, XDG_RUNTIME_DIR: '/run/user/1' })
    expect(Object.hasOwn(env, 'HOME')).toBe(true)
  })
})

describe('runPlan: a command that finishes by itself', () => {
  it('spawns exactly the plan argv with the exact environment, collects tails and stops the scope', async () => {
    const world = new FakeWorld()
    world.launch = new FakeHandle({ stdout: 'hello\n', stderr: 'warn\n' })
    world.launch.exit(0)
    const outcome = await runPlan(request(), world.deps())
    expect(outcome).toMatchObject({
      exitCode: 0, signal: null, notStarted: false, stop: 'absent', stdout: { text: 'hello\n', truncated: false }, stderr: { text: 'warn\n', truncated: false },
    })
    expect(outcome.killReason).toBeUndefined()
    expect(outcome.runnerFailure).toBeUndefined()
    expect(outcome.durationMs).toBeGreaterThan(0)
    const [launch, stop] = world.spawns
    expect(launch).toMatchObject({
      argv: makePlan().argv, cwd: '/work/clone', graceMs: 200,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
    })
    // No spill file anywhere: a stream beyond the tail is discarded, never buffered or written.
    expect(launch?.stdio.stdout).toEqual({ maxBytes: 65_536 })
    expect(launch?.env).toEqual({ HOME: undefined, PATH: '/usr/local/bin:/usr/bin:/bin', SECRET_THING: undefined, XDG_RUNTIME_DIR: '/run/user/1000' })
    expect(stop).toMatchObject({ argv: ['systemctl', '--user', 'stop', 'dsh-seat.coder.c1.scope'] })
    expect(stop?.env).toEqual(launch?.env)
    expect(world.kills).toEqual([])
  })

  it('reports lossy streams as truncated', async () => {
    const world = new FakeWorld()
    world.launch = new FakeHandle({ stdout: 'tail', stdoutLossy: true, stderr: 'e', stderrLossy: true })
    world.launch.exit(1)
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stdout.truncated).toBe(true)
    expect(outcome.stderr.truncated).toBe(true)
  })

  it('treats a handle without collected readers as empty output', async () => {
    const world = new FakeWorld()
    world.launch = new FakeHandle({ noReaders: true })
    world.launch.exit(0)
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stdout).toEqual({ text: '', truncated: false })
    expect(outcome.stderr).toEqual({ text: '', truncated: false })
  })

  it('a stop that exits 0 counts as stopped once the cgroup directory is gone, polling for it', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 0
    let checks = 0
    world.cgroupExists = () => ++checks <= 3
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('stopped')
    expect(outcome.runnerFailure).toBeUndefined()
    expect(checks).toBe(4)
  })

  it('reports a signal death that the runner did not cause', async () => {
    const world = new FakeWorld()
    world.launch.exit(null, 'SIGSEGV')
    const outcome = await runPlan(request(), world.deps())
    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGSEGV' })
    expect(outcome.killReason).toBeUndefined()
  })
})

describe('runPlan: ending a call', () => {
  it('kills the process group with SIGKILL at the deadline, then stops the scope', async () => {
    const world = new FakeWorld()
    world.launch = new FakeHandle({ pid: 777, stdout: 'partial' })
    const outcome = await runPlan(request({ deadlineMs: 20 }), world.deps())
    expect(world.kills).toEqual([777])
    expect(outcome).toMatchObject({ killReason: 'deadline', signal: 'SIGKILL', stop: 'absent', stdout: { text: 'partial' } })
    expect(world.spawns.map(spec => spec.argv[0])).toEqual(['systemd-run', 'systemctl'])
  })

  it('does not start the command when the signal is already aborted', async () => {
    const world = new FakeWorld()
    const controller = new AbortController()
    controller.abort()
    const outcome = await runPlan(request({ signal: controller.signal }), world.deps())
    expect(outcome).toMatchObject({ notStarted: true, killReason: 'abort', exitCode: null, durationMs: 0 })
    expect(world.spawns).toEqual([])
    expect(outcome.stop).toBeUndefined()
  })

  it('kills at once when the abort fires while the process is being spawned', async () => {
    const world = new FakeWorld()
    const controller = new AbortController()
    const deps = world.deps()
    const innerSpawn = deps.spawn
    deps.spawn = (spec) => {
      const handle = innerSpawn(spec)
      if (spec.argv[0] !== 'systemctl') controller.abort()
      return handle
    }
    const outcome = await runPlan(request({ signal: controller.signal }), deps)
    expect(world.kills).toEqual([4242])
    expect(outcome).toMatchObject({ killReason: 'abort', notStarted: false, signal: 'SIGKILL' })
  })

  it('kills when the abort fires while the command runs, and removes its listener afterwards', async () => {
    const world = new FakeWorld()
    const controller = new AbortController()
    const deps = world.deps()
    const innerSpawn = deps.spawn
    deps.spawn = (spec) => {
      const handle = innerSpawn(spec)
      // After the launch spawn returns and the runner has parked on the process, the call is cancelled.
      if (spec.argv[0] !== 'systemctl') void Promise.resolve().then(() => { controller.abort() })
      return handle
    }
    const outcome = await runPlan(request({ signal: controller.signal }), deps)
    expect(outcome.killReason).toBe('abort')
    expect(world.kills).toEqual([4242])
  })

  it('the first reason wins: an abort followed by the deadline kills once', async () => {
    const world = new FakeWorld()
    world.onKill = () => undefined
    // The fake sleep is capped short by default, which would end the reap wait before the deadline passes.
    world.sleepCap = 10_000
    const controller = new AbortController()
    vi.useFakeTimers()
    try {
      const running = runPlan(request({ signal: controller.signal, deadlineMs: 20 }), world.deps())
      controller.abort()
      // The deadline passes while the process is still dying: the second reason must not kill again.
      await vi.advanceTimersByTimeAsync(100)
      world.launch.exit(null, 'SIGKILL')
      const outcome = await running
      expect(outcome.killReason).toBe('abort')
      expect(world.kills).toEqual([4242])
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills when free space falls below the floor, sampled while the command runs', async () => {
    const world = new FakeWorld()
    let samples = 0
    world.free = () => (++samples < 2 ? 10 * GIB : GIB / 2)
    const outcome = await runPlan(request({ deadlineMs: 5000 }), world.deps())
    expect(outcome.killReason).toBe('disk-floor')
    expect(samples).toBeGreaterThanOrEqual(2)
    expect(world.kills).toEqual([4242])
  })

  it('treats a free-space sample that fails as below the floor and warns', async () => {
    const world = new FakeWorld()
    world.free = () => { throw new Error('statfs broke') }
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.killReason).toBe('disk-floor')
    expect(world.warnings.join('\n')).toContain('cannot sample free space of /work/clone: statfs broke')
  })

  it('records a runner failure when the kill itself throws', async () => {
    const world = new FakeWorld()
    world.killThrows = new Error('EPERM')
    vi.useFakeTimers()
    try {
      const running = runPlan(request({ deadlineMs: 10 }), world.deps())
      await vi.advanceTimersByTimeAsync(20)
      world.launch.exit(null, 'SIGKILL')
      const outcome = await running
      expect(outcome.killReason).toBe('deadline')
      expect(outcome.runnerFailure).toBe('could not kill the process group of pid 4242: EPERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a runner failure when the process does not exit after SIGKILL', async () => {
    const world = new FakeWorld()
    world.onKill = () => undefined
    const outcome = await runPlan(request({ deadlineMs: 10 }), world.deps())
    expect(outcome.runnerFailure).toBe('pid 4242 did not exit within 5000 ms of SIGKILL')
    expect(outcome.exitCode).toBeNull()
    expect(outcome.stop).toBe('absent')
  })
})

describe('runPlan: failures of the runner itself', () => {
  it('a spawn that throws is a runner failure and no scope is stopped', async () => {
    const world = new FakeWorld()
    world.launchThrows = new Error('ENOENT systemd-run')
    const outcome = await runPlan(request(), world.deps())
    expect(outcome).toMatchObject({ notStarted: true, runnerFailure: 'the launch could not be spawned: ENOENT systemd-run' })
    expect(outcome.stop).toBeUndefined()
    expect(world.spawns.map(spec => spec.argv[0])).toEqual(['systemd-run'])
  })

  it('a done promise that rejects is a spawn-level failure, and the scope is still stopped', async () => {
    const world = new FakeWorld()
    world.launch.reject(new Error('spawn exploded'))
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.runnerFailure).toBe('the launch failed at the spawn level: spawn exploded')
    expect(outcome.stop).toBe('absent')
    expect(world.spawns).toHaveLength(2)
  })

  it('an unreachable bus at stop time is an environment failure, never a pass', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 1
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('environment-failure')
    expect(outcome.runnerFailure).toContain('user systemd bus was unreachable')
    expect(outcome.runnerFailure).toContain('dsh-seat.coder.c1')
  })

  it('a scope that survives the stop is a failure and names the processes left', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 0
    world.cgroupExists = () => true
    world.procs = '101\n102\n\n'
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('failed')
    expect(outcome.runnerFailure).toBe('the stop of dsh-seat.coder.c1 did not end cleanly (exit 0; its cgroup is still present with 2 process(es))')
  })

  it('an odd stop exit with the cgroup gone is a failure too', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 3
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('failed')
    expect(outcome.runnerFailure).toBe('the stop of dsh-seat.coder.c1 did not end cleanly (exit 3; its cgroup is gone)')
  })

  it('a stop command that never finishes is terminated and reported', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 'hang'
    const outcome = await runPlan(request(), world.deps())
    expect(world.stops[0]?.terminated).toBe(1)
    expect(outcome.stop).toBe('failed')
    expect(outcome.runnerFailure).toContain('systemctl did not finish within 15000 ms; the stop of dsh-seat.coder.c1 did not end cleanly (no exit code; its cgroup is gone)')
  })

  it('a stop command that cannot be spawned is reported', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 'throw'
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('failed')
    expect(outcome.runnerFailure).toContain('systemctl could not run: no systemctl')
  })

  it('keeps the first runner failure when several happen', async () => {
    const world = new FakeWorld()
    world.launch.reject(new Error('first'))
    world.stopExit = 1
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.runnerFailure).toBe('the launch failed at the spawn level: first')
  })
})

describe('execToExit', () => {
  it('returns the exit code of a short command', async () => {
    const world = new FakeWorld()
    world.stopExit = 0
    expect(await execToExit(['systemctl', '--user', 'show-environment'], { XDG_RUNTIME_DIR: '/x' }, world.deps(), 1000)).toEqual({ exitCode: 0 })
  })
})

describe('production dependencies', () => {
  const warn = (): void => undefined

  it('killGroup kills a real process group and treats a group that is already gone as done', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const exited = new Promise<string | null>((resolve) => { child.once('exit', (_code, signal) => { resolve(signal) }) })
    const deps = realRunnerDeps(() => { throw new Error('unused') }, warn)
    deps.killGroup(child.pid as number)
    expect(await exited).toBe('SIGKILL')
    expect(() => { deps.killGroup(child.pid as number) }).not.toThrow()
  })

  it('killGroup rethrows an error other than ESRCH (the signal is stubbed, nothing is killed)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not allowed'), { code: 'EPERM' }) })
    try {
      const deps = realRunnerDeps(() => { throw new Error('unused') }, warn)
      expect(() => { deps.killGroup(4242) }).toThrow('not allowed')
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    } finally {
      kill.mockRestore()
    }
  })

  it('killGroup never signals pid -1, 0, 1 or a non-number: those would hit unrelated processes', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const deps = realRunnerDeps(() => { throw new Error('unused') }, warn)
      for (const pid of [-1, 0, 1, Number.NaN]) deps.killGroup(pid)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('leaderAlive is true for a live process, false for a gone one, and true when the probe is merely not permitted', async () => {
    const deps = realRunnerDeps(() => { throw new Error('unused') }, warn)
    expect(deps.leaderAlive(process.pid)).toBe(true)
    const child = spawn('true', [], { stdio: 'ignore' })
    await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    expect(deps.leaderAlive(child.pid as number)).toBe(false)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) })
    try {
      expect(deps.leaderAlive(4242)).toBe(true)
    } finally {
      kill.mockRestore()
    }
  })

  it('reads cgroup.procs, an absent file as empty, and rethrows other read errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-procs-'))
    try {
      writeFileSync(join(dir, 'procs'), '1\n2\n')
      const deps = realRunnerDeps(() => { throw new Error('unused') }, warn)
      expect(deps.readProcs(join(dir, 'procs'))).toBe('1\n2\n')
      expect(deps.readProcs(join(dir, 'missing'))).toBe('')
      expect(() => deps.readProcs(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes the host environment names, the clock, existence and the spawn it was given', () => {
    const marker = { spawned: false }
    const deps = realRunnerDeps((spec) => { marker.spawned = spec.argv[0] === 'x'; return new FakeHandle() }, warn)
    expect(deps.hostEnvNames()).toEqual(Object.keys(process.env))
    expect(typeof deps.now()).toBe('number')
    expect(deps.exists('/usr')).toBe(true)
    expect(deps.exists('/definitely/not/here')).toBe(false)
    expect(Math.abs(deps.freeBytes(tmpdir()) - freeBytesOf(tmpdir()))).toBeLessThan(freeBytesOf(tmpdir()) * 0.05)
    deps.spawn({ argv: ['x'], cwd: '/', stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, graceMs: 1 })
    expect(marker.spawned).toBe(true)
    expect(deps.warn).toBe(warn)
  })

  it('freeBytesOf reports bytes available to the user', () => {
    expect(freeBytesOf(tmpdir())).toBeGreaterThan(0)
  })
})

describe('sleepMs', () => {
  it('resolves after the delay', async () => {
    const started = performance.now()
    await sleepMs(20)
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('resolves at once when the signal aborts, and clears its timer', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const slept = sleepMs(60_000, controller.signal)
    controller.abort()
    await slept
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('runPlan: hardening', () => {
  it('never signals a launch whose pid is not a real child (a failed spawn reports -1)', async () => {
    const world = new FakeWorld()
    world.launch = new FakeHandle({ pid: -1 })
    vi.useFakeTimers()
    try {
      const running = runPlan(request({ deadlineMs: 10 }), world.deps())
      await vi.advanceTimersByTimeAsync(20)
      world.launch.reject(new Error('spawn failed'))
      const outcome = await running
      expect(world.kills).toEqual([])
      expect(outcome.killReason).toBe('deadline')
      expect(outcome.runnerFailure).toBe('the launch has no valid process id (-1), so it cannot be signalled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not kill, and reports no kill, when the leader already exited and only the pipes are draining', async () => {
    const world = new FakeWorld()
    world.alive = () => false
    vi.useFakeTimers()
    try {
      const running = runPlan(request({ deadlineMs: 10 }), world.deps())
      await vi.advanceTimersByTimeAsync(20)
      // done settles only now, after the deadline timer already fired.
      world.launch.exit(0)
      const outcome = await running
      expect(world.kills).toEqual([])
      expect(outcome).toMatchObject({ exitCode: 0, notStarted: false })
      expect(outcome.killReason).toBeUndefined()
      expect(outcome.runnerFailure).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the deadline and watchdog timers once the process is done (no later kill, no later sample)', async () => {
    const world = new FakeWorld()
    let samples = 0
    world.free = () => { samples += 1; return 10 * GIB }
    vi.useFakeTimers()
    try {
      const running = runPlan(request({ deadlineMs: 1000 }), world.deps())
      await vi.advanceTimersByTimeAsync(300)
      world.launch.exit(0)
      await running
      const after = samples
      await vi.advanceTimersByTimeAsync(5000)
      expect(samples).toBe(after)
      expect(world.kills).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('describes an unreadable cgroup.procs instead of rejecting', async () => {
    const world = new FakeWorld()
    world.stopExit = 0
    world.cgroupExists = () => true
    world.procsThrows = Object.assign(new Error('EACCES: permission denied, open cgroup.procs'), { code: 'EACCES' })
    world.launch.exit(0)
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.stop).toBe('failed')
    expect(outcome.runnerFailure).toBe(
      'the stop of dsh-seat.coder.c1 did not end cleanly (exit 0; its cgroup is still present with an unreadable process list (EACCES: permission denied, open cgroup.procs))',
    )
  })

  it('turns a failure of the runner\'s own dependencies into a runner failure, never a rejection', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    const deps = world.deps()
    deps.exists = () => { throw new Error('exists broke\n  second line') }
    const outcome = await runPlan(request(), deps)
    expect(outcome).toMatchObject({ exitCode: null, signal: null, notStarted: false, durationMs: 0 })
    expect(outcome.runnerFailure).toBe(
      'the runner failed while running the launch: exists broke second line; the scope dsh-seat.coder.c1 could not be stopped either: exists broke second line',
    )
  })

  it('stops the scope even when the runner faults after the launch exists, folding stop problems into the failure', async () => {
    const world = new FakeWorld()
    world.stopExit = 0
    world.launch.exit(0)
    const deps = world.deps()
    let after = false
    deps.now = () => { if (after) throw new Error('clock broke'); return 1 }
    const innerSpawn = deps.spawn
    deps.spawn = (spec) => { if (spec.argv[0] !== 'systemctl') after = true; return innerSpawn(spec) }
    const outcome = await runPlan(request(), deps)
    expect(outcome.runnerFailure).toBe('the runner failed while running the launch: clock broke')
    // The ladder ran once in the body and once more in the fault path.
    expect(world.spawns.filter(spec => spec.argv[0] === 'systemctl')).toHaveLength(2)
  })

  it('reports a scope stop that fails in the fault path too', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    const deps = world.deps()
    deps.exists = () => { throw new Error('exists broke') }
    const outcome = await runPlan(request(), deps)
    expect(world.spawns.some(spec => spec.argv[0] === 'systemctl')).toBe(true)
    expect(outcome.runnerFailure).toBe('the runner failed while running the launch: exists broke; the scope dsh-seat.coder.c1 could not be stopped either: exists broke')
  })

  it('folds an unclean stop in the fault path into the failure text', async () => {
    const world = new FakeWorld()
    world.launch.exit(0)
    world.stopExit = 1
    const deps = world.deps()
    let after = false
    deps.now = () => { if (after) throw new Error('clock broke'); return 1 }
    const innerSpawn = deps.spawn
    deps.spawn = (spec) => { if (spec.argv[0] !== 'systemctl') after = true; return innerSpawn(spec) }
    const outcome = await runPlan(request(), deps)
    expect(outcome.runnerFailure).toBe(
      'the runner failed while running the launch: clock broke; the user systemd bus was unreachable, so the state of the scope dsh-seat.coder.c1 is unknown',
    )
  })

  it('does not stop a scope when the runner faults before any launch exists', async () => {
    const world = new FakeWorld()
    const deps = world.deps()
    deps.now = () => { throw new Error('clock broke') }
    const outcome = await runPlan(request(), deps)
    expect(outcome.runnerFailure).toBe('the runner failed while running the launch: clock broke')
    expect(world.spawns).toEqual([])
  })

  it('keeps every runner-failure text on one line', async () => {
    const world = new FakeWorld()
    world.launchThrows = new Error('first\n   second\r\nthird')
    const outcome = await runPlan(request(), world.deps())
    expect(outcome.runnerFailure).toBe('the launch could not be spawned: first second third')
    const deps = world.deps()
    deps.spawn = () => { throw new Error('x\ny') }
    expect(await execToExit(['systemctl'], {}, deps, 100)).toEqual({ exitCode: null, problem: 'systemctl could not run: x y' })
  })
})
