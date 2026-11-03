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
import { assertCleanHostEnv, buildChildEnv } from './env.ts'
import { ClaudeCodeSeatFactory } from './factory.ts'
import type { ResolvedSeat } from './factory.ts'
import { killProcessGroup, ProcessLedger } from './ledger.ts'
import type { SeatAgentDeps, TranscriptState } from './seat-agent.ts'
import { ClaudeCodeSeatRow, CLAUDE_CODE_DRIVER_KEY, parseSeatRow } from './seat-config.ts'

export { buildQueryOptions } from './options.ts'
export type { BuildQueryOptionsInput, QueryBinding, QueryOptionsContext, QueryOptionsExtension } from './options.ts'
export { assertCleanHostEnv, buildChildEnv, CLAUDE_CODE_FORBIDDEN_ENV, forbiddenEnvPresent } from './env.ts'
export { ClaudeCodeSeatFactory } from './factory.ts'
export type { FactoryInputs, ResolvedSeat, SeatResolver } from './factory.ts'
export { killProcessGroup, ProcessLedger, readProcessStartTime, SYSTEM_PROCESS_OPS } from './ledger.ts'
export type { LedgerEntry, LedgerProcessOps, ReapReport } from './ledger.ts'
export { PromptStream } from './prompt-stream.ts'
export {
  ClaudeCodeDriverError, ClaudeCodeSeatAgent, CLAUDE_CODE_TURN_ERROR_CODES, SeatGate,
} from './seat-agent.ts'
export type { SeatAgentDeps, TranscriptState } from './seat-agent.ts'
export {
  CLAUDE_CODE_DRIVER_KEY, CLAUDE_CODE_EFFORTS, CLAUDE_CODE_ROLES, ClaudeCodeSeatBlock, ClaudeCodeSeatRow,
  isFableModel, parseSeatRow, toolPolicyFor,
} from './seat-config.ts'
export type {
  ClaudeCodeEffort, ClaudeCodeRole, ClaudeCodeSeatConfig, ClaudeCodeToolPolicy,
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
  /** Absolute directory where the driver keeps host state (the pid ledger). */
  stateDir: string
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
  const seats = new Map<string, ResolvedSeat>()
  for (const [seat, row] of Object.entries(config.seats)) {
    seats.set(seat, { seat, config: parseSeatRow(row, seat) })
  }
  const ledger = new ProcessLedger(join(config.stateDir, 'claude-code-seat-pids.json'))
  const reaped = ledger.reapStale()
  if (reaped.reaped.length > 0) {
    ctx.logger.warn(`agent-claude-code-driver: killed orphaned Claude Code children of seats: ${reaped.reaped.join(', ')}`)
  }
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
