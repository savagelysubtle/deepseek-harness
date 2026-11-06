/**
 * The permission-policy provider plugin. It registers the `claudeCodePolicy` service the Claude Code
 * driver reads at use time (never at mount, so mount order does not matter). Per query it pins the
 * seat's working directory, generates the seat's policy once per seat and directory, rewrites the
 * policy file when it is gone or changed, proves the guard hook really denies before the first tool
 * can run, and hands the driver a fresh in-process `dsh` server plus the exact allow list.
 *
 * Roles: `lead` needs nothing beyond this plugin. `coder` needs the sandbox, canary and rules-hooks
 * contributors. The sandbox one (S6) registers through `claudeCodePolicyRegistries`; canary and rules-hooks
 * (S7) do not exist yet, so a coder seat still reports not-ready and the driver refuses it at create. No
 * contributor is faked. `allowedCwdRoots` pins every seat's cwd under the host's clone root.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/provider
 */

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ClaudeCodePolicy, PolicyExtension, PolicyHostSeatFields, PolicyQueryContext, PolicyReadiness,
} from '@deepseek-ai/dsh-agent-claude-code-driver'
import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import z from '@deepseek-ai/schemastery'
import { assertAttestedUnchanged, attestFile } from './attest-guard.ts'
import type { AttestedFile } from './attest-guard.ts'
import { ContributorRegistry, MCP_TOOL_PREFIX } from './contributors.ts'
import { installGuardCopy } from './guard-copy.ts'
import { guardScriptPath } from './hook-command.ts'
import type { HookGroup } from './hook-command.ts'
import { createSeatMcpServer } from './mcp/server.ts'
import { scrubText } from './mcp/scrub.ts'
import { isInside } from './path-guard.ts'
import { createLeadTemplate } from './mcp/template.ts'
import type { SeatToolTemplate } from './mcp/template.ts'
import { DEFAULT_SCRUB_ROOTS } from './mcp/types.ts'
import type { SeatScrubOptions, SeatToolContext } from './mcp/types.ts'
import { MAX_POLICY_BYTES } from './policy-read.ts'
import { ReadinessRegistry } from './readiness.ts'
import { generateSeatPolicy } from './settings.ts'
import type { SeatPolicy } from './settings.ts'
import { verifyGuardCommand } from './verify-guard.ts'

/**
 * The registries the policy reads, shared with later slices: S6 (sandbox) and S7 (canary) plugins
 * register readiness contributors, extra tool names and tool factories here instead of editing S5 files.
 */
export interface PolicyRegistries {
  /** Which requirements (sandbox, canary, rules-hooks) are satisfied; a coder needs all three. */
  readonly readiness: ReadinessRegistry
  /** Extra dsh tool names and hook groups per role. */
  readonly contributors: ContributorRegistry
  /** The tool factories a seat's server is built from; a name here must also be offered by `contributors`. */
  readonly tools: SeatToolTemplate
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The registries behind `claudeCodePolicy`, provided by the policy provider plugin. */
    claudeCodePolicyRegistries: PolicyRegistries
  }
}

/** Cordis plugin name. */
export const name = 'agent-claude-code-tools'

/** Deployment configuration of the provider plugin. */
export interface Config {
  /** Absolute directory the per-seat policy files are written into; owned by the host, created with mode 0700. */
  policyDir: string
  /** The operator's home directory; defaults to the real path of the running user's home. */
  home?: string
  /** The node binary the guard hook runs under; defaults to the running node. Attested before first use. */
  nodePath?: string
  /** The built guard script; defaults to this package's `lib/seat-guard.js`. Attested before first use. */
  guardPath?: string
  /**
   * Absolute directories every seat's working directory must sit inside (the clone root the host provisions);
   * a seat started elsewhere is refused at `extend`. Absent means no extra pin. An empty list refuses every seat.
   * Entries must be canonical paths (no symlinks): they are compared lexically with the seat's canonical cwd.
   */
  allowedCwdRoots?: string[]
}

/** Schema of {@link Config}. */
export const Config: z<Config> = z.object({
  policyDir: z.string().required(),
  home: z.string(),
  nodePath: z.string(),
  guardPath: z.string(),
  allowedCwdRoots: z.array(z.string()),
})

