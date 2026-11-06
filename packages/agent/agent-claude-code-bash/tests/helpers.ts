/**
 * Test doubles for the sandbox bash package: a fake subprocess seam (a launch handle and a stop handle the test
 * controls), a fake world for the runner's dependencies, a plan builder, and a seat closure.
 */

import { expect } from 'vitest'
import { SEAT_DEFAULT_LIMITS } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatBwrapIdentity, SeatLaunchPlan } from '@deepseek-ai/dsh-sandbox-local'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { scrubText } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { SeatToolContext } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { ResolvedConfig } from '../src/config.ts'
import type { RunnerDeps } from '../src/runner.ts'
import type { PreflightDeps } from '../src/preflight.ts'

export const GIB = 1024 ** 3

/** A subprocess handle whose exit the test controls. */
export class FakeHandle implements SubprocessHandle {
  readonly pid: number
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly done: Promise<SubprocessOutcome>
  readonly collected: SubprocessCollectedOutputs
  terminated = 0
  private settle!: (outcome: SubprocessOutcome) => void
  private fail!: (error: Error) => void

  constructor(options: {
    pid?: number
    stdout?: string
    stderr?: string
    stdoutLossy?: boolean
    stderrLossy?: boolean
    noReaders?: boolean
  } = {}) {
    this.pid = options.pid ?? 4242
    this.done = new Promise((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })
    const reader = (text: string | undefined, lossy: boolean | undefined) => ({
      readFrom: () => ({ text: text ?? '', nextOffset: (text ?? '').length, lossy: lossy === true }),
    })
    this.collected = options.noReaders === true
      ? {}
      : { stdout: reader(options.stdout, options.stdoutLossy), stderr: reader(options.stderr, options.stderrLossy) }
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.settle({ exitCode, signal })
  }

  reject(error: Error): void {
    this.fail(error)
  }

  terminate(): void {
    this.terminated += 1
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

/** The runner's dependencies over a fake world. */
export class FakeWorld {
  spawns: SubprocessSpawnSpec[] = []
  kills: number[] = []
  warnings: string[] = []
  /** The launch handle (any spawn whose argv[0] is not `systemctl`). */
  launch = new FakeHandle()
  /** Exit code of the stop command; `'hang'` never finishes, `'throw'` throws at spawn. */
  stopExit: number | 'hang' | 'throw' = 5
  /** Exit codes for successive `systemctl` spawns; after the list is used up, {@link stopExit} applies. */
  stopSequence: Array<number | 'hang' | 'throw'> = []
  /** Every `systemctl` handle, in spawn order. */
  stops: FakeHandle[] = []
  /** When set, every launch spawn gets a fresh handle from here instead of {@link launch}. */
  makeLaunch: (() => FakeHandle) | undefined
  /** Throw this from the launch spawn. */
  launchThrows: Error | undefined
  /** Does the cgroup directory exist? A function so a test can make it vanish after N checks. */
  cgroupExists: () => boolean = () => false
  /** Does a binary exist? (Paths of scope cgroup directories are answered by {@link cgroupExists}.) */
  binaryExists: (path: string) => boolean = () => true
  procs = ''
  free: () => number = () => 10 * GIB
  /** What happens at a SIGKILL of the group. */
  onKill: (pid: number) => void = () => { this.lastLaunch.exit(null, 'SIGKILL') }
  /** The most recent launch handle. */
  lastLaunch: FakeHandle = this.launch
  killThrows: Error | undefined
  /** Is the launch leader still running? A function so a test can make it exit before the done promise settles. */
  alive: (pid: number) => boolean = () => true
  /** Throw this from `readProcs`. */
  procsThrows: Error | undefined
  hostEnv = ['HOME', 'PATH', 'SECRET_THING']
  clock = 0
  /** Longest a fake sleep lasts, in ms. */
  sleepCap = 1

  deps(): RunnerDeps {
    return {
      spawn: (spec) => {
        this.spawns.push(spec)
        if (spec.argv[0] === 'systemctl') {
          const next = this.stopSequence.length > 0 ? this.stopSequence.shift() as number | 'hang' | 'throw' : this.stopExit
          if (next === 'throw') throw new Error('no systemctl')
          const handle = new FakeHandle({ pid: 5000 + this.stops.length })
          this.stops.push(handle)
          if (next !== 'hang') handle.exit(next)
          return handle
        }
        if (this.launchThrows !== undefined) throw this.launchThrows
        this.lastLaunch = this.makeLaunch === undefined ? this.launch : this.makeLaunch()
        return this.lastLaunch
      },
      killGroup: (pid) => {
        this.kills.push(pid)
        if (this.killThrows !== undefined) throw this.killThrows
        this.onKill(pid)
      },
      leaderAlive: pid => this.alive(pid),
      freeBytes: () => this.free(),
      exists: path => (path.includes('/dsh-seat.') ? this.cgroupExists() : this.binaryExists(path)),
      readProcs: () => {
        if (this.procsThrows !== undefined) throw this.procsThrows
        return this.procs
      },
      hostEnvNames: () => this.hostEnv,
      now: () => { this.clock += 10; return this.clock },
      sleep: (ms, signal) => new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(ms, this.sleepCap))
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      }),
      warn: (message) => { this.warnings.push(message) },
    }
  }
}

