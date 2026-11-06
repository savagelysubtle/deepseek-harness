/**
 * Plugin configuration of the sandboxed bash tool: the schema the cordis row validates, and the resolution of
 * it (plus the host facts that do not change while the process runs) into the values the launch needs.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/config
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SEAT_DEFAULT_LIMITS } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatLimits, SeatProfileSpec } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatBwrapIdentity } from '@deepseek-ai/dsh-sandbox-local'
import { DEFAULT_DEADLINE_S, HOST_MAX_DEADLINE_S } from './limits.ts'

/** Deployment configuration of the plugin. */
export interface Config {
  /** Turn the tool off without removing the row: nothing is registered and coder seats stay not-ready. Default true. */
  enabled?: boolean
  /** Deadline of a call that gives no `timeout_s`, in seconds. Default 120. */
  deadlineS?: number
  /** Longest deadline a call may ask for, in seconds. Default and ceiling 600. */
  maxDeadlineS?: number
  /** `MemoryMax` of a call's cgroup scope in bytes (tmpfs pages count against it). Default 6 GiB. */
  memoryMaxBytes?: number
  /** `TasksMax` of a call's cgroup scope (it counts threads). Default 1024. */
  tasksMax?: number
  /** Free bytes the clone's filesystem must keep; a call below it is refused and a running one is killed. Default 1 GiB. */
  minFreeBytes?: number
  /** Absolute path of the bwrap binary; default the first of /usr/bin/bwrap, /usr/local/bin/bwrap, /bin/bwrap that exists. */
  bwrapPath?: string
  /** Node installation directory bound read-only into the sandbox; default the install of the running node. */
  nodeDir?: string
  /** Directory on the sandbox PATH for node; default `<nodeDir>/bin`. */
  nodeBinDir?: string
  /** `COREPACK_HOME`, bound read-only; default a directory in the sandbox home tmpfs (which has no network to fill it). */
  corepackHome?: string
  /** Exact extra read-only binds (for example a pnpm binary outside `nodeDir`); absolute and canonical. */
  roPaths?: string[]
  /** Extra directories on the sandbox PATH. */
  pathDirs?: string[]
  /** Extra host paths a seat must never see (the policy directory is the usual one). */
  deniedPaths?: string[]
  /** The operator's home directory; default the real path of the running user's home. */
  home?: string
  /** Directory the preflight creates its throwaway clone in; default the OS temp directory. */
  scratchDir?: string
}

/** Schema of {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  deadlineS: z.natural().default(DEFAULT_DEADLINE_S),
  maxDeadlineS: z.natural().default(HOST_MAX_DEADLINE_S),
  memoryMaxBytes: z.natural(),
  tasksMax: z.natural(),
  minFreeBytes: z.natural(),
  bwrapPath: z.string(),
  nodeDir: z.string(),
  nodeBinDir: z.string(),
  corepackHome: z.string(),
  roPaths: z.array(z.string()).default([]),
  pathDirs: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default([]),
  home: z.string(),
  scratchDir: z.string(),
})

/** A configuration value the operator must fix; thrown at mount. */
export class BashConfigError extends Error {
  override readonly name = 'BashConfigError'
}

/** The config with every default filled and the host facts that do not change at run time. */
export interface ResolvedConfig {
  readonly deadlineS: number
  readonly maxDeadlineS: number
  /** Overrides handed to the profile builder (only the fields the operator set). */
  readonly limits: Partial<SeatLimits>
  /** The free-space floor in effect (the override or the default). */
  readonly minFreeBytes: number
  readonly home: string
  readonly nodeDir: string
  readonly nodeBinDir: string | undefined
  readonly corepackHome: string | undefined
  readonly roPaths: readonly string[]
  readonly pathDirs: readonly string[]
  readonly deniedPaths: readonly string[]
  readonly bwrapPath: string
  readonly scratchDir: string
  /** `XDG_RUNTIME_DIR` of the host process as it was at mount. */
  readonly xdgRuntimeDir: string | undefined
}

/** Where bwrap is looked for when the config names no path. */
export const BWRAP_CANDIDATES: readonly string[] = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']

/** The host facts resolution reads; tests inject them. */
export interface ResolveEnv {
  /** The host environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Path of the running node binary. */
  readonly execPath: string
  /** The running user's home directory. */
  readonly homeDir: string
  /** The OS temp directory. */
  readonly tmpDir: string
  /** Whether a path exists. */
  readonly exists: (path: string) => boolean
  /** Canonical path. */
  readonly realpath: (path: string) => string
}

/** The real host. */
export function realResolveEnv(): ResolveEnv {
  return { env: process.env, execPath: process.execPath, homeDir: homedir(), tmpDir: tmpdir(), exists: existsSync, realpath: realpathSync }
}

