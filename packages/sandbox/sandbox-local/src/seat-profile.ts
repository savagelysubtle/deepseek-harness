/**
 * Seat sandbox profile builder (OP-292 S6): given one seat call's inputs, produce the exact
 * `systemd-run --scope` + `bwrap` + `prlimit` argv that runs a shell command inside the seat
 * sandbox, or a typed refusal. Every decision that can be made without spawning is made here:
 * the mount shape, the namespaces, the cleared environment, the resource limits and the host-side
 * preflight over the clone (symlinks, `.git` shape, hard links, setuid files, provisioning
 * directories, free space, bwrap identity). The function only READS the filesystem; it never
 * spawns, writes or mutates, so a caller can build, inspect and then spawn.
 *
 * The profile is a bounded workspace, NOT a seal: the working tree stays a persistence residue
 * (hooks, scripts and configs a host tool may later open), which operator rules own.
 *
 * @module @deepseek-ai/dsh-sandbox-local/seat-profile
 */

import { statSync, lstatSync, readdirSync, readlinkSync, realpathSync, statfsSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** MiB / GiB in bytes. */
const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** The sandbox-internal home directory (a tmpfs). */
export const SEAT_HOME = '/home/seat'

/** Provisioning directories that must exist under `node_modules`; each is mounted as a tmpfs. */
export const SEAT_NODE_MODULES_TMPFS = ['.vite', '.vite-temp', '.cache'] as const

/** Host-home entries a seat may never see (relative to the host home). */
export const SEAT_FORBIDDEN_HOME_ENTRIES = [
  '.claude', '.dsh', '.agents', '.ssh', '.gnupg', '.aws', '.npmrc', '.netrc', '.docker', '.kube', '.local/share/keyrings', '.config',
] as const

/** Resource limits for one seat call. */
export interface SeatLimits {
  /** `TasksMax` of the cgroup scope: the real fork-bomb control. It counts threads, so give parallel runners headroom (default 1024). */
  tasksMax: number
  /**
   * `MemoryMax` of the cgroup scope in bytes (swap is denied separately with `MemorySwapMax=0`).
   * tmpfs pages (`/tmp`, home, node_modules caches) count against it.
   */
  memoryMaxBytes: number
  /** RLIMIT_NPROC. Decorative: per-uid and shared with the host user since kernel 5.14, so `tasksMax` is the control. */
  nproc: number
  /** RLIMIT_NOFILE. */
  nofile: number
  /** RLIMIT_FSIZE in bytes. */
  fsizeBytes: number
  /** Size of the `/tmp` tmpfs in bytes. */
  tmpBytes: number
  /** Size of the `/home/seat` tmpfs in bytes. */
  homeBytes: number
  /** Size of each `node_modules` cache tmpfs in bytes. */
  cacheBytes: number
  /** Free bytes the clone's filesystem must still offer before a call may run. */
  minFreeBytes: number
}

/** Documented defaults. There is deliberately NO RLIMIT_AS: V8 reserves large virtual ranges and a failed reservation is fatal. */
export const SEAT_DEFAULT_LIMITS: Readonly<SeatLimits> = {
  tasksMax: 1024,
  memoryMaxBytes: 6 * GIB,
  nproc: 4096,
  nofile: 8192,
  fsizeBytes: GIB,
  tmpBytes: GIB,
  homeBytes: 256 * MIB,
  cacheBytes: 256 * MIB,
  minFreeBytes: GIB,
}

/** The attested identity of the bwrap binary (bigint-derived decimal strings, so a 64-bit inode survives). */
export interface SeatBwrapIdentity {
  /** Absolute path of the binary that will be executed. */
  path: string
  ino: string
  /** Modification time in nanoseconds. */
  mtimeNs: string
  size: string
}

/** The filesystem reads the builder performs; injectable so refusal paths are testable. */
export interface SeatFs {
  /** `lstat`; `undefined` when the path (or a parent) does not exist. Other errors propagate. */
  lstat(path: string): Stats | undefined
  /** `realpath`; `undefined` when the path does not exist. Other errors propagate. */
  realpath(path: string): string | undefined
  readdir(path: string): string[]
  readlink(path: string): string
  /** Free bytes available to an unprivileged user on the filesystem holding `path`. */
  freeBytes(path: string): number
  /** ino/mtime/size of the file at `path` (symlinks followed); `undefined` when missing. */
  identity(path: string): Omit<SeatBwrapIdentity, 'path'> | undefined
}

/** Is `error` a "does not exist" filesystem error? */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Run `read`; map a "does not exist" failure to `undefined` and rethrow anything else. */
function orMissing<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** The real filesystem. */
export const defaultSeatFs: SeatFs = {
  lstat: path => orMissing(() => lstatSync(path)),
  realpath: path => orMissing(() => realpathSync(path)),
  readdir: path => readdirSync(path),
  readlink: path => readlinkSync(path),
  freeBytes: (path) => {
    const fs = statfsSync(path)
    // bavail counts blocks of `bsize` (the optimal transfer size); on the filesystems seat clones live on this equals
    // the fragment size, and the product is the user-available byte count the floor is judged against.
    return fs.bavail * fs.bsize
  },
  identity: (path) => {
    const stat = orMissing(() => statSync(path, { bigint: true }))
    return stat === undefined
      ? undefined
      : { ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), size: String(stat.size) }
  },
}

