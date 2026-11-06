/**
 * Seat profile builder tests. The unit half drives `planSeatLaunch` over real temp directories
 * (and an injected filesystem where the host cannot produce the condition: foreign devices,
 * unusual usr layouts, a changing bwrap) and asserts the EXACT argv plus every refusal. The
 * integration half (`describe.skipIf(!bwrapAvailable)`) runs the preflight battery of the S6 plan
 * against a real `git clone --no-hardlinks` of a tiny fixture repository, under a real
 * `systemd-run --user --scope` when the user manager is reachable. Every scope the tests start is
 * stopped in afterEach; sleeps are short and nothing is left running.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import type { SpawnSyncReturns } from 'node:child_process'
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  SEAT_DEFAULT_LIMITS,
  SeatRefusalError,
  attestBwrap,
  classifyScopeStop,
  defaultSeatFs,
  planSeatLaunch,
  planSeatLaunchWith,
  SEAT_FORBIDDEN_HOME_ENTRIES,
} from '../src/seat-profile.ts'
import type { SeatFs, SeatLaunchPlan, SeatProfileSpec } from '../src/seat-profile.ts'
import * as barrel from '../src/index.ts'

const GIB = 1024 ** 3
// A fake attested identity: the unit tests inject a matching `identity` read, so no real bwrap binary is needed.
const BWRAP_ID = { path: '/usr/bin/bwrap', ino: '11', mtimeNs: '22', size: '33' }
const fixedFs: Partial<SeatFs> = {
  identity: () => ({ ino: '11', mtimeNs: '22', size: '33' }),
  freeBytes: () => 10 * GIB,
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'seat-profile-')))
let counter = 0

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A fake host home with every protected entry present. */
function makeHome(): string {
  const home = join(root, `home-${counter++}`)
  for (const entry of [...SEAT_FORBIDDEN_HOME_ENTRIES, '.config/gh']) mkdirSync(join(home, entry), { recursive: true })
  return home
}

