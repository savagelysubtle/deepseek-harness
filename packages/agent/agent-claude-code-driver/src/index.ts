/**
 * Claude Code seat driver plugin. It registers a {@link ClaudeCodeSeatFactory}
 * under the `claude-code` key of the keyed agent-factory seam, so a seat whose
 * registry row says `driver: claude-code` is driven by the unmodified `claude`
 * program through the official Agent SDK instead of the dsh model loop.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { SeatBinding, SeatBindingOptions } from '@deepseek-ai/dsh-mailbox'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { defaultAdmission } from './admission.ts'
import type { MailAdmission } from './admission.ts'
import { assertBinaryUnchanged, attestClaudePath, BinaryPins } from './attest.ts'
import type { BinaryAttestation } from './attest.ts'
import { assertCleanHostEnv, buildChildEnv } from './env.ts'
import { ClaudeCodeSeatFactory } from './factory.ts'
import type { ResolvedSeat } from './factory.ts'
import { killProcessGroup, ProcessLedger } from './ledger.ts'
import type { MailLeaseSink } from './mail-lease.ts'
import type { SeatAgentDeps, TranscriptState } from './seat-agent.ts'
import { SeatGate } from './seat-agent.ts'
import {
  ClaudeCodeHostSeat, ClaudeCodeSeatRow, CLAUDE_CODE_DRIVER_KEY, hostSeatStanza, mergeHostSeat, parseHostSeat, parseSeatRow,
} from './seat-config.ts'
import type { ClaudeCodeSeatConfig, RegistrySeatView } from './seat-config.ts'
import { CallWindowStore, SeatSessionPins } from './seat-state.ts'
import { ensurePrivateDir, KILL_SWITCH_FILE_NAME, killSwitchPresent, resolveStateDir } from './state.ts'

export { CALL_WINDOW_FILE_NAME, CallWindowStore, SEAT_SESSIONS_FILE_NAME, SeatSessionPins } from './seat-state.ts'
export type { CallWindowPersistence, SessionPinOutcome } from './seat-state.ts'
export { ClaudeCodeHostSeat, hostSeatStanza, mergeHostSeat, parseHostSeat } from './seat-config.ts'
export type { RegistrySeatView } from './seat-config.ts'
export { mailFrom } from './admission.ts'

export { assertBinaryUnchanged, attestClaudePath, BinaryPins, sha256File } from './attest.ts'
export type { AttestOptions, BinaryAttestation } from './attest.ts'
export { POLICY_FILE_VERSION, SeatMutedByPolicyError } from './policy-contract.ts'
export type {
  ClaudeCodePolicy, PolicyExtension, PolicyFileV1, PolicyHostSeatFields, PolicyQueryContext, PolicyReadiness,
  ReadinessContributor, ReadinessRequirement,
} from './policy-contract.ts'
export { allowlistSettings, buildQueryOptions } from './options.ts'
export type {
  BuildQueryOptionsInput, ExtensionSettings, QueryBinding, QueryOptionsContext, QueryOptionsExtension,
} from './options.ts'
export {
  defaultAdmission, externalHops, frameMailText, isTaintedMail, mailboxMessageId, mailFrameFooter, mailFrameHeader,
  unrecordableMailboxId,
} from './admission.ts'
export type { MailAdmission, MailAdmissionDecision, MailAdmissionPath, MailAdmissionRequest } from './admission.ts'
export { MailLog } from './mail-lease.ts'
export type { MailLeaseSink, MailState } from './mail-lease.ts'
export { StreamMapper } from './mapper.ts'
export type { MapperEventType, MapperSink } from './mapper.ts'
export {
  assertPrivateFile, ensurePrivateDir, KILL_SWITCH_FILE_NAME, killSwitchPresent, resolveStateDir, writeAtomic,
} from './state.ts'
export { assertCleanHostEnv, buildChildEnv, CLAUDE_CODE_FORBIDDEN_ENV, forbiddenEnvPresent } from './env.ts'
export { ClaudeCodeSeatFactory } from './factory.ts'
export type { FactoryInputs, ResolvedSeat, SeatResolver } from './factory.ts'
export { isGroupAlive, killProcessGroup, ProcessLedger, readBootId, readProcessStartTime, SYSTEM_PROCESS_OPS } from './ledger.ts'
export type { LedgerEntry, LedgerProcessOps, ReapReport } from './ledger.ts'
export { PromptStream } from './prompt-stream.ts'
export {
  ClaudeCodeDriverError, ClaudeCodeSeatAgent, CLAUDE_CODE_TURN_ERROR_CODES, SeatGate,
} from './seat-agent.ts'
export type { SeatAgentDeps, TranscriptState } from './seat-agent.ts'
export {
  CLAUDE_CODE_DRIVER_KEY, CLAUDE_CODE_EFFORTS, CLAUDE_CODE_ROLES, ClaudeCodeSeatBlock, ClaudeCodeSeatRow,
  DEFAULT_CALL_WINDOW_MS, DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_CALLS_PER_WINDOW, DEFAULT_MAX_TURNS, MIN_CALL_WINDOW_MS,
  foldModelId, isAllowedModel, isFableModel, parseSeatRow, toolPolicyFor,
} from './seat-config.ts'
export type {
  ClaudeCodeEffort, ClaudeCodeRole, ClaudeCodeSeatConfig, ClaudeCodeToolPolicy, ParseSeatRowOptions,
} from './seat-config.ts'

/**
 * The mail seams a later slice (registry admission in S3, the mailbox bridge's lease in S8) plugs in by
 * providing `ctx.claudeCodeMailHooks`. Both are optional and read at use time, so the provider may load
 * after this plugin.
 */
