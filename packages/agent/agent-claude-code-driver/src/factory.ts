/**
 * The keyed agent factory for the `claude-code` driver: creates and resumes
 * {@link ClaudeCodeSeatAgent}s, publishes them through the agent and session
 * registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/factory
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory, AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions, SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ClaudeCodeSeatAgent, SeatGate } from './seat-agent.ts'
import type { SeatAgentDeps } from './seat-agent.ts'
import type { ClaudeCodeSeatConfig } from './seat-config.ts'

/** The seat a session belongs to and its validated configuration. */
export interface ResolvedSeat {
  /** Seat key (registry name); keys the live-query slot and the pid ledger. */
  readonly seat: string
  readonly config: ClaudeCodeSeatConfig
}

/**
 * Finds the seat row for a session. The seat key is `meta.agentPreset` when the
 * caller supplied one, otherwise the session id; the registry slice (S3) will
 * replace this with a lookup in the live seat registry.
 */
export type SeatResolver = (sessionId: SessionId, seatHint: string | undefined) => ResolvedSeat

/** Everything the factory needs beyond the agent's own dependencies. */
export interface FactoryInputs {
  /** Registration context carrying `agents` and `sessions`. */
  readonly ctx: Context
  readonly resolveSeat: SeatResolver
  readonly deps: SeatAgentDeps
  /** Persistence lookup for resume; absent means resume is unavailable. */
  readonly persistence: () => SessionPersistence | undefined
  /** Process-wide single-live-query gate; a private one is made when omitted. */
  readonly gate?: SeatGate | undefined
}

/** Raise the creation-abort reason as an Error. */
function abortError(signal: AbortSignal, id: SessionId): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
}

/** Factory registered under the `claude-code` driver key. */
export class ClaudeCodeSeatFactory implements AgentFactory {
  private readonly live = new Set<() => Promise<void>>()
  private accepting = true
  private readonly gate: SeatGate

  /**
   * @param inputs - registration context, seat resolver, agent dependencies, and persistence lookup.
   */
  constructor(private readonly inputs: FactoryInputs) {
    this.gate = inputs.gate ?? new SeatGate()
  }

  /** The single-live-query gate shared by every agent this factory makes. */
  get seatGate(): SeatGate {
    return this.gate
  }

  /** Stop accepting new agents and tear down every live one. */
  async dispose(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.live].map(dispose => dispose()))
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.assertAccepting()
    const { seat, config } = this.inputs.resolveSeat(options.sessionId, options.meta?.agentPreset)
    const meta = options.meta
    const cwd = meta?.cwd
    if (meta === undefined || cwd === undefined || !isAbsolute(cwd)) {
      throw new Error(`agent-claude-code-driver: seat "${seat}" needs an absolute meta.cwd to start`)
    }
    this.assertSeatFree(seat)
    using preparation = SessionPreparation.create(this.inputs.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      meta,
    }))
    return await this.publish(ownerCtx, preparation.session, seat, config, cwd, options.setup, options.signal, 'startup')
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.assertAccepting()
    const persistence = this.inputs.persistence()
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    using preparation = await persistence.prepare(id, options.signal)
    const header = preparation.session.header
    const { seat, config } = this.inputs.resolveSeat(id, header.agentPreset)
    if (header.cwd === undefined || !isAbsolute(header.cwd)) {
      throw new Error(`agent-claude-code-driver: persisted session "${id}" has no absolute cwd; seat "${seat}" cannot resume`)
    }
    this.assertSeatFree(seat)
    return await this.publish(ownerCtx, preparation.session, seat, config, header.cwd, options.setup, options.signal, 'resume')
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('agent-claude-code-driver: factory is not active')
  }

  /** A second create or resume for a seat that already has a live query rejects loudly. */
  private assertSeatFree(seat: string): void {
    if (this.gate.isHeld(seat)) {
      throw new Error(`agent-claude-code-driver: seat "${seat}" already has a live Claude Code query; only one runs per seat`)
    }
  }

  /** Build the agent around an acquired session, run setup, publish, and own the teardown. */
  private async publish(
    ownerCtx: Context,
    session: Session,
    seat: string,
    config: ClaudeCodeSeatConfig,
    cwd: string,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    const { ctx, deps } = this.inputs
    const id = session.id
    if (signal?.aborted === true) throw abortError(signal, id)
    ownerCtx.fiber.assertActive()
    const agent = new ClaudeCodeSeatAgent(ctx, id, session, seat, config, cwd, deps, this.gate)
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      try {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
        await agent.scope.dispose()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          this.live.delete(dispose)
          if (!ownerTriggered) await unfollowOwner()
        }
      }
    })())
    this.live.add(dispose)
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      return dispose(true)
    }, `claudeCodeSeat.lifecycle(${id})`)
    try {
      const commit = await Promise.race([
        Promise.resolve(setup?.(agent.ctx)),
        ...signal === undefined ? [] : [new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(abortError(signal, id)) }, { once: true })
        })],
      ])
      commit?.commit()
      if (isAborted(signal)) throw abortError(signal, id)
      detachSession = ctx.sessions.enter(session)
      detachAgent = ctx.agents.enter(agent, ownerCtx.agent)
      ctx.sessions.announce(session)
      ctx.agents.announce(agent)
      emitAgentEvent(ctx, agent, 'agent/session-start', { source })
      return { agent, dispose }
    } catch (error: unknown) {
      await dispose()
      throw error
    }
  }
}

/** Read the abort flag fresh; flow narrowing from an earlier check goes stale across awaits. */
function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true
}