/** Everything {@link createClaudeCodePolicy} needs. */
export interface PolicyOptions {
  /** Absolute directory the policy files are written into. */
  readonly policyDir: string
  /** The operator's home directory (canonical). */
  readonly home: string
  /** The node binary the guard hook runs under. */
  readonly nodePath: string
  /** The built guard script. */
  readonly guardPath: string
  /** Roots every seat's cwd must sit inside; undefined means unrestricted. Each must be absolute and normalised. */
  readonly allowedCwdRoots?: readonly string[]
  /** Publish through the mailbox service; throws when the service is unavailable. */
  readonly publish: SeatToolContext['publish']
  /** Readiness contributors (S6, S7 register here); defaults to an empty registry. */
  readonly readiness?: ReadinessRegistry
  /** Tool and hook contributors; defaults to an empty registry (the base template only). */
  readonly contributors?: ContributorRegistry
  /** The tool factories; defaults to the lead template. */
  readonly template?: SeatToolTemplate
  /** Proves the guard hook command denies; defaults to {@link verifyGuardCommand}. Tests inject a counter. */
  readonly verify?: (command: string) => void
  /** Host-side warning sink (the plugin passes `ctx.logger.warn`); never shown to the model. */
  readonly warn: (message: string) => void
  /** Mint trace ids; defaults to a random UUID. */
  readonly newTraceId?: () => string
}

/** Longest cap a tool may ask the scrubber for, in code points. */
const MAX_SCRUB_LENGTH = 1_048_576

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrub a tool's text for the model with the roots the tool chose.
 * @param text - raw text.
 * @param scrubOptions - the tool's roots (default home and cwd) and length cap (default the scrubber's).
 * @param home - the operator's home directory.
 * @param cwd - the seat's working directory.
 * @returns scrubbed text. When `'cwd'` is not a root and the cwd sits under the home, paths inside the cwd are left
 *   intact (the model already knows its cwd and redacting it would break tool agreement); every other path under the
 *   home is still redacted.
 * @throws when no root is given, a root is unknown, or `maxLength` is not a positive safe integer of at most {@link MAX_SCRUB_LENGTH}.
 */
function scrubForModel(text: string, scrubOptions: SeatScrubOptions | undefined, home: string, cwd: string): string {
  const names = scrubOptions?.scrubRoots ?? DEFAULT_SCRUB_ROOTS
  if (names.length === 0 || (names as readonly string[]).some(entry => entry !== 'home' && entry !== 'cwd')) {
    throw new Error('agent-claude-code-tools: scrubRoots needs at least one of "home" and "cwd"')
  }
  const maxLength = scrubOptions?.maxLength
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_SCRUB_LENGTH)) {
    throw new Error(`agent-claude-code-tools: scrub maxLength must be a positive integer of at most ${MAX_SCRUB_LENGTH}`)
  }
  const cap = maxLength === undefined ? {} : { maxLength }
  const roots = [...names.includes('home') ? [home] : [], ...names.includes('cwd') ? [cwd] : []]
  if (names.includes('cwd') || !isInside(home, cwd)) return scrubText(text, { roots, ...cap })
  // Same path shape the scrubber matches: the cwd, then optionally the rest of the path.
  const inside = new RegExp(`${escapeRegExp(cwd)}(?![\\w-]|\\.[\\w-])(?:/[^\\s'"\`<>)\\]}]*)?`, 'g')
  const everything = { maxLength: Number.MAX_SAFE_INTEGER }
  // Controls go first: a NUL inside `<cwd>\0-two` would otherwise end the match and rejoin as the sibling `<cwd>-two`.
  const clean = scrubText(text, { roots: [], ...everything })
  let out = ''
  let outside = ''
  let last = 0
  for (const match of clean.matchAll(inside)) {
    outside += clean.slice(last, match.index)
    last = match.index + match[0].length
    // A `..` segment leaves the cwd, so that path is not inside it and is scrubbed with the rest.
    if (match[0].split('/').includes('..')) {
      outside += match[0]
      continue
    }
    out += scrubText(outside, { roots, ...everything }) + match[0]
    outside = ''
  }
  out += scrubText(outside + clean.slice(last), { roots, ...everything })
  // The length cap applies once, to the whole text, with no path root left to redact.
  return scrubText(out, { roots: [], ...cap })
}