export interface ClaudeCodeMailHooks {
  /** Replaces the default admission (deny any external-class hop) on the send and steer paths. */
  readonly admit?: MailAdmission | undefined
  /** The real mailbox lease: settled or failed once per mail, deterministically. */
  readonly lease?: MailLeaseSink | undefined
}

/** What the driver hands the seat source for one create or resume. */
export interface SeatSourceRequest {
  /** The dsh session being created or resumed. */
  readonly sessionId: SessionId
  /** `meta.agentPreset` / the persisted header's preset, when the caller supplied one. */
  readonly hint: string | undefined
  /** The frozen registry row the mailbox bridge resolved for this delivery; absent for every other caller. */
  readonly binding: SeatBinding | undefined
}

/** The seat a source resolved and the registry row that routed it (still untrusted; the host entry decides). */
export interface SeatSourceResolution {
  /** The seat name. */
  readonly seat: string
  /** The registry row. */
  readonly row: RegistrySeatView
}

/**
 * Finds the registry row of a seat that is not in the static `seats` config. Provided as
 * `ctx.claudeCodeSeatSource` (by the registry glue package); read at use time, so its provider may load
 * after this plugin. A source must refuse (throw) when it cannot prove the row is the bridge's current one.
 */
export interface ClaudeCodeSeatSource {
  /**
   * Resolve one create or resume.
   * @param request - the session being created or resumed, with the hint and the bridge's seat binding if it passed one.
   * @returns the seat key and the registry row the source has verified as the bridge's current one.
   * @throws when the request carries no binding, or the binding is stale or forged.
   */
  resolve(request: SeatSourceRequest): SeatSourceResolution
  /**
   * Whether the registry currently routes `seat` to this driver; `undefined` when the source cannot tell yet.
   * Drives the mount-time warning for a host entry that has no registry row.
   * @param seat - the seat key to look up.
   * @returns `true` when a row routes the seat to this driver, `false` when none does, `undefined` when unknown.
   */
  hasRow?(seat: string): boolean | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeMailHooks: ClaudeCodeMailHooks
    claudeCodeSeatSource: ClaudeCodeSeatSource
  }
}

/** Cordis plugin name. */
export const name = 'agent-claude-code-driver'

/** Services the driver needs: the agent registry, the session store, and the shared subprocess owner. */
export const inject = ['agents', 'sessions', 'subprocess']

/** Default process-tree termination grace. */
const DEFAULT_GRACE_MS = 3_000

/** How long after mount the driver checks that every host entry has a registry row (the registry loads after mount). */
export const UNROUTED_CHECK_DELAY_MS = 15_000

/** Default refusal window after a pause signal that carried no reset time (15 minutes). */
const DEFAULT_PAUSE_MS = 15 * 60_000

/** Deployment configuration of the driver. */
export interface Config {
  /**
   * Directory where the driver keeps host state (the pid ledger and binary pins): a subdirectory name
   * under the harness home, or an absolute path already inside it. Created with mode 0700.
   */
  stateDir: string
  /** Harness home the state directory must live in; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Claude Code seat rows keyed by seat name (`meta.agentPreset`, else the session id). */
  seats: Record<string, ClaudeCodeSeatRow>
  /**
   * Directories the realpath of every host seat's `claude_path` must lie under. Required (non-empty, absolute)
   * when `hostSeats` is non-empty; the founder's limit on what a registry-routed seat can ever run.
   */
  claudePathPrefixes?: string[]
  /**
   * Host-private entries for seats the registry routes to this driver, keyed by seat name. They hold everything
   * that costs money or widens trust (model, caps, binary, cwd pin, sender ceiling); the registry row holds
   * only routing and admission. This config lives in the profile, which no seat can write.
   */
  hostSeats?: Record<string, ClaudeCodeHostSeat>
  /** Process-tree termination grace in milliseconds. */
  disposeGraceMs?: number
  /** Refusal window in milliseconds after a pause signal with no reset time. */
  defaultPauseMs?: number
}