export const BWRAP: SeatBwrapIdentity = { path: '/usr/bin/bwrap', ino: '1', mtimeNs: '2', size: '3' }

export function makePlan(over: Partial<SeatLaunchPlan> = {}): SeatLaunchPlan {
  return {
    argv: ['systemd-run', '--scope', 'bwrap', '--', '/bin/bash', '-c', 'echo hi'],
    scopeArgv: ['systemd-run'],
    bwrapArgv: ['bwrap'],
    bwrapProfileArgs: [],
    spawnEnv: { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/local/bin:/usr/bin:/bin' },
    sandboxEnv: {},
    unit: 'dsh-seat.coder.c1',
    stopArgv: ['systemctl', '--user', 'stop', 'dsh-seat.coder.c1.scope'],
    cgroupDir: '/sys/fs/cgroup/user.slice/dsh-seat.coder.c1.scope',
    cgroupProcsPath: '/sys/fs/cgroup/user.slice/dsh-seat.coder.c1.scope/cgroup.procs',
    chdir: '/work/clone',
    limits: { ...SEAT_DEFAULT_LIMITS },
    ...over,
  }
}

export function makeConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    deadlineS: 120,
    maxDeadlineS: 600,
    limits: {},
    minFreeBytes: GIB,
    home: '/home/op',
    nodeDir: '/opt/node',
    nodeBinDir: undefined,
    corepackHome: undefined,
    roPaths: [],
    pathDirs: [],
    deniedPaths: [],
    bwrapPath: '/usr/bin/bwrap',
    scratchDir: '/tmp',
    xdgRuntimeDir: '/run/user/1000',
    ...over,
  }
}

/** A seat closure: records warnings and taint marks; scrubs with the home `/home/op` only. */
export function makeContext(over: Partial<SeatToolContext> = {}): SeatToolContext & { warnings: string[]; marks: string[] } {
  const warnings: string[] = []
  const marks: string[] = []
  const context: SeatToolContext = {
    seat: 'coder-one',
    sendTo: [],
    allowBlocking: false,
    cwd: '/work/clone',
    isTainted: () => false,
    markTainted: (reason) => { marks.push(reason) },
    deliveredTraceIds: () => new Set(),
    publish: () => Promise.resolve(undefined),
    newTraceId: () => 't',
    warn: (message) => { warnings.push(message) },
    scrub: (text, options) => scrubText(text, { roots: ['/home/op'], ...options?.maxLength === undefined ? {} : { maxLength: options.maxLength } }),
    ...over,
  }
  return Object.assign(context, { warnings, marks })
}

/** Preflight dependencies over a fake world and fake host facts. */
export type FakePreflightDeps = PreflightDeps & { disposed: number; sysctlValues: Record<string, string> }

/** Preflight dependencies over a fake world. */
export function makePreflightDeps(world: FakeWorld, over: Partial<PreflightDeps> = {}): FakePreflightDeps {
  const state = { disposed: 0, sysctlValues: { 'kernel.unprivileged_userns_clone': '1', 'kernel.apparmor_restrict_unprivileged_userns': '0' } as Record<string, string> }
  const deps: PreflightDeps = {
    runner: world.deps(),
    attest: () => BWRAP,
    plan: spec => ({ ok: true, plan: makePlan({ chdir: spec.workdir ?? spec.cwd }) }),
    makeScratch: () => ({ dir: '/scratch', dispose: () => { state.disposed += 1 } }),
    release: () => '7.0.0-test',
    sysctl: name => state.sysctlValues[name] ?? 'absent',
    ...over,
  }
  Object.defineProperty(deps, 'disposed', { get: () => state.disposed })
  return Object.assign(deps, { sysctlValues: state.sysctlValues }) as FakePreflightDeps
}

/** `expect.stringContaining` typed as the string it stands in for, so it can sit in a typed matcher object. */
export const containing = (text: string): string => expect.stringContaining(text) as string