interface SeatEntry {
  readonly key: string
  readonly policy: SeatPolicy
}

/**
 * Whether the policy file on disk still has the bytes the hook command pins.
 * @param policy - the generated policy.
 * @returns false when the file is gone, unreadable or changed.
 */
function policyFileIntact(policy: SeatPolicy): boolean {
  let fd = -1
  try {
    // O_NONBLOCK: a FIFO planted at the path must not hang the host; only a small regular file is read.
    fd = openSync(policy.policyPath, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return false
    return createHash('sha256').update(readFileSync(fd)).digest('hex') === policy.policySha256
  } catch {
    return false
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

/**
 * The guard hook command inside generated settings. `generateSeatPolicy` always puts the guard group first.
 * @param policy - the generated policy.
 * @returns the exact command string the CLI will run.
 */
function guardCommandOf(policy: SeatPolicy): string {
  const groups = policy.settings.hooks?.['PreToolUse'] as readonly HookGroup[]
  return (groups[0] as HookGroup).hooks[0]?.command as string
}

/**
 * Build the `claudeCodePolicy` service.
 * @param options - directories, binaries, the mailbox publish function and the registries.
 * @returns the policy the driver consumes.
 */
export function createClaudeCodePolicy(options: PolicyOptions): ClaudeCodePolicy {
  const readiness = options.readiness ?? new ReadinessRegistry()
  const contributors = options.contributors ?? new ContributorRegistry()
  const template = options.template ?? createLeadTemplate()
  const verify = options.verify ?? verifyGuardCommand
  for (const root of options.allowedCwdRoots ?? []) {
    if (!isAbsolute(root) || resolve(root) !== root || root === '/') {
      throw new Error(`agent-claude-code-tools: allowedCwdRoots entry ${JSON.stringify(root)} must be an absolute, normalised path other than /`)
    }
  }
  const cwdPins = new Map<string, string>()
  const entries = new Map<string, SeatEntry>()
  const verified = new Set<string>()
  let attested: { readonly node: AttestedFile; readonly source: AttestedFile; guard: AttestedFile } | undefined

  // The hook runs a host-owned copy of the guard, not the package file. The source is pinned at first use
  // and never re-read for a change: a changed source is refused, a changed copy is rewritten from the pin.
  const attest = (): { readonly node: AttestedFile; readonly guard: AttestedFile } => {
    if (attested === undefined) {
      const source = attestFile(options.guardPath, { access: 'read' })
      attested = { node: attestFile(options.nodePath, { access: 'exec' }), source, guard: installGuardCopy(options.policyDir, source) }
    } else {
      assertAttestedUnchanged(attested.node)
      assertAttestedUnchanged(attested.source)
      try {
        assertAttestedUnchanged(attested.guard)
      } catch {
        attested.guard = installGuardCopy(options.policyDir, attested.source)
      }
    }
    return attested
  }

  const extend = (query: PolicyQueryContext): PolicyExtension => {
    const { seat, role, cwd } = query
    if (role === 'mail-only') throw new Error(`agent-claude-code-tools: seat "${seat}" has role mail-only, which takes no policy`)
    const ready = readiness.readiness()
    if (!ready.roles.has(role)) {
      throw new Error(`agent-claude-code-tools: seat "${seat}": role ${role} is not ready (missing: ${ready.missing.join(', ')})`)
    }
    if (options.allowedCwdRoots !== undefined && !options.allowedCwdRoots.some(root => isInside(root, cwd))) {
      throw new Error(`agent-claude-code-tools: seat "${seat}": working directory ${JSON.stringify(cwd)} is not inside an allowed cwd root`)
    }
    if (isInside(cwd, options.policyDir) || isInside(options.policyDir, cwd)) {
      throw new Error(`agent-claude-code-tools: seat "${seat}": working directory ${JSON.stringify(cwd)} contains or is inside the policy directory ${JSON.stringify(options.policyDir)}; keep them apart`)
    }
    const pinned = cwdPins.get(seat)
    if (pinned !== undefined && pinned !== cwd) {
      throw new Error(`agent-claude-code-tools: seat "${seat}": working directory ${JSON.stringify(cwd)} is not the pinned ${JSON.stringify(pinned)}`)
    }
    const host: PolicyHostSeatFields = query.config.policy ?? {}
    const listed = host.tools ?? []
    template.check(seat, listed)
    const offered = new Set(contributors.templateTools(role))
    const notOffered = listed.filter(tool => !offered.has(tool))
    if (notOffered.length > 0) {
      throw new SeatMutedByPolicyError(seat, `the ${role} policy template does not offer: ${notOffered.join(', ')}`)
    }
    const { node, guard } = attest()
    cwdPins.set(seat, cwd)

    const key = JSON.stringify([role, cwd, host, readiness.version, contributors.version, template.version, guard.sha256])
    let entry = entries.get(seat)
    if (entry === undefined || entry.key !== key || !policyFileIntact(entry.policy)) {
      const policy = generateSeatPolicy({
        seat,
        role,
        cwd,
        home: options.home,
        host,
        contributors,
        policyDir: options.policyDir,
        node,
        guard,
      })
      entry = { key, policy }
      entries.set(seat, entry)
    }
    const { policy } = entry

    // The hook fails open when it cannot start (only exit 2 blocks), so it must prove it denies first.
    const proof = `${node.sha256}:${guard.sha256}:${policy.policySha256}`
    if (!verified.has(proof)) {
      verify(guardCommandOf(policy))
      verified.add(proof)
    }

    const context: SeatToolContext = {
      seat,
      sendTo: [...host.send_to ?? []],
      allowBlocking: host.allow_blocking === true,
      cwd,
      isTainted: () => query.isTurnTainted(),
      markTainted: (reason) => { query.markTurnTainted(reason) },
      deliveredTraceIds: () => query.deliveredTraceIds(),
      publish: options.publish,
      newTraceId: options.newTraceId ?? randomUUID,
      warn: options.warn,
      scrub: (text, scrubOptions) => scrubForModel(text, scrubOptions, options.home, cwd),
    }
    const exposed = policy.tools.filter(tool => tool.startsWith(MCP_TOOL_PREFIX)).map(tool => tool.slice(MCP_TOOL_PREFIX.length))
    const server = createSeatMcpServer({ seat, tools: exposed, template, context })
    return { settings: policy.settings, mcpServers: { dsh: server }, allow: policy.allow }
  }

  return {
    version: 1,
    extend,
    readiness: (): PolicyReadiness => readiness.readiness(),
  }
}

/**
 * Mount the provider: register `claudeCodePolicy` on the context. The mailbox service is looked up
 * when a message is sent, so the plugins may mount in either order. Also provides
 * `claudeCodePolicyRegistries` (the same instances the policy uses). The package's `apply` calls this.
 * @param ctx - plugin context.
 * @param config - policy directory and optional home, node and guard paths.
 * @throws when `policyDir` or an explicit path is not absolute.
 */
export function mountPolicyProvider(ctx: Context, config: Config): void {
  for (const [label, value] of [['policyDir', config.policyDir], ['home', config.home], ['nodePath', config.nodePath], ['guardPath', config.guardPath]] as const) {
    if (value !== undefined && !isAbsolute(value)) throw new Error(`agent-claude-code-tools: ${label} must be an absolute path`)
  }
  const registries: PolicyRegistries = {
    readiness: new ReadinessRegistry(),
    contributors: new ContributorRegistry(),
    tools: createLeadTemplate(),
  }
  const policy = createClaudeCodePolicy({
    readiness: registries.readiness,
    contributors: registries.contributors,
    template: registries.tools,
    policyDir: config.policyDir,
    home: config.home ?? realpathSync(homedir()),
    nodePath: config.nodePath ?? process.execPath,
    guardPath: config.guardPath ?? guardScriptPath(),
    ...config.allowedCwdRoots === undefined ? {} : { allowedCwdRoots: config.allowedCwdRoots },
    warn: (message) => { ctx.logger.warn(message) },
    publish: (input, signal) => {
      const mailbox = ctx.get('mailbox')
      if (mailbox === undefined) throw new Error('the mailbox service is not mounted')
      return mailbox.publish(input, signal)
    },
  })
  ctx.provide('claudeCodePolicy', policy)
  ctx.provide('claudeCodePolicyRegistries', registries)
}