/** Schema of {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  dshHome: z.string(),
  seats: z.dict(ClaudeCodeSeatRow).default({}),
  claudePathPrefixes: z.array(z.string()).default([]),
  hostSeats: z.dict(ClaudeCodeHostSeat).default({}),
  disposeGraceMs: z.number().step(1).min(1).default(DEFAULT_GRACE_MS),
  defaultPauseMs: z.number().step(1).min(1).default(DEFAULT_PAUSE_MS),
})

/**
 * Inspect the Claude transcript of a bound session through the SDK.
 * @param sdkSessionId - the Claude session id.
 * @param cwd - the seat working directory (Claude keys transcripts by it).
 * @returns `ok` when the SDK finds the session, `missing` when it does not, `unreadable` when reading throws.
 */
export async function sdkTranscriptState(sdkSessionId: string, cwd: string): Promise<TranscriptState> {
  try {
    return (await getSessionInfo(sdkSessionId, { dir: cwd })) === undefined ? 'missing' : 'ok'
  } catch {
    return 'unreadable'
  }
}

/**
 * Register the `claude-code` factory.
 * @param ctx - context carrying the agent registry, session store, and subprocess owner.
 * @param config - state directory, seat rows, and timing.
 * @throws when a seat row is invalid or the host environment carries a forbidden credential override.
 */