/**
 * Attest the bwrap binary: record its identity so a later call can detect replacement.
 * @param path - absolute path of the bwrap binary.
 * @param fs - filesystem reads (defaults to the real one).
 * @returns the identity, or `undefined` when the binary does not exist.
 */
export function attestBwrap(path: string, fs: SeatFs = defaultSeatFs): SeatBwrapIdentity | undefined {
  const identity = fs.identity(path)
  return identity === undefined ? undefined : { path, ...identity }
}

/** Machine-readable refusal codes. */
export type SeatRefusalCode =
  | 'seat-invalid' | 'call-id-invalid' | 'command-invalid' | 'deadline-invalid' | 'limits-invalid'
  | 'env-invalid' | 'home-invalid' | 'denied-path-invalid' | 'env-binary-missing' | 'bwrap-invalid' | 'fs-error'
  | 'xdg-runtime-dir-missing' | 'bwrap-missing' | 'bwrap-changed'
  | 'cwd-not-absolute' | 'cwd-leading-dash' | 'cwd-missing' | 'cwd-not-directory' | 'cwd-symlink'
  | 'workdir-outside-clone' | 'path-denied' | 'ro-path-invalid'
  | 'git-missing' | 'git-file' | 'git-alternates' | 'git-incomplete'
  | 'hardlinked-file' | 'setuid-file' | 'foreign-device'
  | 'node-modules-invalid' | 'not-provisioned' | 'disk-floor'

/** A typed refusal: what was refused, why, and what the operator can do. */
export class SeatRefusalError extends Error {
  override readonly name = 'SeatRefusalError'

  constructor(
    readonly code: SeatRefusalCode,
    readonly reason: string,
    readonly remedy: string,
  ) {
    super(`${code}: ${reason}`)
  }
}

/** Inputs for one seat call. */
export interface SeatProfileSpec {
  /** Seat name; becomes part of the unit name (`[A-Za-z0-9_-]`, 1..48 chars, alphanumeric first). */
  seat: string
  /** Per-call id; same alphabet as `seat`. Makes the scope unit name unique. */
  callId: string
  /** The shell command (run as `/bin/bash -c <command>`). */
  command: string
  /** The clone root: absolute, canonical (no symlink component), bound read-write at its real path. */
  cwd: string
  /** Directory to start in; defaults to `cwd`. Must be canonical and inside `cwd`. */
  workdir?: string
  /** The host user's home directory (used only to refuse binds that expose it; never mounted). */
  home: string
  /** Extra absolute paths a seat must never see (e.g. the harness policy directory). */
  deniedPaths?: readonly string[]
  /** The node installation directory, bound read-only at the same path. Canonical. */
  nodeDir: string
  /** Directory placed on PATH for node; defaults to `<nodeDir>/bin`. */
  nodeBinDir?: string
  /** Extra directories placed on PATH (absolute, no `:`). */
  pathDirs?: readonly string[]
  /** Exact read-only binds at the same path (e.g. the pnpm and corepack binaries). Each canonical. */
  roPaths?: readonly string[]
  /** `COREPACK_HOME`. When given it is bound read-only (like a `roPaths` entry); default is a directory inside the home tmpfs. */
  corepackHome?: string
  /** Extra environment variables for the sandbox (validated; fixed names and risky names are refused). */
  extraEnv?: Readonly<Record<string, string>>
  /** Wall-clock deadline in whole seconds; RLIMIT_CPU is `deadlineS + 10`. */
  deadlineS: number
  /** Resource limits (merged over {@link SEAT_DEFAULT_LIMITS}). */
  limits?: Partial<SeatLimits>
  /** `XDG_RUNTIME_DIR` of the host process; required by `systemd-run --user --scope`. */
  xdgRuntimeDir: string | undefined
  /** The bwrap identity recorded at attestation (see {@link attestBwrap}). */
  bwrap: SeatBwrapIdentity
  /** The host uid (default `userInfo().uid`); only locates the cgroup directory. Host input, never tool input. */
  uid?: number
  /** cgroup2 mount point (default `/sys/fs/cgroup`). Host input, never tool input. */
  cgroupRoot?: string
}

