/**
 * Claude Code seat driver plugin. It registers a {@link ClaudeCodeSeatFactory}
 * under the `claude-code` key of the keyed agent-factory seam, so a seat whose
 * registry row says `driver: claude-code` is driven by the unmodified `claude`
 * program through the official Agent SDK instead of the dsh model loop.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver
 */

import { join } from 'node:path'
import { getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { assertBinaryUnchanged, attestClaudePath, BinaryPins } from './attest.ts'
import type { BinaryAttestation } from './attest.ts'
import { assertCleanHostEnv, buildChildEnv } from './env.ts'
import { ClaudeCodeSeatFactory } from './factory.ts'
import type { ResolvedSeat } from './factory.ts'
import { killProcessGroup, ProcessLedger } from './ledger.ts'
import type { SeatAgentDeps, TranscriptState } from './seat-agent.ts'
import { ClaudeCodeSeatRow, CLAUDE_CODE_DRIVER_KEY, parseSeatRow } from './seat-config.ts'
import { ensurePrivateDir, resolveStateDir } from './state.ts'

export { assertBinaryUnchanged, attestClaudePath, BinaryPins, sha256File } from './attest.ts'
export type { AttestOptions, BinaryAttestation } from './attest.ts'
export { allowlistSettings, buildQueryOptions } from './options.ts'
export type {
  BuildQueryOptionsInput, ExtensionSettings, QueryBinding, QueryOptionsContext, QueryOptionsExtension,
} from './options.ts'
export { assertPrivateFile, ensurePrivateDir, resolveStateDir, writeAtomic } from './state.ts'
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
  foldModelId, isAllowedModel, isFableModel, parseSeatRow, toolPolicyFor,
} from './seat-config.ts'
export type {
  ClaudeCodeEffort, ClaudeCodeRole, ClaudeCodeSeatConfig, ClaudeCodeToolPolicy, ParseSeatRowOptions,
} from './seat-config.ts'

/** Cordis plugin name. */
export const name = 'agent-claude-code-driver'

/** Services the driver needs: the agent registry, the session store, and the shared subprocess owner. */
export const inject = ['agents', 'sessions', 'subprocess']

/** Default process-tree termination grace. */
const DEFAULT_GRACE_MS = 3_000

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
  for (const [seat, row] of Object.entries(config.seats)) {
    // No permission-policy extension exists yet (slice S5), so `coder` rows are refused here.
    const seatConfig = parseSeatRow(row, seat, { policyExtension: false })
    const attestation = attestations.get(seatConfig.claudePath) ?? attestClaudePath(seatConfig.claudePath)
    pins.enforce(seat, attestation.sha256, seatConfig.claudePathSha256)
    attestations.set(seatConfig.claudePath, attestation)
    attestedBySeat.set(seat, attestation)
    seats.set(seat, { seat, config: seatConfig })
  }
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
    warn: (message) => { ctx.logger.warn(message) },
  }
  const factory = new ClaudeCodeSeatFactory({
    ctx,
    resolveSeat: (sessionId: SessionId, hint: string | undefined) => {
      const key = hint ?? sessionId
      const resolved = seats.get(key)
      if (resolved === undefined) {
        throw new Error(`agent-claude-code-driver: no ${CLAUDE_CODE_DRIVER_KEY} seat row for "${key}" (configured seats: ${[...seats.keys()].join(', ') || 'none'})`)
      }
      return resolved
    },
    deps,
    persistence: () => ctx.get('sessionPersistence'),
  })
  ctx.effect(() => () => factory.dispose(), 'agentClaudeCodeDriver.factory()')
  ctx.effect(() => ctx.agents.setFactory(factory, CLAUDE_CODE_DRIVER_KEY), 'agentClaudeCodeDriver.setFactory()')
}