export function apply(ctx: Context, config: Config): void {
  assertCleanHostEnv()
  const stateDir = resolveStateDir(config.stateDir, config.dshHome)
  ensurePrivateDir(stateDir)
  const pins = new BinaryPins(stateDir)
  const attestations = new Map<string, BinaryAttestation>()
  const attestedBySeat = new Map<string, BinaryAttestation>()
  const seats = new Map<string, ResolvedSeat>()
  const attestSeat = (seat: string, seatConfig: ClaudeCodeSeatConfig): void => {
    const attestation = attestations.get(seatConfig.claudePath) ?? attestClaudePath(seatConfig.claudePath)
    pins.enforce(seat, attestation.sha256, seatConfig.claudePathSha256)
    attestations.set(seatConfig.claudePath, attestation)
    attestedBySeat.set(seat, attestation)
  }
  for (const [seat, row] of Object.entries(config.seats)) {
    // No permission-policy extension exists yet (slice S5), so `coder` rows are refused here.
    const seatConfig = parseSeatRow(row, seat, { policyExtension: false })
    attestSeat(seat, seatConfig)
    seats.set(seat, { seat, config: seatConfig })
  }
  // Host entries for registry-routed seats: validated and attested now, so a bad entry fails the mount
  // loudly instead of surfacing on the first mail.
  const hostSeats = new Map(Object.entries(config.hostSeats ?? {}))
  const prefixes = config.claudePathPrefixes ?? []
  if (hostSeats.size > 0 && prefixes.length === 0) {
    throw new Error('agent-claude-code-driver: claudePathPrefixes is required (and must not be empty) when hostSeats is non-empty')
  }
  for (const prefix of prefixes) {
    if (!isAbsolute(prefix)) throw new Error(`agent-claude-code-driver: claudePathPrefixes entry "${prefix}" must be an absolute path`)
  }
  for (const [seat, host] of hostSeats) {
    if (seats.has(seat)) throw new Error(`agent-claude-code-driver: seat "${seat}" is configured in both seats and hostSeats; use one`)
    attestSeat(seat, parseHostSeat(host, seat, prefixes))
  }
  const sessionPins = new SeatSessionPins(stateDir)
  const gate = new SeatGate(new CallWindowStore(stateDir, (message) => { ctx.logger.warn(message) }))
  const ledger = new ProcessLedger(join(stateDir, 'claude-code-seat-pids.json'))
  const report = ledger.reapStale()
  if (report.reaped.length > 0) {
    ctx.logger.warn(`agent-claude-code-driver: killed orphaned Claude Code children of seats: ${report.reaped.join(', ')}`)
  }
  if (report.survivors.length > 0) {
    ctx.logger.warn(`agent-claude-code-driver: seats ${report.survivors.join(', ')} left process-group members behind after their leader died; they were not killed (ownership cannot be proven). Inspect with pgrep -f claude`)
  }
  if (report.failed.length > 0) {
    ctx.logger.warn(`agent-claude-code-driver: could not kill the orphaned children of seats ${report.failed.join(', ')}; continuing`)
  }
  if (report.skipped.length > 0) {
    ctx.logger.warn(`agent-claude-code-driver: seats ${report.skipped.join(', ')} belong to another live host sharing this state directory; left alone`)
  }
  let warnedNoDurability = false
  const killSwitchFile = join(stateDir, KILL_SWITCH_FILE_NAME)
  const digestKey = randomBytes(32)
  const deps: SeatAgentDeps = {
    query,
    spawnProcess: spec => ctx.subprocess.spawn(spec),
    killProcessGroup,
    transcriptState: sdkTranscriptState,
    hostEnv: () => process.env,
    childEnv: () => buildChildEnv(),
    now: () => Date.now(),
    graceMs: config.disposeGraceMs ?? DEFAULT_GRACE_MS,
    defaultPauseMs: config.defaultPauseMs ?? DEFAULT_PAUSE_MS,
    ledger,
    flush: async (session) => {
      if (!await ctx.sessions.flush(session) && !warnedNoDurability) {
        warnedNoDurability = true
        ctx.logger.warn('agent-claude-code-driver: the session store has no durability listener (no persistence plugin), so the session binding is only in memory and a crash before the first reply can orphan the Claude session')
      }
    },
    attestedBinary: (seat) => {
      const attestation = attestedBySeat.get(seat) as BinaryAttestation
      assertBinaryUnchanged(attestation)
      return attestation.realPath
    },
    admit: request => (ctx.get('claudeCodeMailHooks')?.admit ?? defaultAdmission)(request),
    lease: {
      settle: id => ctx.get('claudeCodeMailHooks')?.lease?.settle(id),
      fail: (id, reason) => ctx.get('claudeCodeMailHooks')?.lease?.fail(id, reason),
    },
    killSwitchActive: () => killSwitchPresent(killSwitchFile),
    digestKey,
    warn: (message) => { ctx.logger.warn(message) },
  }
  const factory = new ClaudeCodeSeatFactory({
    ctx,
    resolveSeat: (sessionId: SessionId, hint: string | undefined, agentOptions: AgentOptions | undefined) => {
      const key = hint ?? sessionId
      // The static config is consulted first; the registry source only for a seat it does not hold.
      const resolved = seats.get(key)
      if (resolved !== undefined) return resolved
      const source = ctx.get('claudeCodeSeatSource')
      if (source === undefined) {
        throw new Error(`agent-claude-code-driver: no ${CLAUDE_CODE_DRIVER_KEY} seat row for "${key}" (configured seats: ${[...seats.keys()].join(', ') || 'none'})`)
      }
      const binding = (agentOptions as SeatBindingOptions | undefined)?.seatBinding
      const { seat, row } = source.resolve({ sessionId, hint, binding })
      const host = hostSeats.get(seat)
      if (host === undefined) {
        throw new Error(
          `agent-claude-code-driver: seat "${seat}" is routed to ${CLAUDE_CODE_DRIVER_KEY} by the registry but has no host entry, so it is refused. `
          + `The founder adds this to the ${CLAUDE_CODE_DRIVER_KEY} driver row of the profile (cordis.patch.yml), with the real binary path:\n${hostSeatStanza(seat, row)}`,
        )
      }
      const seatConfig = mergeHostSeat(row, host, prefixes, seat)
      if (sessionPins.enforce(seat, sessionId, host.session_id) === 'reseeded') {
        ctx.logger.warn(`agent-claude-code-driver: seat "${seat}" was reseeded by the founder's host-config session_id; its session pin moved to ${sessionId}. The call window is kept.`)
      }
      return { seat, config: seatConfig, cwdPin: host.cwd }
    },
    deps,
    persistence: () => ctx.get('sessionPersistence'),
    gate,
  })
  // A host entry no registry row routes to is inert. The registry side loads its first snapshot only after
  // mount (the source cannot tell "not loaded yet" from "absent"), so the check runs once, shortly after mount.
  if (hostSeats.size > 0) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        const source = ctx.get('claudeCodeSeatSource')
        for (const seat of hostSeats.keys()) {
          if (source?.hasRow?.(seat) !== false) continue
          ctx.logger.warn(`agent-claude-code-driver: host entry for seat "${seat}" has no registry row with driver ${CLAUDE_CODE_DRIVER_KEY}, so nothing routes mail to it; add the row (dsh-hire) or remove the host entry`)
        }
      }, UNROUTED_CHECK_DELAY_MS)
      timer.unref()
      return () => { clearTimeout(timer) }
    }, 'agentClaudeCodeDriver.unroutedHostSeats()')
  }
  ctx.effect(() => () => factory.dispose(), 'agentClaudeCodeDriver.factory()')
  ctx.effect(() => ctx.agents.setFactory(factory, CLAUDE_CODE_DRIVER_KEY), 'agentClaudeCodeDriver.setFactory()')
}