/** Injected dependencies. */
export interface SeatProfileDeps {
  fs?: Partial<SeatFs>
}

/** The built launch plan. */
export interface SeatLaunchPlan {
  /** Complete argv: `systemd-run ... -- env -i <spawnEnv> bwrap ... -- prlimit ... -- /bin/bash -c <command>`. */
  argv: string[]
  /** The `systemd-run` wrapper part (everything before the bwrap executable). */
  scopeArgv: string[]
  /** The self-enforcing bwrap invocation (`env -i <spawnEnv>`, bwrap, profile, `--`, prlimit and the command); usable without the scope. */
  bwrapArgv: string[]
  /** The profile part of the bwrap invocation (flags before the first `--` separator). */
  bwrapProfileArgs: string[]
  /** Environment required by the host-side launch (`XDG_RUNTIME_DIR`; PATH only for locating `systemd-run`). */
  spawnEnv: Record<string, string>
  /** The environment the sandboxed process receives; nothing else is passed. */
  sandboxEnv: Record<string, string>
  /** Scope unit name without suffix (`dsh-seat.<seat>.<callid>`). */
  unit: string
  /** The command that stops the scope. Success counts only once {@link SeatLaunchPlan.cgroupDir} is gone. */
  stopArgv: string[]
  /** The scope's cgroup directory; its absence after the stop is the success criterion. */
  cgroupDir: string
  /** `cgroup.procs` inside {@link SeatLaunchPlan.cgroupDir}; non-empty after the stop is a runner failure. */
  cgroupProcsPath: string
  /** The resolved directory the command starts in. */
  chdir: string
  /** The limits that were applied. */
  limits: SeatLimits
}

/** Result of {@link planSeatLaunch}. */
export type SeatLaunchResult =
  | { ok: true; plan: SeatLaunchPlan }
  | { ok: false; refusal: SeatRefusalError }

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/u
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** Names a seat call may never inject, whatever the caller asks. */
const FORBIDDEN_ENV_PATTERN = new RegExp([
  '^(?:NODE_.*|GIT_.*|CLAUDE.*|ANTHROPIC.*|LD_.*|BASH_ENV|ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND',
  'GLIBC_TUNABLES|GCONV_PATH|LOCPATH|COREPACK_.*|PYTHON.*|PERL5OPT)$',
].join('|'), 'u')
const NPM_CONFIG_PATTERN = /^npm_config_/iu
const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin']
const ETC_ENTRIES = [
  '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/localtime',
  '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives',
]
const USR_MERGE_LINKS = ['/bin', '/lib', '/lib64', '/sbin']
const ENV_BINARY = '/usr/bin/env'
const CWD_CODES = { absolute: 'cwd-not-absolute', dash: 'cwd-leading-dash' } as const
const DEFAULT_COREPACK_HOME = `${SEAT_HOME}/.cache/node/corepack`

/** `inner` equals or lies inside `outer` (both normalised absolute paths). */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  // A child literally named `..x` is inside; only `..` itself or `../` leaves the parent.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** An absolute path without NUL or newline: safe to hand to the filesystem and to argv. */
function isPlainPath(path: string): boolean {
  return isAbsolute(path) && !/[\0\n]/u.test(path)
}

function refuse(code: SeatRefusalCode, reason: string, remedy: string): never {
  throw new SeatRefusalError(code, reason, remedy)
}