/** A minimal clone-shaped directory (no git binary needed). */
function makeClone(options: { nodeModules?: boolean } = {}): string {
  const clone = join(root, `clone-${counter++}`)
  mkdirSync(join(clone, '.git', 'hooks'), { recursive: true })
  mkdirSync(join(clone, '.git', 'objects'), { recursive: true })
  writeFileSync(join(clone, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(clone, '.git', 'config'), '[core]\n')
  writeFileSync(join(clone, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n')
  if (options.nodeModules === true) {
    for (const dir of ['.vite', '.vite-temp', '.cache', '.bin']) mkdirSync(join(clone, 'node_modules', dir), { recursive: true })
  }
  return clone
}

const nodeDir = join(root, 'node-install')
mkdirSync(join(nodeDir, 'bin'), { recursive: true })
const home = makeHome()

function spec(clone: string, over: Partial<SeatProfileSpec> = {}): SeatProfileSpec {
  return {
    seat: 'coder',
    callId: 'c1',
    command: 'echo hi',
    cwd: clone,
    home,
    nodeDir,
    deadlineS: 120,
    xdgRuntimeDir: '/run/user/1000',
    bwrap: BWRAP_ID,
    uid: 1000,
    ...over,
  }
}

function plan(clone: string, over: Partial<SeatProfileSpec> = {}, fs: Partial<SeatFs> = {}): SeatLaunchPlan {
  const result = planSeatLaunchWith(spec(clone, over), { fs: { ...fixedFs, ...fs } })
  if (!result.ok) throw new Error(`unexpected refusal ${result.refusal.message}`)
  return result.plan
}

function refusal(clone: string, over: Partial<SeatProfileSpec> = {}, fs: Partial<SeatFs> = {}): SeatRefusalError {
  const result = planSeatLaunchWith(spec(clone, over), { fs: { ...fixedFs, ...fs } })
  if (result.ok) throw new Error('expected a refusal')
  expect(result.refusal).toBeInstanceOf(SeatRefusalError)
  expect(result.refusal.reason.length).toBeGreaterThan(0)
  expect(result.refusal.remedy.length).toBeGreaterThan(0)
  return result.refusal
}

/** Wrap a real lstat result: overrides for specific absolute paths. */
function lstatOverride(map: Record<string, (real: Stats | undefined) => Stats | undefined>): SeatFs['lstat'] {
  return (path) => {
    const real = defaultSeatFs.lstat(path)
    const override = map[path]
    return override === undefined ? real : override(real)
  }
}

function tweak(stat: Stats | undefined, props: Partial<Record<'dev' | 'nlink' | 'mode', number>>): Stats {
  return Object.assign(Object.create(stat as Stats) as Stats, props)
}

describe('planSeatLaunch: the exact argv', () => {
  const usrLink = join(root, 'a-symlink')
  symlinkSync('usr/bin', usrLink)
  const usrFs: Partial<SeatFs> = {
    // usr-merge host: /bin and /lib are symlinks, /lib64 a real directory, /sbin absent.
    lstat: (path) => {
      if (path === '/bin' || path === '/lib') return defaultSeatFs.lstat(usrLink)
      if (path === '/lib64') return defaultSeatFs.lstat(root)
      if (path === '/sbin') return undefined
      if (path === '/usr/local') return defaultSeatFs.lstat(root)
      return defaultSeatFs.lstat(path)
    },
    readlink: path => `usr${path}`,
  }

  it('builds the complete vector for a provisioned clone', () => {
    const clone = makeClone({ nodeModules: true })
    const built = plan(clone, { command: 'pnpm test', callId: 'abc' }, usrFs)
    const nm = join(clone, 'node_modules')
    const path = `${nm}/.bin:${nodeDir}/bin:/usr/local/bin:/usr/bin:/bin`
    const expectedProfile = [
      '--die-with-parent',
      '--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
      '--new-session',
      '--cap-drop', 'ALL',
      '--clearenv',
      '--setenv', 'HOME', '/home/seat',
      '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'PATH', path,
      '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'TERM', 'dumb',
      '--setenv', 'USER', 'seat',
      '--setenv', 'SHELL', '/bin/bash',
      '--setenv', 'CI', '1',
      '--setenv', 'PWD', clone,
      '--setenv', 'COREPACK_HOME', '/home/seat/.cache/node/corepack',
      '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--tmpfs', '/usr/local',
      '--ro-bind-try', '/etc/passwd', '/etc/passwd',
      '--ro-bind-try', '/etc/group', '/etc/group',
      '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
      '--ro-bind-try', '/etc/localtime', '/etc/localtime',
      '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--ro-bind-try', '/etc/ld.so.conf', '/etc/ld.so.conf',
      '--ro-bind-try', '/etc/ld.so.conf.d', '/etc/ld.so.conf.d',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      '--proc', '/proc',
      '--dev', '/dev',
      '--size', '1073741824', '--tmpfs', '/tmp',
      '--size', '268435456', '--tmpfs', '/home/seat',
      '--ro-bind', nodeDir, nodeDir,
      '--bind', clone, clone,
      '--ro-bind', `${clone}/.git`, `${clone}/.git`,
      '--ro-bind', nm, nm,
      '--size', '268435456', '--tmpfs', `${nm}/.vite`,
      '--size', '268435456', '--tmpfs', `${nm}/.vite-temp`,
      '--size', '268435456', '--tmpfs', `${nm}/.cache`,
      '--remount-ro', '/usr/local',
      '--remount-ro', '/',
      '--chdir', clone,
    ]
    expect(built.bwrapProfileArgs).toEqual(expectedProfile)
    expect(built.bwrapArgv).toEqual([
      '/usr/bin/env', '-i', 'XDG_RUNTIME_DIR=/run/user/1000', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '/usr/bin/bwrap', ...expectedProfile, '--',
      '/usr/bin/prlimit', '--nproc=4096', '--nofile=8192', '--fsize=1073741824', '--core=0', '--cpu=130',
      '--', '/bin/bash', '-c', 'pnpm test',
    ])
    expect(built.scopeArgv).toEqual([
      'systemd-run', '--user', '--scope', '--unit', 'dsh-seat.coder.abc',
      '-p', 'TasksMax=1024', '-p', 'MemoryMax=6442450944', '-p', 'MemorySwapMax=0', '--quiet', '--',
    ])
    expect(built.argv).toEqual([...built.scopeArgv, ...built.bwrapArgv])
    expect(built.unit).toBe('dsh-seat.coder.abc')
    expect(built.stopArgv).toEqual(['systemctl', '--user', 'stop', 'dsh-seat.coder.abc.scope'])
    expect(built.cgroupDir).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-seat.coder.abc.scope')
    expect(built.cgroupProcsPath).toBe(`${built.cgroupDir}/cgroup.procs`)
    expect(built.spawnEnv).toEqual({ XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/local/bin:/usr/bin:/bin' })
    expect(built.chdir).toBe(clone)
    expect(built.limits).toEqual(SEAT_DEFAULT_LIMITS)
    expect(Object.keys(built.sandboxEnv)).toEqual(['HOME', 'TMPDIR', 'PATH', 'LANG', 'TERM', 'USER', 'SHELL', 'CI', 'PWD', 'COREPACK_HOME'])
  })

  it('omits the node_modules binds when absent, honours workdir, extras, limits, corepack and the default uid and cgroup root', () => {
    const clone = makeClone()
    mkdirSync(join(clone, 'sub'))
    const corepack = join(root, 'corepack-home')
    mkdirSync(corepack)
    const pnpm = join(root, 'pnpm-bin')
    mkdirSync(pnpm)
    const custom = spec(clone, {
      workdir: join(clone, 'sub'),
      extraEnv: { FOO: 'bar' },
      roPaths: [pnpm],
      corepackHome: corepack,
      pathDirs: [pnpm],
      nodeBinDir: join(nodeDir, 'bin'),
      limits: { tasksMax: 64, minFreeBytes: 1 },
      deadlineS: 5,
      callId: 'x',
      seat: 's',
    })
    delete custom.uid
    const built = planSeatLaunchWith(custom, { fs: fixedFs })
    expect(built.ok).toBe(true)
    const { plan: p } = built as { ok: true; plan: SeatLaunchPlan }
    expect(p.chdir).toBe(join(clone, 'sub'))
    expect(p.sandboxEnv.FOO).toBe('bar')
    expect(p.sandboxEnv.PWD).toBe(join(clone, 'sub'))
    expect(p.sandboxEnv.COREPACK_HOME).toBe(corepack)
    expect(p.sandboxEnv.PATH).toBe(`${clone}/node_modules/.bin:${nodeDir}/bin:${pnpm}:/usr/local/bin:/usr/bin:/bin`)
    expect(p.argv).toContain('TasksMax=64')
    expect(p.argv).toContain('--cpu=15')
    expect(p.bwrapProfileArgs.some(arg => arg === join(clone, 'node_modules') || arg === join(clone, 'node_modules', '.vite'))).toBe(false)
    expect(p.bwrapProfileArgs.lastIndexOf('--remount-ro')).toBe(p.bwrapProfileArgs.indexOf('--chdir') - 2)
    for (const bound of [pnpm, corepack]) {
      expect(p.bwrapProfileArgs.join(' ')).toContain(`--ro-bind ${bound} ${bound}`)
    }
    expect(p.cgroupDir).toMatch(/^\/sys\/fs\/cgroup\/user\.slice\/user-\d+\.slice\/user@\d+\.service\/app\.slice\/dsh-seat\.s\.x\.scope$/u)
  })

  it('uses a custom cgroup root', () => {
    expect(plan(makeClone(), { cgroupRoot: '/cg' }).cgroupDir).toBe('/cg/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-seat.coder.c1.scope')
  })

  it('runs against the real host filesystem defaults (usr layout, free space, no overrides)', () => {
    const clone = makeClone()
    const built = planSeatLaunchWith(spec(clone, { bwrap: attestBwrap(process.execPath) ?? BWRAP_ID, limits: { minFreeBytes: 1 } }), {})
    expect(built.ok).toBe(true)
    expect(built.ok && built.plan.bwrapProfileArgs).toContain('/usr')
  })

  it('hides /usr/local only when the host has one', () => {
    const none = plan(makeClone(), {}, { lstat: lstatOverride({ '/usr/local': () => undefined }) })
    expect(none.bwrapProfileArgs).not.toContain('/usr/local')
    const file = plan(makeClone(), {}, { lstat: lstatOverride({ '/usr/local': () => defaultSeatFs.lstat(join(root, 'a-symlink')) }) })
    expect(file.bwrapProfileArgs).not.toContain('/usr/local')
  })

  it('keeps the unit name unambiguous when seat or call id contain a dash', () => {
    const clone = makeClone()
    const one = plan(clone, { seat: 'a-b', callId: 'c' }).unit
    const two = plan(clone, { seat: 'a', callId: 'b-c' }).unit
    expect(one).not.toBe(two)
    expect([one, two]).toEqual(['dsh-seat.a-b.c', 'dsh-seat.a.b-c'])
  })

  it('the barrel exposes only the real-filesystem planner', () => {
    expect(barrel.planSeatLaunch).toBe(planSeatLaunch)
    expect('planSeatLaunchWith' in barrel).toBe(false)
    const refused = barrel.planSeatLaunch(spec(makeClone(), { bwrap: { ...BWRAP_ID, path: join(root, 'no-such-dir', 'bwrap') } }))
    expect(refused).toMatchObject({ ok: false, refusal: { code: 'bwrap-missing' } })
    expect(barrel.attestBwrap).toBe(attestBwrap)
  })
})

describe('planSeatLaunch: input refusals', () => {
  const clone = makeClone()

  it.each([
    ['seat-invalid', { seat: '' }],
    ['seat-invalid', { seat: '-x' }],
    ['seat-invalid', { seat: 'a b' }],
    ['call-id-invalid', { callId: 'a.b' }],
    ['call-id-invalid', { callId: 'x'.repeat(49) }],
    ['command-invalid', { command: '' }],
    ['command-invalid', { command: 'a\0b' }],
    ['deadline-invalid', { deadlineS: 0 }],
    ['deadline-invalid', { deadlineS: 1.5 }],
    ['limits-invalid', { limits: { tasksMax: 0 } }],
    ['limits-invalid', { limits: { memoryMaxBytes: 1.5 } }],
    ['home-invalid', { home: 'relative/home' }],
    ['home-invalid', { home: '/home/x\0' }],
    ['xdg-runtime-dir-missing', { xdgRuntimeDir: undefined }],
    ['xdg-runtime-dir-missing', { xdgRuntimeDir: 'run/user/1000' }],
    ['xdg-runtime-dir-missing', { xdgRuntimeDir: '/run/\0' }],
    ['env-invalid', { extraEnv: { 'BAD NAME': 'x' } }],
    ['env-invalid', { extraEnv: { NODE_OPTIONS: '--require x' } }],
    ['env-invalid', { extraEnv: { GIT_DIR: '/x' } }],
    ['env-invalid', { extraEnv: { CLAUDE_CONFIG_DIR: '/x' } }],
    ['env-invalid', { extraEnv: { ANTHROPIC_API_KEY: 'x' } }],
    ['env-invalid', { extraEnv: { LD_PRELOAD: '/x' } }],
    ['env-invalid', { extraEnv: { HOME: '/elsewhere' } }],
    ['env-invalid', { extraEnv: { OK_NAME: 'a\0b' } }],
    ['env-invalid', { extraEnv: { BASH_ENV: '/x' } }],
    ['env-invalid', { extraEnv: { ENV: '/x' } }],
    ['env-invalid', { extraEnv: { 'BASH_FUNC_x%%': '() { :; }' } }],
    ['env-invalid', { extraEnv: { SHELLOPTS: 'xtrace' } }],
    ['env-invalid', { extraEnv: { BASHOPTS: 'x' } }],
    ['env-invalid', { extraEnv: { PS4: 'x' } }],
    ['env-invalid', { extraEnv: { PROMPT_COMMAND: 'x' } }],
    ['env-invalid', { extraEnv: { GLIBC_TUNABLES: 'x' } }],
    ['env-invalid', { extraEnv: { GCONV_PATH: 'x' } }],
    ['env-invalid', { extraEnv: { LOCPATH: 'x' } }],
    ['env-invalid', { extraEnv: { NPM_CONFIG_REGISTRY: 'x' } }],
    ['env-invalid', { extraEnv: { npm_config_registry: 'x' } }],
    ['env-invalid', { extraEnv: { COREPACK_ENABLE_NETWORK: '1' } }],
    ['env-invalid', { extraEnv: { COREPACK_HOME: '/x' } }],
    ['env-invalid', { extraEnv: { PYTHONSTARTUP: 'x' } }],
    ['env-invalid', { extraEnv: { PERL5OPT: 'x' } }],
    ['env-invalid', { pathDirs: ['/a:b'] }],
    ['env-invalid', { pathDirs: ['/a\nb'] }],
    ['denied-path-invalid', { deniedPaths: ['relative'] }],
    ['denied-path-invalid', { deniedPaths: ['/a\0b'] }],
    ['bwrap-invalid', { bwrap: { ...BWRAP_ID, path: 'bwrap' } }],
    ['bwrap-invalid', { bwrap: { ...BWRAP_ID, path: '/opt/x=y/bwrap' } }],
    ['bwrap-invalid', { bwrap: { ...BWRAP_ID, path: '/usr/bin/bw\0rap' } }],
    ['home-invalid', { home: '/home/a\nb' }],
    ['cwd-not-absolute', { cwd: '/tmp/a\nb' }],
    ['env-invalid', { pathDirs: ['relative'] }],
  ] as const)('refuses %s for %j', (code, over) => {
    expect(refusal(clone, over as Partial<SeatProfileSpec>).code).toBe(code)
  })

  it('refuses when /usr/bin/env is missing', () => {
    expect(refusal(clone, {}, { lstat: lstatOverride({ '/usr/bin/env': () => undefined }) }).code).toBe('env-binary-missing')
  })

  it('turns a filesystem errno into a typed refusal and rethrows anything else', () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const err = refusal(clone, {}, { lstat: () => { throw denied } })
    expect(err.code).toBe('fs-error')
    expect(err.reason).toContain('EACCES')
    expect(() => planSeatLaunchWith(spec(clone), { fs: { ...fixedFs, lstat: () => { throw new Error('boom') } } })).toThrow('boom')
  })

  it('refuses when bwrap is missing or its identity changed (each attested field)', () => {
    expect(refusal(clone, {}, { identity: () => undefined }).code).toBe('bwrap-missing')
    for (const changed of [{ ino: '99' }, { mtimeNs: '99' }, { size: '99' }]) {
      const err = refusal(clone, {}, { identity: () => ({ ino: '11', mtimeNs: '22', size: '33', ...changed }) })
      expect(err.code).toBe('bwrap-changed')
    }
  })

  it('refuses when the free-space floor is not met', () => {
    expect(refusal(clone, {}, { freeBytes: () => GIB - 1 }).code).toBe('disk-floor')
    expect(plan(clone, {}, { freeBytes: () => GIB }).argv.length).toBeGreaterThan(0)
  })

  it('classifies a scope stop only as success once the cgroup is gone', () => {
    expect(classifyScopeStop(0, true)).toBe('stopped')
    expect(classifyScopeStop(5, true)).toBe('absent')
    expect(classifyScopeStop(1, true)).toBe('environment-failure')
    expect(classifyScopeStop(1, false)).toBe('environment-failure')
    expect(classifyScopeStop(0, false)).toBe('failed')
    expect(classifyScopeStop(5, false)).toBe('failed')
    expect(classifyScopeStop(null, true)).toBe('failed')
    expect(classifyScopeStop(2, true)).toBe('failed')
  })
})

describe('planSeatLaunch: cwd and path refusals', () => {
  it('refuses a relative cwd, a leading dash and a NUL', () => {
    const clone = makeClone()
    expect(refusal(clone, { cwd: 'relative/dir' }).code).toBe('cwd-not-absolute')
    expect(refusal(clone, { cwd: `${clone}\0x` }).code).toBe('cwd-not-absolute')
    expect(refusal(clone, { cwd: '-rf' }).code).toBe('cwd-leading-dash')
    expect(refusal(clone, { cwd: '-/abs' }).code).toBe('cwd-leading-dash')
  })

  it('refuses a missing cwd, a file cwd, a workdir problem', () => {
    const clone = makeClone()
    expect(refusal(clone, { cwd: join(root, 'nope') }).code).toBe('cwd-missing')
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    expect(refusal(clone, { cwd: file }).code).toBe('cwd-not-directory')
    expect(refusal(clone, { workdir: join(clone, 'missing') }).code).toBe('cwd-missing')
    expect(refusal(clone, { workdir: root }).code).toBe('workdir-outside-clone')
    mkdirSync(join(clone, 'sub-ok'))
    expect(plan(clone, { workdir: join(clone, 'sub-ok') }).chdir).toBe(join(clone, 'sub-ok'))
  })

  it('refuses symlink components, dot-dot, trailing slash and a workdir that leaves the clone through a symlink', () => {
    const clone = makeClone()
    const link = join(root, `link-${counter++}`)
    symlinkSync(clone, link)
    const err = refusal(clone, { cwd: link })
    expect(err.code).toBe('cwd-symlink')
    expect(err.remedy).toContain(clone)
    expect(refusal(clone, { cwd: `${clone}/` }).code).toBe('cwd-symlink')
    expect(refusal(clone, { cwd: `${clone}/../${basename(clone)}` }).code).toBe('cwd-symlink')
    const outside = join(root, `outside-${counter++}`)
    mkdirSync(outside)
    symlinkSync(outside, join(clone, 'escape'))
    expect(refusal(clone, { workdir: join(clone, 'escape') }).code).toBe('cwd-symlink')
  })

  it('refuses a cwd or read-only path that is, contains or sits inside a protected path', () => {
    const clone = makeClone()
    expect(refusal(clone, { cwd: home }).code).toBe('path-denied')
    expect(refusal(clone, { cwd: root }).code).toBe('path-denied')
    expect(refusal(clone, { cwd: join(home, '.claude') }).code).toBe('path-denied')
    expect(refusal(clone, { cwd: join(home, '.config', 'gh', 'x') }, { lstat: path => (path === join(home, '.config', 'gh', 'x') ? defaultSeatFs.lstat(root) : defaultSeatFs.lstat(path)) }).code).toBe('path-denied')
    const policy = join(root, `policy-${counter++}`)
    mkdirSync(policy)
    expect(refusal(clone, { cwd: policy, deniedPaths: [policy] }).code).toBe('path-denied')
    const farHome = join(root, `far-home-${counter++}`)
    mkdirSync(join(farHome, '.ssh'), { recursive: true })
    const secrets = join(root, `secrets-${counter++}`)
    mkdirSync(secrets)
    rmSync(join(farHome, '.ssh'), { recursive: true })
    symlinkSync(secrets, join(farHome, '.ssh'))
    expect(refusal(clone, { cwd: secrets, home: farHome }).code).toBe('path-denied')
    for (const bad of [home, join(home, '.ssh'), join(home, '.dsh'), join(home, '.agents'), root]) {
      expect(refusal(clone, { roPaths: [bad] }).code).toBe('path-denied')
    }
    expect(refusal(clone, { nodeDir: join(home, '.claude') }).code).toBe('path-denied')
    expect(refusal(clone, { corepackHome: join(home, '.ssh') }).code).toBe('path-denied')
  })

  it('treats a child named ..x as inside its parent, not as an escape', () => {
    const clone = makeClone()
    const sneaky = join(home, '.ssh', '..x')
    mkdirSync(sneaky)
    expect(refusal(clone, { cwd: sneaky }).code).toBe('path-denied')
    expect(refusal(clone, { roPaths: [sneaky] }).code).toBe('path-denied')
    mkdirSync(join(clone, '..cache'))
    expect(plan(clone, { workdir: join(clone, '..cache') }).chdir).toBe(join(clone, '..cache'))
  })

  it('protects every credential directory in the host home', () => {
    const clone = makeClone()
    for (const entry of SEAT_FORBIDDEN_HOME_ENTRIES) {
      expect(refusal(clone, { roPaths: [join(home, entry)] }).code).toBe('path-denied')
    }
  })

  it('refuses read-only paths that are relative, dashed, missing or symlinked', () => {
    const clone = makeClone()
    expect(refusal(clone, { roPaths: ['relative'] }).code).toBe('ro-path-invalid')
    expect(refusal(clone, { roPaths: ['-x'] }).code).toBe('ro-path-invalid')
    expect(refusal(clone, { roPaths: [join(root, 'absent')] }).code).toBe('ro-path-invalid')
    const link = join(root, `ro-link-${counter++}`)
    symlinkSync(nodeDir, link)
    expect(refusal(clone, { roPaths: [link] }).code).toBe('cwd-symlink')
  })
})

describe('planSeatLaunch: .git and node_modules refusals', () => {
  it('refuses a missing .git, a worktree-style .git file, a symlinked .git and alternates', () => {
    const noGit = makeClone()
    rmSync(join(noGit, '.git'), { recursive: true })
    expect(refusal(noGit).code).toBe('git-missing')
    const file = makeClone()
    rmSync(join(file, '.git'), { recursive: true })
    writeFileSync(join(file, '.git'), 'gitdir: /elsewhere\n')
    expect(refusal(file).code).toBe('git-file')
    const link = makeClone()
    const real = join(root, `real-git-${counter++}`)
    renameGit(link, real)
    symlinkSync(real, join(link, '.git'))
    expect(refusal(link).code).toBe('git-incomplete')
    const alt = makeClone()
    mkdirSync(join(alt, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(alt, '.git', 'objects', 'info', 'alternates'), '/elsewhere/objects\n')
    expect(refusal(alt).code).toBe('git-alternates')
  })

  it('refuses incomplete HEAD and config', () => {
    const noHead = makeClone()
    rmSync(join(noHead, '.git', 'HEAD'))
    expect(refusal(noHead).code).toBe('git-incomplete')
    const dirConfig = makeClone()
    rmSync(join(dirConfig, '.git', 'config'))
    mkdirSync(join(dirConfig, '.git', 'config'))
    expect(refusal(dirConfig).code).toBe('git-incomplete')
  })

  it('refuses hard-linked HEAD, config and hook entries', () => {
    for (const name of ['HEAD', 'config', join('hooks', 'pre-commit.sample')]) {
      const clone = makeClone()
      linkSync(join(clone, '.git', name), join(root, `alias-${counter++}`))
      const err = refusal(clone)
      expect(err.code).toBe('hardlinked-file')
      expect(err.reason).toContain(name)
    }
  })

  it('accepts a missing hooks directory, a nested hooks directory, and a hook entry that vanishes mid-scan', () => {
    const noHooks = makeClone()
    rmSync(join(noHooks, '.git', 'hooks'), { recursive: true })
    expect(plan(noHooks).argv.length).toBeGreaterThan(0)
    const nested = makeClone()
    mkdirSync(join(nested, '.git', 'hooks', 'nested'))
    expect(plan(nested).argv.length).toBeGreaterThan(0)
    const vanish = makeClone()
    const gone = join(vanish, '.git', 'hooks', 'pre-commit.sample')
    let calls = 0
    const vanishing: SeatFs['lstat'] = (p) => {
      if (p !== gone) return defaultSeatFs.lstat(p)
      calls++
      return undefined
    }
    expect(plan(vanish, {}, { lstat: vanishing }).argv.length).toBeGreaterThan(0)
    expect(calls).toBe(1)
  })

  it('refuses a hooks entry that is not a directory', () => {
    const clone = makeClone()
    rmSync(join(clone, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(clone, '.git', 'hooks'), 'not a dir')
    expect(refusal(clone).code).toBe('git-incomplete')
  })

  it('refuses setuid and setgid files among the checked paths', () => {
    for (const [name, mode] of [['HEAD', 0o4644], ['config', 0o2644], [join('hooks', 'pre-commit.sample'), 0o4755]] as const) {
      const clone = makeClone()
      chmodSync(join(clone, '.git', name), mode)
      expect(refusal(clone).code).toBe('setuid-file')
    }
  })

  it('does not treat a setgid directory as a setuid file', () => {
    const clone = makeClone()
    chmodSync(join(clone, '.git', 'hooks'), 0o2755)
    expect(plan(clone).argv.length).toBeGreaterThan(0)
  })

  it('refuses foreign-device entries: another filesystem and device files', () => {
    const otherDev = makeClone()
    const head = join(otherDev, '.git', 'HEAD')
    expect(refusal(otherDev, {}, { lstat: lstatOverride({ [head]: real => tweak(real, { dev: 999_999 }) }) }).code).toBe('foreign-device')
    const gitDir = makeClone()
    const git = join(gitDir, '.git')
    expect(refusal(gitDir, {}, { lstat: lstatOverride({ [git]: real => tweak(real, { dev: 999_999 }) }) }).code).toBe('foreign-device')
    const chr = makeClone()
    const hook = join(chr, '.git', 'hooks', 'pre-commit.sample')
    expect(refusal(chr, {}, { lstat: lstatOverride({ [hook]: real => tweak(real, { mode: 0o020_666 }) }) }).code).toBe('foreign-device')
    const blk = makeClone({ nodeModules: true })
    const nm = join(blk, 'node_modules')
    expect(refusal(blk, {}, { lstat: lstatOverride({ [nm]: real => tweak(real, { dev: 999_999 }) }) }).code).toBe('foreign-device')
  })

  it('refuses a node_modules that is a symlink or a file', () => {
    const link = makeClone()
    const target = join(root, `nm-target-${counter++}`)
    mkdirSync(target)
    symlinkSync(target, join(link, 'node_modules'))
    expect(refusal(link).code).toBe('node-modules-invalid')
    const file = makeClone()
    writeFileSync(join(file, 'node_modules'), 'x')
    expect(refusal(file).code).toBe('node-modules-invalid')
  })

  it('refuses a clone that is not provisioned, naming the missing directory', () => {
    for (const dir of ['.vite', '.vite-temp', '.cache']) {
      const clone = makeClone({ nodeModules: true })
      rmSync(join(clone, 'node_modules', dir), { recursive: true })
      const err = refusal(clone)
      expect(err.code).toBe('not-provisioned')
      expect(err.reason).toBe(`clone not provisioned: missing ${join(clone, 'node_modules', dir)}`)
    }
    const notDir = makeClone({ nodeModules: true })
    rmSync(join(notDir, 'node_modules', '.cache'), { recursive: true })
    writeFileSync(join(notDir, 'node_modules', '.cache'), 'x')
    expect(refusal(notDir).reason).toContain('is not a plain directory')
  })
})

describe('SeatFs defaults', () => {
  it('maps missing paths to undefined and rethrows other errors', () => {
    const file = join(root, `plain-${counter++}`)
    writeFileSync(file, 'x')
    expect(defaultSeatFs.lstat(join(root, 'does-not-exist'))).toBeUndefined()
    expect(defaultSeatFs.lstat(join(file, 'below-a-file'))).toBeUndefined()
    expect(defaultSeatFs.realpath(join(root, 'does-not-exist'))).toBeUndefined()
    expect(defaultSeatFs.identity(join(root, 'does-not-exist'))).toBeUndefined()
    const loop = join(root, `loop-${counter++}`)
    symlinkSync(loop, loop)
    expect(() => defaultSeatFs.lstat(join(loop, 'x'))).toThrow(/ELOOP/u)
    expect(planSeatLaunchWith(spec(join(loop, 'x')), { fs: fixedFs })).toMatchObject({ ok: false, refusal: { code: 'fs-error' } })
    expect(defaultSeatFs.readdir(root)).toContain(basename(file))
    expect(defaultSeatFs.readlink(loop)).toBe(loop)
    expect(defaultSeatFs.freeBytes(root)).toBeGreaterThan(0)
  })

  it('attests a binary by inode, mtime and size, or reports it missing', () => {
    const id = attestBwrap(process.execPath)
    expect(id).toMatchObject({ path: process.execPath })
    expect(id?.ino).toMatch(/^\d+$/u)
    expect(id?.size).toMatch(/^\d+$/u)
    expect(attestBwrap(join(root, 'no-bwrap'))).toBeUndefined()
    expect(attestBwrap('/x', { ...defaultSeatFs, identity: () => ({ ino: '1', mtimeNs: '2', size: '3' }) })).toEqual({ path: '/x', ino: '1', mtimeNs: '2', size: '3' })
  })
})

function renameGit(clone: string, to: string): void {
  spawnSync('mv', [join(clone, '.git'), to])
}

// ---------------------------------------------------------------------------------------------
// Integration: the preflight battery against a real `git clone --no-hardlinks` clone.
// ---------------------------------------------------------------------------------------------

const BWRAP = '/usr/bin/bwrap'
const bwrapAvailable = existsSync(BWRAP)
  && spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
const xdg = process.env.XDG_RUNTIME_DIR
const scopeAvailable = bwrapAvailable
  && xdg !== undefined
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', '/usr/bin/true'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: xdg } }).status === 0

describe.skipIf(!bwrapAvailable)('seat sandbox preflight battery (real bwrap)', () => {
  const units: string[] = []
  let seatHome: string
  let sibling: string
  let fixtureSource: string
  let nodeInstall: string
  const typescriptDir = findTypescript()

  function git(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
    return spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: seatHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  }

  /** A fresh `git clone --no-hardlinks` of the fixture repo, provisioned like a seat clone. */
  function provisionedClone(): string {
    const clone = join(root, `real-clone-${counter++}`)
    expect(git(root, 'clone', '--no-hardlinks', '--quiet', fixtureSource, clone).status).toBe(0)
    for (const dir of ['.vite', '.vite-temp', '.cache', '.bin', 'pkg']) mkdirSync(join(clone, 'node_modules', dir), { recursive: true })
    writeFileSync(join(clone, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    return clone
  }

  function realSpec(clone: string, command: string, over: Partial<SeatProfileSpec> = {}): SeatProfileSpec {
    const bwrap = attestBwrap(BWRAP)
    if (bwrap === undefined) throw new Error('bwrap vanished')
    return {
      seat: 'itest',
      callId: `c${counter++}p${process.pid}`,
      command,
      cwd: clone,
      home: seatHome,
      nodeDir: nodeInstall,
      deadlineS: 60,
      xdgRuntimeDir: xdg,
      bwrap,
      ...over,
    }
  }

  function realPlan(clone: string, command: string, over: Partial<SeatProfileSpec> = {}): SeatLaunchPlan {
    const result = planSeatLaunch(realSpec(clone, command, over))
    if (!result.ok) throw new Error(`refused: ${result.refusal.message}`)
    units.push(result.plan.unit)
    return result.plan
  }

  /** Run a plan to completion (under the scope when the user manager is reachable). */
  function exec(built: SeatLaunchPlan, extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
    const argv = scopeAvailable ? built.argv : built.bwrapArgv
    return spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8', timeout: 60_000, env: { ...built.spawnEnv, ...extraEnv } })
  }

  function sh(clone: string, command: string, over: Partial<SeatProfileSpec> = {}): SpawnSyncReturns<string> {
    return exec(realPlan(clone, command, over))
  }

  function stopUnit(unit: string, environment: Record<string, string> = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: xdg ?? '' }): SpawnSyncReturns<string> {
    return spawnSync('systemctl', ['--user', 'stop', `${unit}.scope`], { encoding: 'utf8', env: environment })
  }

  beforeAll(() => {
    seatHome = join(root, 'real-home')
    for (const entry of ['.ssh', '.claude']) mkdirSync(join(seatHome, entry), { recursive: true })
    writeFileSync(join(seatHome, '.ssh', 'id_secret'), 'PLANTED-HOME-SECRET\n')
    sibling = join(root, 'sibling')
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'secret.txt'), 'PLANTED-SIBLING-SECRET\n')
    nodeInstall = dirname(dirname(realpathSync(process.execPath)))
    fixtureSource = join(root, 'fixture-src')
    mkdirSync(fixtureSource)
    expect(git(fixtureSource, 'init', '--quiet', '-b', 'main').status).toBe(0)
    writeFileSync(join(fixtureSource, 'hello.txt'), 'hello\n')
    writeFileSync(join(fixtureSource, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true,"types":[],"lib":["es2022"]},"files":["a.ts"]}\n')
    writeFileSync(join(fixtureSource, 'a.ts'), 'export const a: number = 1\n')
    expect(git(fixtureSource, 'add', '.').status).toBe(0)
    expect(git(fixtureSource, 'commit', '--quiet', '-m', 'fixture').status).toBe(0)
  })

  afterEach(() => {
    for (const unit of units.splice(0)) stopUnit(unit)
  })

  it('runs a trivial command and sees the clone at its real path', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'pwd; cat hello.txt; echo "$HOME"')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${clone}\nhello\n/home/seat\n`)
  })

  it('refuses writes to /usr, /etc and / but allows the clone and /tmp', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'touch /usr/x 2>/dev/null; echo usr=$?; touch /etc/x 2>/dev/null; echo etc=$?; touch /x 2>/dev/null; echo root=$?; echo ok > fromseat.txt; echo clone=$?; echo t > /tmp/x; echo tmp=$?')
    expect(result.stdout.trim().split('\n')).toEqual(['usr=1', 'etc=1', 'root=1', 'clone=0', 'tmp=0'])
    expect(readFileSync(join(clone, 'fromseat.txt'), 'utf8')).toBe('ok\n')
  })

  it('keeps /home/seat writable after the root remount, and hides the host /usr/local', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'touch /home/seat/x; echo home=$?; ls -A /usr/local | wc -l; touch /usr/local/y 2>/dev/null; echo local=$?')
    expect(result.stdout.trim().split('\n')).toEqual(['home=0', '0', 'local=1'])
  })

  it('cannot create a nested user namespace (--disable-userns)', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'unshare -Ur true 2>/dev/null; echo unshare=$?')
    expect(result.stdout.trim()).not.toBe('unshare=0')
    expect(result.stdout.trim()).toMatch(/^unshare=[1-9]/u)
  })

  it('cannot reach a host loopback listener or a host abstract socket', async () => {
    const clone = provisionedClone()
    const tcp: Server = createServer()
    const abstract: Server = createServer()
    await new Promise<void>((resolve) => { tcp.listen(0, '127.0.0.1', resolve) })
    const name = `\0seat-profile-${process.pid}-${counter++}`
    await new Promise<void>((resolve) => { abstract.listen(name, resolve) })
    try {
      const port = (tcp.address() as { port: number }).port
      const probe = (target: string): string => `node -e 'const s=require("net").connect(${target});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(4),3000)'`
      const abstractTarget = `{path:"\\u0000${name.slice(1)}"}`
      const result = sh(clone, `${probe(`{host:"127.0.0.1",port:${port}}`)}; echo tcp=$?; ${probe(abstractTarget)}; echo abstract=$?`)
      expect(result.stdout.trim().split('\n')).toEqual(['tcp=3', 'abstract=3'])
    } finally {
      tcp.close()
      abstract.close()
    }
  })

  it('cannot read a planted secret in a sibling of cwd or in a fake home', () => {
    const clone = provisionedClone()
    const result = sh(clone, `cat ${join(sibling, 'secret.txt')} 2>&1; cat ${join(seatHome, '.ssh', 'id_secret')} 2>&1; ls -A /home/seat | wc -l; test -e ${join(seatHome, '.claude')}; echo claude=$?`)
    expect(result.stdout).not.toContain('PLANTED')
    expect(result.stdout).toContain('No such file or directory')
    expect(result.stdout).toMatch(/\n0\nclaude=1\n$/u)
  })

  it('has only the loopback interface and only sandbox pids in /proc', () => {
    const clone = provisionedClone()
    const result = sh(clone, "awk -F: 'NR>2{gsub(/ /,\"\",$1); print $1}' /proc/net/dev; echo --; ls /proc | grep -E '^[0-9]+$' | wc -l")
    const [interfaces, count] = result.stdout.split('--\n')
    expect(interfaces?.trim()).toBe('lo')
    expect(Number(count)).toBeLessThan(10)
  })

  it('the F1 rename sequence leaves the host .git untouched; git status works, git add fails', () => {
    const clone = provisionedClone()
    const before = readdirSync(join(clone, '.git')).sort()
    const headBefore = readFileSync(join(clone, '.git', 'HEAD'), 'utf8')
    writeFileSync(join(clone, 'new.txt'), 'new\n')
    const result = sh(clone, 'mv .git .git.old 2>/dev/null; echo mv=$?; mkdir .git 2>/dev/null; echo mkdir=$?; echo evil > .git/hooks/pre-commit 2>/dev/null; echo plant=$?; git status --porcelain; echo status=$?; git add new.txt 2>/dev/null; echo add=$?')
    const lines = result.stdout.trim().split('\n')
    expect(lines).toContain('mv=1')
    expect(lines).toContain('mkdir=1')
    expect(lines).toContain('plant=1')
    expect(lines).toContain('?? new.txt')
    expect(lines).toContain('status=0')
    expect(lines).toContain('add=128')
    expect(readdirSync(join(clone, '.git')).sort()).toEqual(before)
    expect(readFileSync(join(clone, '.git', 'HEAD'), 'utf8')).toBe(headBefore)
    expect(existsSync(join(clone, '.git.old'))).toBe(false)
    expect(existsSync(join(clone, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('refuses a write into node_modules, but the three cache tmpfs mounts are writable', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'touch node_modules/x 2>/dev/null; echo nm=$?; touch node_modules/pkg/y 2>/dev/null; echo pkg=$?; for d in .vite .vite-temp .cache; do touch node_modules/$d/ok; echo $d=$?; done')
    expect(result.stdout.trim().split('\n')).toEqual(['nm=1', 'pkg=1', '.vite=0', '.vite-temp=0', '.cache=0'])
    expect(existsSync(join(clone, 'node_modules', '.vite', 'ok'))).toBe(false)
  })

  it('has an environment that equals the allowed set (host variables never leak)', () => {
    const clone = provisionedClone()
    const built = realPlan(clone, 'exec /usr/bin/env', { extraEnv: { EXTRA_OK: 'yes' } })
    const result = exec(built, { NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'leak', CLAUDE_CONFIG_DIR: '/leak', GIT_DIR: '/leak', SECRET_X: 'leak' })
    expect(result.status).toBe(0)
    const seen: Record<string, string> = {}
    for (const line of result.stdout.trim().split('\n')) {
      const at = line.indexOf('=')
      seen[line.slice(0, at)] = line.slice(at + 1)
    }
    delete seen._
    delete seen.SHLVL
    expect(seen).toEqual(built.sandboxEnv)
    expect(seen.EXTRA_OK).toBe('yes')
  })

  it('starts bwrap itself (pid 1 inside) with exactly the spawn environment, whatever the caller passes', () => {
    const clone = provisionedClone()
    const built = realPlan(clone, "tr '\\0' '\\n' </proc/1/environ | cut -d= -f1 | sort")
    const result = exec(built, { NODE_OPTIONS: '--inspect', GIT_DIR: '/leak', CLAUDE_CONFIG_DIR: '/leak', ANTHROPIC_API_KEY: 'leak', BASH_ENV: '/leak' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(Object.keys(built.spawnEnv).sort())
  })

  it('runs node from the bound installation and refuses a leading-dash or symlinked cwd', () => {
    const clone = provisionedClone()
    const result = sh(clone, 'node -p "process.versions.node.split(\'.\')[0]"')
    expect(result.stdout.trim()).toBe(process.versions.node.split('.')[0])
    expect(planSeatLaunch(realSpec('-clone', 'true'))).toMatchObject({ ok: false, refusal: { code: 'cwd-leading-dash' } })
    const link = join(root, `escape-link-${counter++}`)
    symlinkSync(sibling, link)
    expect(planSeatLaunch(realSpec(link, 'true'))).toMatchObject({ ok: false, refusal: { code: 'cwd-symlink' } })
    expect(planSeatLaunch(realSpec(clone, 'true', { workdir: join(clone, '..', basename(sibling)) }))).toMatchObject({ ok: false, refusal: { code: 'workdir-outside-clone' } })
    expect(planSeatLaunch(realSpec(clone, 'true', { workdir: `${clone}/../${basename(clone)}` }))).toMatchObject({ ok: false, refusal: { code: 'cwd-symlink' } })
  })

  it.skipIf(typescriptDir === undefined)('smoke: tsc --noEmit passes against the read-only node_modules with no EROFS', () => {
    const clone = provisionedClone()
    cpSync(typescriptDir as string, join(clone, 'node_modules', 'typescript'), { recursive: true })
    const result = sh(clone, 'node node_modules/typescript/bin/tsc --noEmit -p . 2>&1; echo tsc=$?')
    expect(result.stdout).not.toContain('EROFS')
    expect(result.stdout.trim().endsWith('tsc=0')).toBe(true)
  })

  describe.skipIf(!scopeAvailable)('under the cgroup scope', () => {
    it('applies TasksMax and MemoryMax to the cgroup the plan names', async () => {
      const clone = provisionedClone()
      const built = realPlan(clone, 'sleep 20')
      const child = spawn(built.argv[0] as string, built.argv.slice(1), { env: built.spawnEnv, stdio: 'ignore' })
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      for (let i = 0; i < 100 && !existsSync(built.cgroupDir); i++) await new Promise(resolve => setTimeout(resolve, 50))
      expect(existsSync(built.cgroupDir)).toBe(true)
      expect(readFileSync(join(built.cgroupDir, 'pids.max'), 'utf8').trim()).toBe('1024')
      expect(readFileSync(join(built.cgroupDir, 'memory.swap.max'), 'utf8').trim()).toBe('0')
      expect(readFileSync(join(built.cgroupDir, 'memory.max'), 'utf8').trim()).toBe(String(6 * GIB))
      expect(readFileSync(built.cgroupProcsPath, 'utf8').trim().length).toBeGreaterThan(0)
      const stop = stopUnit(built.unit)
      await exited
      expect(classifyScopeStop(stop.status, !existsSync(built.cgroupDir))).toBe('stopped')
    })

    it('a leader that exits early leaves orphans; the stop empties the cgroup and only a vanished directory counts', () => {
      const clone = provisionedClone()
      const built = realPlan(clone, 'true')
      const leader = spawnSync(built.scopeArgv[0] as string, [...built.scopeArgv.slice(1), '/bin/sh', '-c', 'setsid sleep 60 </dev/null >/dev/null 2>&1 & exit 0'], { stdio: 'ignore', env: built.spawnEnv })
      expect(leader.status).toBe(0)
      expect(existsSync(built.cgroupDir)).toBe(true)
      expect(readFileSync(built.cgroupProcsPath, 'utf8').trim().length).toBeGreaterThan(0)
      const stop = stopUnit(built.unit)
      expect(stop.status).toBe(0)
      expect(existsSync(built.cgroupDir)).toBe(false)
      expect(classifyScopeStop(stop.status, !existsSync(built.cgroupDir))).toBe('stopped')
      const again = stopUnit(built.unit)
      expect(again.status).toBe(5)
      expect(classifyScopeStop(again.status, !existsSync(built.cgroupDir))).toBe('absent')
    })

    it('the pid-namespace kill: setsid orphans of an early-exiting leader die with the sandbox pid 1 (the bare-leader test above is the stop proof)', () => {
      const clone = provisionedClone()
      const built = realPlan(clone, 'setsid sleep 60 </dev/null >/dev/null 2>&1 & sleep 0.2; exit 0')
      expect(exec(built).status).toBe(0)
      const stop = stopUnit(built.unit)
      expect(existsSync(built.cgroupDir)).toBe(false)
      expect(['stopped', 'absent']).toContain(classifyScopeStop(stop.status, !existsSync(built.cgroupDir)))
    })

    it('contains a bounded fork bomb under TasksMax while the host keeps forking', async () => {
      const clone = provisionedClone()
      const built = realPlan(clone, 'exec 2>/dev/null; for i in $(seq 1 300); do sleep 20.123 & done; sleep 8', { limits: { tasksMax: 64 } })
      const count = (): number => Number(spawnSync('pgrep', ['-fc', '^sleep 20\\.123$'], { encoding: 'utf8' }).stdout.trim() || '0')
      const child = spawn(built.argv[0] as string, built.argv.slice(1), { env: built.spawnEnv, stdio: 'ignore' })
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      let seen = 0
      for (let i = 0; i < 100 && seen < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        seen = count()
      }
      await new Promise(resolve => setTimeout(resolve, 500))
      seen = count()
      expect(seen).toBeGreaterThanOrEqual(20)
      expect(seen).toBeLessThanOrEqual(64)
      expect(readFileSync(built.cgroupProcsPath, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(64)
      expect(spawnSync('/usr/bin/true').status).toBe(0)
      stopUnit(built.unit)
      await exited
      expect(count()).toBe(0)
    })

    it('reports an unreachable user bus as an environment failure, never a pass', () => {
      const stop = stopUnit('dsh-seat-itest-nobus', { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: join(root, 'no-runtime-dir') })
      expect(stop.status).toBe(1)
      expect(classifyScopeStop(stop.status, true)).toBe('environment-failure')
    })
  })
})

function findTypescript(): string | undefined {
  try {
    const dir = realpathSync(join(import.meta.dirname, '..', '..', '..', '..', 'node_modules', 'typescript'))
    return existsSync(join(dir, 'bin', 'tsc')) ? dir : undefined
  } catch {
    return undefined
  }
}