function requireAbsolute(label: string, value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new BashConfigError(`agent-claude-code-bash: ${label} must be an absolute, normalised path, got ${JSON.stringify(value)}`)
  return value
}

/**
 * Validate the config and resolve the host facts.
 * @param config - the row's config (defaults may be absent).
 * @param host - host facts (defaults to the real host).
 * @returns the resolved values, or `{ ok: false }` with a reason when the host lacks something the sandbox needs.
 * @throws {BashConfigError} when a value is out of range or a path is not absolute and normalised.
 */
export function resolveConfig(
  config: Config,
  host: ResolveEnv = realResolveEnv(),
): { ok: true; config: ResolvedConfig } | { ok: false; reason: string } {
  const deadlineS = config.deadlineS ?? DEFAULT_DEADLINE_S
  const maxDeadlineS = config.maxDeadlineS ?? HOST_MAX_DEADLINE_S
  if (!Number.isSafeInteger(maxDeadlineS) || maxDeadlineS < 1 || maxDeadlineS > HOST_MAX_DEADLINE_S) {
    throw new BashConfigError(`agent-claude-code-bash: maxDeadlineS must be a whole number of seconds between 1 and ${HOST_MAX_DEADLINE_S}`)
  }
  if (!Number.isSafeInteger(deadlineS) || deadlineS < 1 || deadlineS > maxDeadlineS) {
    throw new BashConfigError(`agent-claude-code-bash: deadlineS must be a whole number of seconds between 1 and maxDeadlineS (${maxDeadlineS})`)
  }
  const limits: Partial<SeatLimits> = {
    ...config.memoryMaxBytes === undefined ? {} : { memoryMaxBytes: config.memoryMaxBytes },
    ...config.tasksMax === undefined ? {} : { tasksMax: config.tasksMax },
    ...config.minFreeBytes === undefined ? {} : { minFreeBytes: config.minFreeBytes },
  }
  const home = requireAbsolute('home', config.home ?? host.realpath(host.homeDir))
  const nodeDir = requireAbsolute('nodeDir', config.nodeDir ?? dirname(dirname(host.realpath(host.execPath))))
  const bwrapPath = config.bwrapPath === undefined
    ? BWRAP_CANDIDATES.find(candidate => host.exists(candidate))
    : requireAbsolute('bwrapPath', config.bwrapPath)
  if (bwrapPath === undefined) {
    return { ok: false, reason: `bwrap was not found (looked in ${BWRAP_CANDIDATES.join(', ')})` }
  }
  const absolute = (label: string, values: readonly string[] | undefined): string[] => (
    (values ?? []).map(value => requireAbsolute(label, value))
  )
  return {
    ok: true,
    config: {
      deadlineS,
      maxDeadlineS,
      limits,
      minFreeBytes: config.minFreeBytes ?? SEAT_DEFAULT_LIMITS.minFreeBytes,
      home,
      nodeDir,
      nodeBinDir: config.nodeBinDir === undefined ? undefined : requireAbsolute('nodeBinDir', config.nodeBinDir),
      corepackHome: config.corepackHome === undefined ? undefined : requireAbsolute('corepackHome', config.corepackHome),
      roPaths: absolute('roPaths entry', config.roPaths),
      pathDirs: absolute('pathDirs entry', config.pathDirs),
      deniedPaths: absolute('deniedPaths entry', config.deniedPaths),
      bwrapPath,
      scratchDir: requireAbsolute('scratchDir', config.scratchDir ?? host.tmpDir),
      xdgRuntimeDir: host.env['XDG_RUNTIME_DIR'],
    },
  }
}

/** The per-call fields the tool fills in. */
export type CallFields = 'seat' | 'callId' | 'command' | 'cwd' | 'workdir' | 'deadlineS'

/**
 * The part of the profile spec that comes from the host config, never from tool input.
 * @param config - resolved config.
 * @param bwrap - the attested bwrap identity.
 * @returns the spec without the per-call fields.
 */
export function baseSpec(config: ResolvedConfig, bwrap: SeatBwrapIdentity): Omit<SeatProfileSpec, CallFields> {
  return {
    home: config.home,
    nodeDir: config.nodeDir,
    roPaths: config.roPaths,
    pathDirs: config.pathDirs,
    deniedPaths: config.deniedPaths,
    limits: config.limits,
    xdgRuntimeDir: config.xdgRuntimeDir,
    bwrap,
    ...config.nodeBinDir === undefined ? {} : { nodeBinDir: config.nodeBinDir },
    ...config.corepackHome === undefined ? {} : { corepackHome: config.corepackHome },
  }
}