/** Validate a bare name used in the unit name. */
function assertName(value: string, code: 'seat-invalid' | 'call-id-invalid', label: string): void {
  if (!NAME_PATTERN.test(value)) {
    refuse(code, `${label} ${JSON.stringify(value)} is not 1..48 characters of [A-Za-z0-9_-] starting alphanumeric`, `use a ${label} made only of letters, digits, '_' and '-'`)
  }
}

/** Validate the limits (positive safe integers) and merge over the defaults. */
function resolveLimits(override: Partial<SeatLimits> | undefined): SeatLimits {
  const limits: SeatLimits = { ...SEAT_DEFAULT_LIMITS, ...override }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      refuse('limits-invalid', `limit ${key} must be a positive safe integer, got ${String(value)}`, 'pass a positive integer or omit the limit to use the default')
    }
  }
  return limits
}

/** Validate the caller's extra environment; returns the entries to set. */
function resolveExtraEnv(extra: Readonly<Record<string, string>> | undefined, fixed: Record<string, string>): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!ENV_NAME_PATTERN.test(name) || FORBIDDEN_ENV_PATTERN.test(name) || NPM_CONFIG_PATTERN.test(name) || name in fixed || value.includes('\0')) {
      refuse('env-invalid', `environment variable ${JSON.stringify(name)} is not allowed in a seat sandbox`, 'remove it; only plain names that the profile does not own, with NUL-free values, may be added (never NODE_*, GIT_*, CLAUDE*, ANTHROPIC*, LD_*, shell/npm/corepack/python startup variables)')
    }
    entries.push([name, value])
  }
  return entries
}

/** The host paths a seat must never see: forbidden home entries, their real targets, the caller's extras. */
function forbiddenPaths(spec: SeatProfileSpec, fs: SeatFs): string[] {
  const denied = spec.deniedPaths ?? []
  for (const path of denied) {
    if (!isPlainPath(path)) {
      refuse('denied-path-invalid', `denied path ${JSON.stringify(path)} is not a plain absolute path`, 'pass absolute paths without NUL or newline')
    }
  }
  const paths = [
    ...SEAT_FORBIDDEN_HOME_ENTRIES.map(entry => join(spec.home, entry)),
    ...denied,
  ]
  const real = paths.flatMap(path => fs.realpath(path) ?? [])
  return [...paths, ...real]
}

/** Refuse a path that equals/contains/sits inside a forbidden path, or equals/contains the host home. */
function assertNotForbidden(path: string, label: string, forbidden: readonly string[], home: string): void {
  if (contains(path, home)) {
    refuse('path-denied', `${label} ${path} equals or contains the host home ${home}`, 'bind a directory that sits strictly inside the home, not the home itself')
  }
  const hit = forbidden.find(entry => contains(entry, path) || contains(path, entry))
  if (hit !== undefined) {
    refuse('path-denied', `${label} ${path} overlaps the protected path ${hit}`, 'move the clone or bind elsewhere; credentials, harness state and agent config are never exposed')
  }
}

/** The canonical absolute-path checks shared by every bound path. */
function assertCanonical(path: string, label: string, codes: { absolute: SeatRefusalCode; dash: SeatRefusalCode }, fs: SeatFs): void {
  if (path.startsWith('-')) {
    refuse(codes.dash, `${label} ${JSON.stringify(path)} starts with '-'`, 'pass an absolute path; a leading dash would be read as an option')
  }
  if (!isPlainPath(path)) {
    refuse(codes.absolute, `${label} ${JSON.stringify(path)} is not a plain absolute path`, 'pass an absolute path without NUL or newline')
  }
  const real = fs.realpath(path)
  if (real !== undefined && real !== path) {
    refuse('cwd-symlink', `${label} ${path} is not canonical (realpath is ${real}): it contains a symlink, '..' or a trailing slash`, `pass the canonical path ${real}`)
  }
}

/** Stat one checked entry: setuid/setgid files and foreign-device entries are refused. */
function assertSafeEntry(path: string, stat: Stats, cloneDev: number): void {
  if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.dev !== cloneDev) {
    refuse('foreign-device', `${path} is a device file or lives on another filesystem than the clone`, 're-provision the clone with a fresh `git clone --no-hardlinks`; nothing mounted or device-backed may sit inside it')
  }
  if (!stat.isDirectory() && (stat.mode & 0o6000) !== 0) {
    refuse('setuid-file', `${path} has the setuid or setgid bit`, 're-provision the clone; seat clones must not contain privileged files')
  }
}

/** Preflight the `.git` directory: shape, alternates, hard links, setuid/device entries. */
function checkGit(cwd: string, cloneDev: number, fs: SeatFs): void {
  const git = join(cwd, '.git')
  const gitStat = fs.lstat(git)
  if (gitStat === undefined) {
    refuse('git-missing', `${git} does not exist`, 'seat clones are provisioned with `git clone --no-hardlinks`')
  }
  if (gitStat.isFile()) {
    refuse('git-file', `${git} is a file (a worktree-style checkout): its real repository lives outside the clone`, 'provision the seat with a full `git clone --no-hardlinks`, not a git worktree')
  }
  if (!gitStat.isDirectory()) {
    refuse('git-incomplete', `${git} is not a plain directory`, 're-provision the clone')
  }
  assertSafeEntry(git, gitStat, cloneDev)
  if (fs.lstat(join(git, 'objects', 'info', 'alternates')) !== undefined) {
    refuse('git-alternates', `${join(git, 'objects', 'info', 'alternates')} exists: the clone borrows objects from another repository`, 're-provision with `git clone --no-hardlinks` and remove the alternates file')
  }
  for (const name of ['HEAD', 'config']) {
    const path = join(git, name)
    const stat = fs.lstat(path)
    if (stat === undefined || !stat.isFile()) {
      refuse('git-incomplete', `${path} is missing or not a regular file`, 're-provision the clone')
    }
    assertSafeEntry(path, stat, cloneDev)
    assertSingleLink(path, stat)
  }
  const hooks = join(git, 'hooks')
  const hooksStat = fs.lstat(hooks)
  if (hooksStat === undefined) return
  if (!hooksStat.isDirectory()) {
    refuse('git-incomplete', `${hooks} is not a plain directory`, 're-provision the clone')
  }
  assertSafeEntry(hooks, hooksStat, cloneDev)
  for (const name of fs.readdir(hooks)) {
    const path = join(hooks, name)
    // A hook entry can vanish between readdir and lstat; a missing one needs no check.
    const stat = fs.lstat(path)
    if (stat === undefined) continue
    assertSafeEntry(path, stat, cloneDev)
    if (!stat.isDirectory()) assertSingleLink(path, stat)
  }
}

function assertSingleLink(path: string, stat: Stats): void {
  if (stat.nlink > 1) {
    refuse('hardlinked-file', `${path} has ${stat.nlink} hard links: writing through it would reach another inode alias outside the clone`, 're-provision with `git clone --no-hardlinks`')
  }
}

/** Preflight `node_modules`; returns whether it exists (and so must be bound read-only with its cache tmpfs). */
function checkNodeModules(cwd: string, cloneDev: number, fs: SeatFs): boolean {
  const nodeModules = join(cwd, 'node_modules')
  const stat = fs.lstat(nodeModules)
  if (stat === undefined) return false
  if (!stat.isDirectory()) {
    refuse('node-modules-invalid', `${nodeModules} is not a plain directory (a symlink would be followed by the bind)`, 're-provision the clone: install dependencies into a real node_modules directory')
  }
  assertSafeEntry(nodeModules, stat, cloneDev)
  for (const name of SEAT_NODE_MODULES_TMPFS) {
    const dir = join(nodeModules, name)
    const dirStat = fs.lstat(dir)
    if (dirStat === undefined) {
      refuse('not-provisioned', `clone not provisioned: missing ${dir}`, `create ${dir} after install (bwrap cannot create a mountpoint inside a read-only bind)`)
    }
    if (!dirStat.isDirectory()) {
      refuse('not-provisioned', `clone not provisioned: ${dir} is not a plain directory`, `replace ${dir} with a real directory`)
    }
  }
  return true
}

/** The usr-merge plumbing: symlinks where the host has them, read-only binds where it has real directories. */
function usrArgs(fs: SeatFs): string[] {
  const args = ['--ro-bind', '/usr', '/usr']
  for (const path of USR_MERGE_LINKS) {
    const stat = fs.lstat(path)
    if (stat === undefined) continue
    if (stat.isSymbolicLink()) args.push('--symlink', fs.readlink(path), path)
    else args.push('--ro-bind', path, path)
  }
  return args
}

/** Is `/usr/local` a real directory on this host (so an empty tmpfs can be mounted over it)? */
function hasUsrLocal(fs: SeatFs): boolean {
  return fs.lstat('/usr/local')?.isDirectory() === true
}

/** Validate one read-only bind path (canonical, existing, not protected). */
function assertRoPath(path: string, forbidden: readonly string[], home: string, fs: SeatFs): void {
  assertCanonical(path, 'read-only path', { absolute: 'ro-path-invalid', dash: 'ro-path-invalid' }, fs)
  if (fs.lstat(path) === undefined) {
    refuse('ro-path-invalid', `read-only path ${path} does not exist`, 'drop it or install the tool it names')
  }
  assertNotForbidden(path, 'read-only path', forbidden, home)
}

/**
 * Build the seat launch plan against the real filesystem, or the first refusal.
 * @param spec - one seat call's inputs (host inputs: `uid` and `cgroupRoot` must never come from tool input).
 * @returns the plan, or a typed refusal with reason and remedy.
 */
export function planSeatLaunch(spec: SeatProfileSpec): SeatLaunchResult {
  return planSeatLaunchWith(spec)
}

/**
 * Build the seat launch plan with injectable filesystem reads (module-internal; the package barrel exposes only
 * {@link planSeatLaunch}). Refusals are checked in a fixed order: names and limits, the launch environment, `cwd`,
 * `.git`, `node_modules`, read-only paths, free space. A filesystem failure with an errno code becomes a
 * `fs-error` refusal; anything else propagates.
 * @param spec - one seat call's inputs.
 * @param deps - injected filesystem reads (tests).
 * @returns the plan, or a typed refusal with reason and remedy.
 */
export function planSeatLaunchWith(spec: SeatProfileSpec, deps: SeatProfileDeps = {}): SeatLaunchResult {
  const fs: SeatFs = { ...defaultSeatFs, ...deps.fs }
  try {
    return { ok: true, plan: buildPlan(spec, fs) }
  } catch (error) {
    if (error instanceof SeatRefusalError) return { ok: false, refusal: error }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (typeof code === 'string') {
      return { ok: false, refusal: new SeatRefusalError('fs-error', `filesystem error ${code} while checking the clone: ${(error as Error).message}`, 'fix the permissions or the broken path named in the message, then retry') }
    }
    throw error
  }
}

function buildPlan(spec: SeatProfileSpec, fs: SeatFs): SeatLaunchPlan {
  assertName(spec.seat, 'seat-invalid', 'seat')
  assertName(spec.callId, 'call-id-invalid', 'call id')
  if (spec.command.length === 0 || spec.command.includes('\0')) {
    refuse('command-invalid', 'the command is empty or contains a NUL byte', 'pass a non-empty command without NUL')
  }
  if (!Number.isSafeInteger(spec.deadlineS) || spec.deadlineS <= 0) {
    refuse('deadline-invalid', `deadline ${String(spec.deadlineS)} is not a positive whole number of seconds`, 'pass a positive integer')
  }
  if (!isPlainPath(spec.home)) {
    refuse('home-invalid', `host home ${JSON.stringify(spec.home)} is not an absolute path`, 'pass the host user home directory')
  }
  const limits = resolveLimits(spec.limits)

  const xdg = spec.xdgRuntimeDir
  if (xdg === undefined || !isPlainPath(xdg)) {
    refuse('xdg-runtime-dir-missing', 'XDG_RUNTIME_DIR is not set to an absolute path, so `systemd-run --user --scope` cannot start ("No medium found")', 'run the host process inside the user session (it needs XDG_RUNTIME_DIR, normally /run/user/<uid>)')
  }
  // '=' would make `env -i` read the path as another NAME=value assignment (GNU env has no way to end assignments).
  if (!isPlainPath(spec.bwrap.path) || spec.bwrap.path.includes('=')) {
    refuse('bwrap-invalid', `bwrap path ${JSON.stringify(spec.bwrap.path)} is not a plain absolute path without '='`, 'pass the absolute path of the attested bwrap binary')
  }
  if (fs.lstat(ENV_BINARY) === undefined) {
    refuse('env-binary-missing', `${ENV_BINARY} does not exist, so the launch cannot be made self-enforcing`, 'install coreutils')
  }
  const identity = fs.identity(spec.bwrap.path)
  if (identity === undefined) {
    refuse('bwrap-missing', `bwrap is not at ${spec.bwrap.path}`, 'install bubblewrap and re-attest')
  }
  if (identity.ino !== spec.bwrap.ino || identity.mtimeNs !== spec.bwrap.mtimeNs || identity.size !== spec.bwrap.size) {
    refuse('bwrap-changed', `the bwrap binary at ${spec.bwrap.path} changed since attestation (inode, mtime or size differs)`, 're-run the sandbox preflight to attest the new binary')
  }

  const forbidden = forbiddenPaths(spec, fs)
  const { cwd } = spec
  assertCanonical(cwd, 'cwd', CWD_CODES, fs)
  const cwdStat = fs.lstat(cwd)
  if (cwdStat === undefined) {
    refuse('cwd-missing', `cwd ${cwd} does not exist`, 'provision the clone first')
  }
  if (!cwdStat.isDirectory()) {
    refuse('cwd-not-directory', `cwd ${cwd} is not a directory`, 'pass the clone root directory')
  }
  assertNotForbidden(cwd, 'cwd', forbidden, spec.home)
  const workdir = spec.workdir ?? cwd
  assertCanonical(workdir, 'working directory', CWD_CODES, fs)
  if (!contains(cwd, workdir)) {
    refuse('workdir-outside-clone', `working directory ${workdir} is not inside the clone ${cwd}`, 'use a path under the clone root')
  }
  if (fs.lstat(workdir) === undefined) {
    refuse('cwd-missing', `working directory ${workdir} does not exist`, 'create it inside the clone first')
  }

  checkGit(cwd, cwdStat.dev, fs)
  const hasNodeModules = checkNodeModules(cwd, cwdStat.dev, fs)

  const roPaths = [spec.nodeDir, ...(spec.roPaths ?? []), ...(spec.corepackHome === undefined ? [] : [spec.corepackHome])]
  for (const path of roPaths) assertRoPath(path, forbidden, spec.home, fs)

  if (fs.freeBytes(cwd) < limits.minFreeBytes) {
    refuse('disk-floor', `the clone's filesystem has fewer than ${limits.minFreeBytes} free bytes`, 'free disk space (or raise the floor deliberately) before running more commands')
  }

  const nodeBinDir = spec.nodeBinDir ?? join(spec.nodeDir, 'bin')
  const pathEntries = [join(cwd, 'node_modules', '.bin'), nodeBinDir, ...(spec.pathDirs ?? []), ...SYSTEM_PATH]
  for (const entry of pathEntries) {
    if (!isPlainPath(entry) || entry.includes(':')) {
      refuse('env-invalid', `PATH entry ${JSON.stringify(entry)} is not a plain absolute directory`, 'pass absolute directories without ":"')
    }
  }
  const sandboxEnv: Record<string, string> = {
    HOME: SEAT_HOME,
    TMPDIR: '/tmp',
    PATH: pathEntries.join(':'),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    USER: 'seat',
    SHELL: '/bin/bash',
    CI: '1',
    PWD: workdir,
    COREPACK_HOME: spec.corepackHome ?? DEFAULT_COREPACK_HOME,
  }
  for (const [name, value] of resolveExtraEnv(spec.extraEnv, sandboxEnv)) sandboxEnv[name] = value

  const bwrapProfileArgs: string[] = [
    '--die-with-parent',
    '--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--new-session',
    '--cap-drop', 'ALL',
    '--clearenv',
  ]
  for (const [name, value] of Object.entries(sandboxEnv)) bwrapProfileArgs.push('--setenv', name, value)
  bwrapProfileArgs.push(...usrArgs(fs))
  // The host's /usr/local holds operator launchers and sources the seat does not need: hide it behind an empty tmpfs.
  const usrLocal = hasUsrLocal(fs)
  if (usrLocal) bwrapProfileArgs.push('--tmpfs', '/usr/local')
  for (const path of ETC_ENTRIES) bwrapProfileArgs.push('--ro-bind-try', path, path)
  bwrapProfileArgs.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(limits.tmpBytes), '--tmpfs', '/tmp',
    '--size', String(limits.homeBytes), '--tmpfs', SEAT_HOME,
  )
  for (const path of roPaths) bwrapProfileArgs.push('--ro-bind', path, path)
  bwrapProfileArgs.push('--bind', cwd, cwd, '--ro-bind', join(cwd, '.git'), join(cwd, '.git'))
  if (hasNodeModules) {
    const nodeModules = join(cwd, 'node_modules')
    bwrapProfileArgs.push('--ro-bind', nodeModules, nodeModules)
    for (const name of SEAT_NODE_MODULES_TMPFS) {
      bwrapProfileArgs.push('--size', String(limits.cacheBytes), '--tmpfs', join(nodeModules, name))
    }
  }
  // Last mount step: the tmpfs root (and the /etc entries bwrap created in it) must be read-only, or `touch /x` succeeds.
  // The separate mounts above (/tmp, home, the clone) keep their own flags.
  // The /usr/local remount comes after every bind so later mountpoints can still be created inside it.
  if (usrLocal) bwrapProfileArgs.push('--remount-ro', '/usr/local')
  bwrapProfileArgs.push('--remount-ro', '/', '--chdir', workdir)

  const spawnEnv = { XDG_RUNTIME_DIR: xdg, PATH: SYSTEM_PATH.join(':') }
  const bwrapArgv = [
    // `env -i` makes the launch self-enforcing: bwrap (and its init, pid 1 inside) start with exactly spawnEnv,
    // whatever environment the caller spawns the scope with. `--clearenv` alone scrubs only the exec'd command.
    ENV_BINARY, '-i', ...Object.entries(spawnEnv).map(([name, value]) => `${name}=${value}`),
    spec.bwrap.path, ...bwrapProfileArgs, '--',
    '/usr/bin/prlimit',
    `--nproc=${limits.nproc}`, `--nofile=${limits.nofile}`, `--fsize=${limits.fsizeBytes}`,
    '--core=0', `--cpu=${spec.deadlineS + 10}`,
    '--', '/bin/bash', '-c', spec.command,
  ]
  // '.' separates the parts: it is outside the name alphabet, so (a-b, c) and (a, b-c) can never share a unit.
  const unit = `dsh-seat.${spec.seat}.${spec.callId}`
  const scopeArgv = [
    'systemd-run', '--user', '--scope', '--unit', unit,
    '-p', `TasksMax=${limits.tasksMax}`, '-p', `MemoryMax=${limits.memoryMaxBytes}`, '-p', 'MemorySwapMax=0',
    '--quiet', '--',
  ]
  const uid = spec.uid ?? userInfo().uid
  const cgroupDir = join(spec.cgroupRoot ?? '/sys/fs/cgroup', 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice', `${unit}.scope`)
  return {
    argv: [...scopeArgv, ...bwrapArgv],
    scopeArgv,
    bwrapArgv,
    bwrapProfileArgs,
    spawnEnv,
    sandboxEnv,
    unit,
    stopArgv: ['systemctl', '--user', 'stop', `${unit}.scope`],
    cgroupDir,
    cgroupProcsPath: join(cgroupDir, 'cgroup.procs'),
    chdir: workdir,
    limits,
  }
}

/** How a `systemctl --user stop <unit>.scope` ended, judged together with the cgroup directory. */
export type ScopeStopOutcome = 'stopped' | 'absent' | 'environment-failure' | 'failed'

/**
 * Judge a scope stop. A stop counts as success ONLY when the cgroup directory is gone: exit 0 with
 * the directory gone is `stopped`; exit 5 ("unit not loaded") with the directory gone is `absent`
 * (nothing was left to stop). Exit 1 ("Failed to connect to bus") is an environment failure: the
 * state of the scope is unknown, so it must never be read as a pass. Anything else, including a
 * zero exit that left the directory behind, is `failed`.
 * @param exitCode - the stop command's exit status (`null` when it was killed by a signal).
 * @param cgroupGone - whether {@link SeatLaunchPlan.cgroupDir} no longer exists.
 * @returns the outcome.
 */
export function classifyScopeStop(exitCode: number | null, cgroupGone: boolean): ScopeStopOutcome {
  if (exitCode === 1) return 'environment-failure'
  if (!cgroupGone) return 'failed'
  if (exitCode === 0) return 'stopped'
  return exitCode === 5 ? 'absent' : 'failed'
}
