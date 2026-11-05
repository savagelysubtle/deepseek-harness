/**
 * The Claude Code seat Agent: one dsh Session driven by the unmodified
 * `claude` program through the official Agent SDK.
 *
 * Turn model (verified in the S0 spike): each turn runs one streaming-input
 * `query()` whose prompt is an open {@link PromptStream}. `steer()` pushes the
 * message into that stream; Claude consumes it at its next model-call
 * boundary, so steering latency is the remaining time of the tool call in
 * flight. The stream is closed once every pushed message has been answered
 * and the inbox is empty. The fallback, {@link ClaudeCodeSeatAgent.interruptAndResume},
 * interrupts the query and delivers the message in a resumed query.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/seat-agent
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import type {
  Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentCancelCause, AgentEventDispatch, AgentOptions, AgentStatus, CancelOptions, InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { recordClaudeCodeEvent } from '@deepseek-ai/dsh-agent-claude-code'
import type { ClaudeCodeEventInputMap, ClaudeCodeEventType } from '@deepseek-ai/dsh-agent-claude-code'
import { CLAUDE_CODE_DRIVER_NAME, sanitizeFreeText } from '@deepseek-ai/dsh-agent-claude-code'
import { createAssistantMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { claudeSpawnSpec, ManagedClaudeCodeProcess } from '@deepseek-ai/dsh-subagent-claude-code/src/process.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { defaultAdmission, externalHops, frameMailText, isTaintedMail, mailboxMessageId, mailFrom, unrecordableMailboxId } from './admission.ts'
import type { CallWindowPersistence } from './seat-state.ts'
import type { MailAdmission, MailAdmissionDecision, MailAdmissionPath } from './admission.ts'
import { assertCleanHostEnv } from './env.ts'
import { MailLog } from './mail-lease.ts'
import type { MailLeaseSink, MailState } from './mail-lease.ts'
import { StreamMapper } from './mapper.ts'
import { buildQueryOptions, expectedInitTools, toolSetMismatch } from './options.ts'
import type { QueryBinding } from './options.ts'
import { SeatMutedByPolicyError } from './policy-contract.ts'
import type { ClaudeCodePolicy, PolicyExtension, PolicyQueryContext } from './policy-contract.ts'
import { PromptStream } from './prompt-stream.ts'
import { assertRoleServable, isAllowedModel } from './seat-config.ts'
import type { ClaudeCodeSeatConfig } from './seat-config.ts'
import type { ProcessLedger } from './ledger.ts'

/** Longest error text the driver lets into a durable record or a warning. */
const MAX_ERROR_TEXT_CHARS = 400

/** Longest reason kept in a session-taint record. */
const MAX_REASON_CHARS = 200

/** How often a live turn re-reads the kill-switch flag file, so a switch set mid-tool still aborts the query. */
const KILL_SWITCH_POLL_MS = 500

/** Longest a pause may last, whatever reset time the CLI reports. */
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000

/** A session id as the CLI writes it (8-4-4-4-12 hexadecimal). */
const SDK_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An error chain with paths, tokens and control characters redacted and the length capped. */
function errText(error: unknown): string {
  return sanitizeFreeText(errorChain(error), MAX_ERROR_TEXT_CHARS)
}

/** Error codes the driver puts on a failed turn's `turn/end` reason. */
export const CLAUDE_CODE_TURN_ERROR_CODES = {
  /** The Claude transcript for a bound session is missing or unreadable. */
  resumeFailed: 'CLAUDE_CODE_RESUME_FAILED',
  /** The subscription window refused work. */
  paused: 'CLAUDE_CODE_PAUSED',
  /** The query ended without a `result` message. */
  noResult: 'CLAUDE_CODE_NO_RESULT',
  /** A second live query was requested for a seat that already has one. */
  busy: 'CLAUDE_CODE_SEAT_BUSY',
  /** The host environment carries a forbidden credential override. */
  environment: 'CLAUDE_CODE_ENVIRONMENT',
  /** The session binding could not be made durable, or the logged binding is not a valid session id. */
  binding: 'CLAUDE_CODE_BINDING',
  /** The kill-switch flag file is present. */
  killSwitch: 'CLAUDE_CODE_KILL_SWITCH',
  /** The seat used up its calls for the current window. */
  callWindow: 'CLAUDE_CODE_CALL_WINDOW',
  /** A tainted turn was about to run with tools. */
  tainted: 'CLAUDE_CODE_TAINTED_TOOLS',
  /** The seat's role cannot be served now: the policy service is absent, unknown, or not ready for it. */
  policy: 'CLAUDE_CODE_POLICY',
  /** The policy left the seat no tools, so it is muted rather than started. */
  muted: 'CLAUDE_CODE_SEAT_MUTED',
  /** The query's `system/init` message reported a tool set other than the expected one. */
  toolSet: 'CLAUDE_CODE_TOOL_SET',
} as const

/** A driver failure carrying a stable machine code for `turn/end`. */
export class ClaudeCodeDriverError extends Error {
  /**
   * @param code - one of {@link CLAUDE_CODE_TURN_ERROR_CODES}.
   * @param message - human-readable message including the remedy.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ClaudeCodeDriverError'
  }
}

/** How a Claude transcript looks on disk for a bound session. */
export type TranscriptState = 'ok' | 'missing' | 'unreadable'

/** Everything the agent needs from its environment; every field is injectable for tests. */
export interface SeatAgentDeps {
  /** The SDK `query` function. */
  readonly query: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query
  /** Spawn a child through the shared subprocess owner (own process group, tree-scoped kill). */
  readonly spawnProcess: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Kill a process group directly; the last resort when the subprocess owner cannot prove the tree gone. */
  readonly killProcessGroup: (pid: number) => void
  /** Inspect the Claude transcript of a bound session. */
  readonly transcriptState: (sdkSessionId: string, cwd: string) => Promise<TranscriptState>
  /** The host environment to preflight. */
  readonly hostEnv: () => NodeJS.ProcessEnv
  /** The child environment (scrubbed, forbidden names removed). */
  readonly childEnv: () => Record<string, string>
  /** Wall clock in epoch milliseconds. */
  readonly now: () => number
  /** Process-tree termination grace in milliseconds. */
  readonly graceMs: number
  /** How long to refuse turns after a pause signal that carried no reset time. */
  readonly defaultPauseMs: number
  /** Pid ledger for orphan reaping; absent disables recording. */
  readonly ledger?: ProcessLedger | undefined
  /** Make everything appended to the session so far durable (the session store flush). */
  readonly flush: (session: Session) => Promise<void>
  /**
   * Re-check that the seat's attested binary is unchanged (throws when it is not) and return the attested
   * real path the SDK must run; absent means no attestation, and the configured path is used.
   */
  readonly attestedBinary?: ((seat: string) => string) | undefined
  /**
   * The permission-policy service as it is registered right now (`ctx.get('claudeCodePolicy')`), read per turn and
   * never cached: a `lead` or `coder` seat cannot run a normal turn without it, and `mail-only` never reads it.
   */
  readonly policy?: (() => ClaudeCodePolicy | undefined) | undefined
  /** Mail admission check for the send and steer paths; defaults to {@link defaultAdmission}. */
  readonly admit?: MailAdmission | undefined
  /** The mailbox bridge's lease, settled or failed deterministically per mail; absent means no lease calls. */
  readonly lease?: MailLeaseSink | undefined
  /** Whether the kill-switch flag file is present; read before each turn and query, on each stream message, and on a timer. */
  readonly killSwitchActive?: (() => boolean) | undefined
  /** Kill-switch poll interval in milliseconds during a live turn; defaults to 500. */
  readonly killSwitchPollMs?: number | undefined
  /** Secret keying tool-argument digests; a private random key is made when omitted. */
  readonly digestKey?: Uint8Array | undefined
  /** Warning sink. */
  readonly warn: (message: string) => void
}

/** Holds the single live-query slot of each seat in this process. */
export class SeatGate {
  private readonly held = new Map<string, unknown>()
  private readonly calls = new Map<string, number[]>()

  /**
   * @param persistence - durable call history; when given, a seat's window survives a session-id change (a
   *   reseed) and a host restart, because the saved times, not the new session's log, are the record.
   */
  constructor(private readonly persistence?: CallWindowPersistence) {}

  /**
   * Whether a seat currently has a live query.
   * @param seat - seat key.
   * @returns true while the seat's slot is taken.
   */
  isHeld(seat: string): boolean {
    return this.held.has(seat)
  }

  /**
   * Take the seat's live-query slot.
   * @param seat - seat key.
   * @param holder - identity of the taker, used to release.
   * @throws when another live query already holds the slot.
   */
  acquire(seat: string, holder: unknown): void {
    if (this.held.has(seat)) {
      throw new ClaudeCodeDriverError(
        CLAUDE_CODE_TURN_ERROR_CODES.busy,
        `agent-claude-code-driver: seat "${seat}" already has a live Claude Code query; only one runs per seat. Steer the live turn or cancel it first.`,
      )
    }
    this.held.set(seat, holder)
  }

  /**
   * How many queries a seat started inside the window ending now.
   * @param seat - seat key.
   * @param now - epoch milliseconds.
   * @param windowMs - window length.
   * @returns the number of queries noted in the window.
   */
  callsInWindow(seat: string, now: number, windowMs: number): number {
    const kept = (this.calls.get(seat) ?? []).filter(at => at > now - windowMs)
    this.calls.set(seat, kept)
    return kept.length
  }

  /**
   * Seed a seat's call history, once: only when this process has no record of the seat yet, so a restart does not
   * reset the window and several agents of one seat do not count a call twice. The saved history (when the gate
   * has persistence and the seat has any) is the record, plus the log's queries older than all of it (made
   * before saving began); otherwise the session log alone seeds it.
   * @param seat - seat key.
   * @param times - epoch milliseconds of the queries the log shows the seat started.
   */
  seed(seat: string, times: readonly number[]): void {
    if (this.calls.has(seat)) return
    const saved = this.persistence?.load(seat)
    if (saved === undefined || saved.length === 0) {
      this.calls.set(seat, [...times])
      return
    }
    const earliest = Math.min(...saved)
    this.calls.set(seat, [...times.filter(at => at < earliest), ...saved])
  }

  /**
   * Note that a seat started a query.
   * @param seat - seat key.
   * @param now - epoch milliseconds.
   */
  noteCall(seat: string, now: number): void {
    const next = [...this.calls.get(seat) ?? [], now]
    this.calls.set(seat, next)
    this.persistence?.save(seat, next)
  }

  /**
   * Release the slot if `holder` still owns it.
   * @param seat - seat key.
   * @param holder - identity that took the slot.
   */
  release(seat: string, holder: unknown): void {
    if (this.held.get(seat) === holder) this.held.delete(seat)
  }
}

interface RunningPhase {
  kind: 'running'
  abort: AbortController
  turn: number
  wakeRequested: boolean
  live: LiveTurn | undefined
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | RunningPhase

interface PauseSignal {
  readonly reason: 'rate-limit' | 'usage-exhausted'
  readonly until?: number | undefined
}

/** State of the one query a running turn owns. */
class LiveTurn {
  readonly stream = new PromptStream()
  query: Query | undefined
  child: SubprocessHandle | undefined
  childExited = false
  /** Uuids of pushed messages no `result` has answered yet. */
  readonly unanswered = new Set<string>()
  result: SDKResultMessage | undefined
  pause: PauseSignal | undefined
  interrupted = false
  /** The kill switch aborted this query. */
  killed = false
  /** Files were read or content was fetched during this turn. */
  tainted = false
  /** The tool names the query's `system/init` message must report; unset until the options are built. */
  expectedTools: readonly string[] | undefined
  /** Why the init message's tool list was refused; the query was aborted. */
  toolMismatch: string | undefined
  /** A `system/init` message has arrived; until then no assistant or result message is trusted. */
  initSeen = false
  /** Every mail in the turn was a duplicate, so no query ran. */
  noQuery = false
  /** Steered messages claimed but not yet pushed (waiting for their claim records to be durable). */
  inflight = 0
  mapper: StreamMapper | undefined
  private tearingDown: Promise<void> | undefined

  constructor(
    readonly turn: number,
    readonly abort: AbortController,
    private readonly deps: SeatAgentDeps,
    /** Tainted mail: a throwaway Claude session with no tools. */
    readonly throwaway: boolean,
    /** Mailbox ids of the mail this turn owns; the steer path appends to it. */
    readonly mailIds: string[],
  ) {}

  /** Re-read the exit flag; it can change across awaits, which control-flow narrowing cannot see. */
  private exitedNow(): boolean {
    return this.childExited
  }

  /**
   * End the prompt stream, close the query, and make sure the child's whole
   * process group is gone: the subprocess owner's tree-scoped SIGTERM then
   * SIGKILL ladder first, a direct group kill if it cannot prove the tree
   * exited. Idempotent; every step tolerates the previous one having failed.
   */
  teardown(): Promise<void> {
    return (this.tearingDown ??= (async () => {
      this.stream.end()
      try {
        this.query?.close()
      } catch (error: unknown) {
        this.deps.warn(`agent-claude-code-driver: query.close() failed: ${errText(error)}`)
      }
      const child = this.child
      if (child === undefined || child.pid <= 0 || this.childExited) return
      try {
        child.terminate()
      } catch (error: unknown) {
        this.deps.warn(`agent-claude-code-driver: terminate failed: ${errText(error)}`)
      }
      let exited = false
      try {
        exited = await child.waitForExit(AbortSignal.timeout(this.deps.graceMs * 2 + 1_000))
      } catch (error: unknown) {
        this.deps.warn(`agent-claude-code-driver: waiting for child exit failed: ${errText(error)}`)
      }
      if (exited || this.exitedNow()) return
      try {
        this.deps.killProcessGroup(child.pid)
      } catch (error: unknown) {
        this.deps.warn(`agent-claude-code-driver: killing process group ${child.pid} failed: ${errText(error)}`)
      }
    })())
  }
}

/** Normalize whatever an admission check returned to a verdict; anything but an explicit allow is a refusal. */
function verdictOf(value: unknown): MailAdmissionDecision {
  const allow: unknown = typeof value === 'object' && value !== null ? (value as { allow?: unknown }).allow : undefined
  if (allow === true) return { allow: true }
  const reason: unknown = allow === false ? (value as { reason?: unknown }).reason : undefined
  return { allow: false, reason: typeof reason === 'string' && reason !== '' ? reason : 'admission check gave no verdict' }
}

/** Plain text of a dsh user message; non-text content is refused rather than dropped. */
function messageText(message: UserMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      throw new Error(`agent-claude-code-driver: message ${message.id} carries a ${block.type} block; Claude Code seats take text only`)
    }
    parts.push(block.text)
  }
  return frameMailText(parts.join('\n'))
}

/**
 * The only query options a throwaway (tainted-mail) query may carry: the fixed fences, the cap and model settings,
 * the binding, and the plumbing every query gets. Anything else (an MCP server, hooks, a permission callback,
 * extra arguments, a resumed session, any option a later SDK adds) refuses the turn.
 */
const THROWAWAY_ALLOWED_OPTIONS: ReadonlySet<string> = new Set([
  'settingSources', 'strictMcpConfig', 'permissionMode', 'tools', 'disallowedTools', 'maxTurns', 'maxBudgetUsd', 'model', 'effort',
  'cwd', 'pathToClaudeCodeExecutable', 'env', 'abortController', 'persistSession', 'sessionId', 'spawnClaudeCodeProcess',
])

/**
 * What is wrong with the options of a throwaway query, or `undefined` when they hold the guarantee: an empty
 * tool list, nothing persisted, only allowlisted keys, and the fixed fences at their fixed values.
 */
function throwawayViolation(options: Options, fableOk: boolean): string | undefined {
  if (!Array.isArray(options.tools) || options.tools.length !== 0) return 'an empty tool list'
  if (options.persistSession !== false) return 'persistSession off'
  const unexpected = Object.keys(options).find(key => !THROWAWAY_ALLOWED_OPTIONS.has(key))
  if (unexpected !== undefined) return `no "${unexpected}" option`
  if (!Array.isArray(options.settingSources) || options.settingSources.length !== 0) return 'settingSources: []'
  if (options.strictMcpConfig !== true) return 'strictMcpConfig: true'
  if (options.permissionMode !== 'dontAsk') return "permissionMode: 'dontAsk'"
  if (typeof options.model !== 'string' || !isAllowedModel(options.model, fableOk)) return 'an allowed model'
  return undefined
}

/** Tools whose use means untrusted content (files, fetched pages) entered the context. */
const TAINTING_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

/** Whether a CLI limit message says a usage limit was genuinely reached (the SDK's own prefix list). */
function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

/** The concatenated text blocks of an assistant message, tolerant of any block shape. */
function assistantText(message: { message?: { content?: unknown } }): string {
  const content = message.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block: { type?: string; text?: unknown }) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

/** Epoch milliseconds from an SDK reset time that may be in seconds or milliseconds. */
function resetMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value)
}

/** Clamp a pause end into a sane future window. */
function untilOf(deps: SeatAgentDeps, reset: number | undefined): number {
  const now = deps.now()
  return Math.min(reset !== undefined && reset > now ? reset : now + deps.defaultPauseMs, now + MAX_PAUSE_MS)
}

/** Whether the log's last turn started and never ended: the process died inside it. */
function endedMidTurn(session: Session): boolean {
  const start = session.events.findLastIndex(event => event.type === 'turn/start')
  return start !== -1 && !session.events.slice(start + 1).some(event => event.type === 'turn/end')
}

/** The pause still in force according to the last `claude-code/paused` record of a session; 0 when none. */
function restoredPause(session: Session, deps: SeatAgentDeps): number {
  const until = (session.events.findLast(event => event.type === 'claude-code/paused')?.data as { until?: unknown } | undefined)?.until
  const now = deps.now()
  return typeof until === 'number' && until > now ? Math.min(until, now + MAX_PAUSE_MS) : 0
}

/** Drives one Session through streaming-input Claude Code queries. */
export class ClaudeCodeSeatAgent implements Agent {
  readonly inbox: Inbox
  readonly options: AgentOptions
  /** Lifetime scope of this agent. */
  readonly scope: Scope
  readonly ctx: Context

  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly dispatch: AgentEventDispatch
  private sdkSessionId: string | undefined
  private transcriptKnown = false
  private pausedUntil = 0
  /** True until this instance has flushed the session once: another instance's flush may have failed. */
  private bindingPending = true
  /** What the log says about each mailbox message; the idempotency record. */
  private readonly mail: MailLog
  /** Mailbox ids claimed by a turn of this instance that has not ended. */
  private readonly mailInFlight = new Set<string>()
  /** Lease calls still running; `whenIdle` waits for them. */
  private readonly leaseWork = new Set<Promise<void>>()
  private readonly digestKey: Uint8Array
  /** Why this Claude session is tainted (sticky: only a fresh session, which has a new log, starts clean); undefined when clean. */
  private sessionTaint: string | undefined

  /**
   * @param loopCtx - registration context carrying `agents`.
   * @param id - the shared agent/session id.
   * @param session - the live session this agent drives.
   * @param seat - the seat key (registry name).
   * @param config - the validated seat configuration.
   * @param cwd - absolute working directory of the seat.
   * @param deps - injected environment.
   * @param gate - the process-wide single-live-query gate.
   */
  constructor(
    private readonly loopCtx: Context,
    readonly id: SessionId,
    readonly session: Session,
    private readonly seat: string,
    private readonly config: ClaudeCodeSeatConfig,
    private readonly cwd: string,
    private readonly deps: SeatAgentDeps,
    private readonly gate: SeatGate,
  ) {
    this.options = { provider: CLAUDE_CODE_DRIVER_NAME, model: config.model }
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    this.phase = { kind: 'idle', lastTurn: session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0 }
    this.pausedUntil = restoredPause(session, deps)
    this.mail = new MailLog(session)
    this.sessionTaint = (session.events.findLast(event => event.type === 'claude-code/session-tainted')?.data as { reason?: string } | undefined)?.reason
    // A crash mid-turn may have lost the taint record with the turn's unflushed events: restore fail closed.
    if (this.sessionTaint === undefined && endedMidTurn(session)) {
      this.sessionTaint = 'restored-mid-turn'
      this.rec('claude-code/session-tainted', { reason: this.sessionTaint, at: deps.now() })
    }
    // A step that started is a query (or an all-duplicate turn): rebuild the call window the process lost.
    gate.seed(seat, session.events.filter(event => event.type === 'step/start').map(event => event.time))
    this.digestKey = deps.digestKey ?? randomBytes(32)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  /** Epoch milliseconds until which this seat refuses turns after a pause signal; 0 when not paused. */
  get pausedUntilMs(): number {
    return this.pausedUntil > this.deps.now() ? this.pausedUntil : 0
  }

  /** Whether the running turn is tainted: throwaway mail, or files read or content fetched. */
  get turnTainted(): boolean {
    const live = this.phase.kind === 'running' ? this.phase.live : undefined
    return live !== undefined && (live.tainted || live.throwaway)
  }

  /**
   * Whether the Claude session has taken in untrusted content: tainted by an earlier turn or a restored log
   * (sticky per session), or this turn is tainted or a throwaway. The policy's mail tools read this to label sends.
   * @returns true when anything the seat now sends may carry untrusted content.
   */
  isTurnTainted(): boolean {
    return this.sessionTaint !== undefined || this.turnTainted
  }

  /**
   * Mark the whole Claude session tainted and log why; never cleared here. A compaction does not clear it: the SDK gives
   * no way to confirm the summary dropped the tainted text, so only a fresh session (a host reseed) starts clean.
   * @param reason - short reason; control-stripped, redacted and capped before it is logged.
   */
  markTurnTainted(reason: string): void {
    const live = this.phase.kind === 'running' ? this.phase.live : undefined
    if (live !== undefined) live.tainted = true
    if (this.sessionTaint !== undefined) return
    this.sessionTaint = sanitizeFreeText(reason, MAX_REASON_CHARS) || 'unspecified'
    this.rec('claude-code/session-tainted', { reason: this.sessionTaint, at: this.deps.now() })
    // Best effort: a crash before the next flush would otherwise restore the session as clean.
    const lost = (error: unknown): void => {
      this.deps.warn(`agent-claude-code-driver: could not make the session taint durable: ${errText(error)}`)
    }
    try {
      void this.deps.flush(this.session).catch(lost)
    } catch (error: unknown) {
      lost(error)
    }
  }

  /**
   * Trace ids of the mailbox mail this seat has been handed, rebuilt from its log.
   * @returns a fresh set of the `traceId` of every logged mailbox relay message.
   */
  deliveredTraceIds(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const event of this.session.events) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: unknown; form?: unknown; traceId?: unknown } | null }).source
      if (source?.kind === 'mailbox' && (source.form === undefined || source.form === 'relay') && typeof source.traceId === 'string' && source.traceId !== '') {
        ids.add(source.traceId)
      }
    }
    return ids
  }

  /** Lift a pause early (for example after the operator confirms the window reopened). */
  clearPause(): void {
    this.pausedUntil = 0
  }

  private setPhase(next: Phase): void {
    const before = this.status
    this.phase = next
    if (this.status !== before) this.dispatch.emit('agent/status', { status: this.status })
  }

  private rec<Type extends ClaudeCodeEventType>(type: Type, data: ClaudeCodeEventInputMap[Type]): boolean {
    return recordClaudeCodeEvent(this.session, type, data, (message) => { this.deps.warn(message) })
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (wakeup && this.disposed) {
      this.throwError(new Error(`agent "${this.id}": send refused, agent is disposed`))
    }
    const admitted = this.admitMail(message, target === 'next-step' ? 'steer' : 'send')
    if (admitted === undefined) return
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    // Tainted mail is never pushed into a live turn: it waits for its own throwaway turn.
    this.inbox.splice(wakingAfterAbort || admitted.tainted ? 'next-turn' : target, Infinity, 0, [message])
    if (wakeup) this.wake()
  }

  /**
   * Run the admission check for one arriving message. A refusal is loud: a
   * `claude-code/refused` record, a warning, and a failed lease; the message
   * is not queued. A check that throws or answers badly is a refusal.
   * @returns the taint of an admitted message, or undefined when refused.
   */
  private admitMail(message: UserMessage, path: MailAdmissionPath): { tainted: boolean } | undefined {
    const unrecordable = unrecordableMailboxId(message)
    if (unrecordable !== undefined) {
      this.refuseUnrecordable(path, unrecordable)
      return undefined
    }
    const messageId = mailboxMessageId(message)
    const from = mailFrom(message)
    const tainted = isTaintedMail(message)
    let decision: MailAdmissionDecision
    try {
      decision = verdictOf((this.deps.admit ?? defaultAdmission)({
        seat: this.seat,
        ...messageId === undefined ? {} : { messageId },
        ...from === undefined ? {} : { from },
        path,
        externalHops: externalHops(message),
        tainted,
        turnTainted: this.turnTainted,
      }))
    } catch (error: unknown) {
      decision = { allow: false, reason: `admission check failed: ${errText(error)}` }
    }
    if (decision.allow) return { tainted }
    const reason = sanitizeFreeText(decision.reason, MAX_ERROR_TEXT_CHARS)
    this.rec('claude-code/refused', { reason: 'admission', ...messageId === undefined ? {} : { messageId }, detail: reason, at: this.deps.now() })
    this.deps.warn(`agent-claude-code-driver: seat "${this.seat}" refused ${path} mail${messageId === undefined ? '' : ` ${messageId}`}: ${reason}`)
    if (messageId !== undefined) void this.leaseCall(() => this.deps.lease?.fail(messageId, `refused: ${reason}`))
    return undefined
  }

  /** Refuse mailbox mail whose id changes when recorded: a record, a warning, and a failed lease under the raw id. */
  private refuseUnrecordable(path: MailAdmissionPath, rawId: string): void {
    const detail = 'the mailbox message id changes when recorded (control characters, a credential shape, or too long), so the idempotency record could not match a redelivery'
    this.rec('claude-code/refused', { reason: 'admission', detail, at: this.deps.now() })
    this.deps.warn(`agent-claude-code-driver: seat "${this.seat}" refused ${path} mail with an unrecordable mailbox id: ${detail}`)
    void this.leaseCall(() => this.deps.lease?.fail(rawId, `refused: ${detail}`))
  }

  /** Run one lease call to completion in the background; a failure is a warning, never an exception. */
  private leaseCall(call: () => void | Promise<void> | undefined): Promise<void> {
    const work = (async () => {
      try {
        await call()
      } catch (error: unknown) {
        this.deps.warn(`agent-claude-code-driver: seat "${this.seat}" mailbox lease call failed: ${errText(error)}`)
      }
    })()
    this.leaseWork.add(work)
    void work.finally(() => this.leaseWork.delete(work))
    return work
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  /**
   * Submit steering. An idle seat starts a turn; a running seat pushes the
   * message into the open prompt stream, which Claude consumes at its next
   * model-call boundary (the remaining time of the tool call in flight).
   * @param message - identified steering content.
   */
  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): boolean {
    const activeWorkAborted = this.phase.kind !== 'idle'
    if (cause.kind === 'disposed') this.disposed = true
    if (options.keepInbox !== true) {
      void this.failQueuedMail('cancelled before delivery')
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') {
      this.phase.abort.abort(cause)
      if (this.phase.kind === 'running') void this.phase.live?.teardown()
    }
    return activeWorkAborted
  }

  /**
   * Run exclusive maintenance work while the agent is idle.
   * @param job - the work; receives a signal that aborts on cancel.
   * @returns the job's result.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = { kind: 'maintenance', abort: new AbortController(), lastTurn: this.phase.lastTurn, wakeRequested: false }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && !this.disposed && this.inbox.hasPending) this.wake()
        done.resolve()
      }
    })()
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
    await Promise.all([...this.leaseWork])
  }

  /**
   * The documented fallback when a push cannot reach a running turn: interrupt
   * the query, then deliver the message in a resumed query. Interrupt and close
   * are wrapped because the result iterator throws after an interrupt.
   * @param message - the message to deliver after the interrupt.
   */
  async interruptAndResume(message: UserMessage): Promise<void> {
    const live = this.phase.kind === 'running' ? this.phase.live : undefined
    if (this.admitMail(message, 'steer') === undefined) return
    this.inbox.splice('next-turn', Infinity, 0, [message])
    if (live?.query === undefined) {
      this.wake()
      return
    }
    live.interrupted = true
    this.rec('claude-code/steer', { kind: 'interrupt-push', reason: 'mail interrupted the running turn', at: this.deps.now() })
    try {
      await live.query.interrupt()
    } catch (error: unknown) {
      this.deps.warn(`agent-claude-code-driver: interrupt failed: ${errText(error)}`)
    }
    await live.teardown()
  }

  /** Start the driver when idle; steer a running turn; latch behind maintenance or an aborted turn. */
  private wake(): void {
    if (this.phase.kind !== 'idle') {
      if (this.phase.kind === 'running' && !this.phase.abort.signal.aborted) {
        this.pumpSteer(this.phase)
      } else {
        this.phase.wakeRequested = true
      }
      return
    }
    if (this.disposed) {
      this.throwError(new Error(`agent "${this.id}": dispatch blocked, agent is disposed`))
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    const running: RunningPhase = { kind: 'running', abort: new AbortController(), turn: this.phase.lastTurn, wakeRequested: false, live: undefined }
    this.setPhase(running)
    this.loopCtx.agents.withInitiator(this, () => this.kick(running)).then(driver.resolve, driver.reject)
  }

  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    this.dispatch.emit('agent/error', { turn, step: 0, error })
    throw error
  }

  private async kick(phase: RunningPhase): Promise<void> {
    try {
      while (await this.turn(phase)) {}
    } catch (error: unknown) {
      this.deps.warn(`agent "${this.id}": turn failed: ${errText(error)}`)
    } finally {
      this.setPhase({ kind: 'idle', lastTurn: phase.turn })
      if (phase.wakeRequested && !this.disposed && this.inbox.hasPending) this.wake()
    }
  }

  /**
   * Claim queued next-step mail and push it into the live prompt stream. Each
   * message is checked against the log, gets its claim record, and is pushed
   * only after that record is durable. A throwaway turn takes no steering.
   */
  private pumpSteer(phase: RunningPhase): void {
    const { live, turn } = phase
    if (live === undefined || live.throwaway || live.stream.closed || this.inbox.nextStep.length === 0) return
    const accepted = this.screenClaimed(this.inbox.claim('next-step', turn), live.mailIds)
    if (accepted.length === 0) return
    // Steering that carries no mailbox mail has no claim record to make durable, so it goes in at once.
    if (!accepted.some(message => mailboxMessageId(message) !== undefined)) {
      this.pushSteered(live, accepted)
      return
    }
    live.inflight += accepted.length
    void this.flushThenPush(live, accepted)
  }

  /** Log and push steered messages into the live prompt stream. */
  private pushSteered(live: LiveTurn, accepted: readonly UserMessage[]): void {
    for (const message of accepted) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
      this.pushMessage(live, message)
      this.rec('claude-code/steer', { kind: 'push', reason: 'mail pushed into the live turn', at: this.deps.now() })
    }
  }

  /** Make the claim records durable, then push the steered messages (or fail their leases). */
  private async flushThenPush(live: LiveTurn, accepted: readonly UserMessage[]): Promise<void> {
    const ids = accepted.flatMap(message => mailboxMessageId(message) ?? [])
    try {
      await this.flushClaims()
    } catch (error: unknown) {
      live.inflight -= accepted.length
      await Promise.all(ids.map(id => this.finishMail(id, 'failed', errText(error))))
      this.maybeEndStream(live)
      return
    }
    live.inflight -= accepted.length
    if (live.stream.closed) {
      await Promise.all(ids.map(id => this.finishMail(id, 'failed', 'turn ended before the steered mail was delivered')))
      return
    }
    this.pushSteered(live, accepted)
  }

  /** End the prompt stream when every pushed message was answered and nothing more is on its way. */
  private maybeEndStream(live: LiveTurn): void {
    if (live.result !== undefined && live.unanswered.size === 0 && live.inflight === 0 && !this.steeringWaiting(live)) live.stream.end()
  }

  /** Steering is queued for this turn; a throwaway turn takes none, so queued steering never holds its stream open. */
  private steeringWaiting(live: LiveTurn): boolean {
    return !live.throwaway && this.inbox.nextStep.length > 0
  }

  private pushMessage(live: LiveTurn, message: UserMessage): void {
    const uuid = randomUUID()
    live.unanswered.add(uuid)
    live.stream.push({
      type: 'user',
      message: { role: 'user', content: messageText(message) },
      parent_tool_use_id: null,
      uuid,
    })
  }

  /**
   * Decide how this turn's query binds to its Claude session, recording the
   * binding BEFORE any prompt is sent. A bound session whose transcript is
   * gone after a completed turn is refused loudly, never started fresh.
   */
  private async resolveBinding(): Promise<QueryBinding> {
    const bound = this.session.events.findLast(event => event.type === 'claude-code/session-bound')
    this.sdkSessionId ??= (bound?.data as { sdkSessionId?: string } | undefined)?.sdkSessionId
    if (this.sdkSessionId !== undefined && !SDK_SESSION_ID.test(this.sdkSessionId)) {
      const bad = sanitizeFreeText(this.sdkSessionId, 80)
      this.sdkSessionId = undefined
      throw new ClaudeCodeDriverError(
        CLAUDE_CODE_TURN_ERROR_CODES.binding,
        `agent-claude-code-driver: seat "${this.seat}": the logged claude-code/session-bound id "${bad}" is not a session UUID; the log is damaged, re-seed the seat from a digest of it`,
      )
    }
    if (this.sdkSessionId === undefined) {
      const sdkSessionId = randomUUID()
      const written = this.rec('claude-code/session-bound', {
        sessionId: this.id, sdkSessionId, model: this.config.model, driver: CLAUDE_CODE_DRIVER_NAME, at: this.deps.now(),
      })
      if (!written) throw new Error(`agent "${this.id}": could not record claude-code/session-bound; refusing to send a prompt without a durable binding`)
      this.sdkSessionId = sdkSessionId
      this.bindingPending = true
      await this.ensureBindingDurable()
      return { kind: 'first', sdkSessionId }
    }
    await this.ensureBindingDurable()
    const sdkSessionId = this.sdkSessionId
    if (this.transcriptKnown) return { kind: 'resume', sdkSessionId }
    const state = await this.deps.transcriptState(sdkSessionId, this.cwd)
    if (state === 'ok') {
      this.transcriptKnown = true
      return { kind: 'resume', sdkSessionId }
    }
    const completedBefore = this.session.events.some(
      event => event.type === 'claude-code/turn-completed' && (event.data as { throwaway?: unknown }).throwaway !== true,
    )
    if (state === 'missing' && !completedBefore) return { kind: 'first', sdkSessionId }
    this.rec('claude-code/resume-failed', {
      sdkSessionId, reason: state === 'missing' ? 'transcript-missing' : 'transcript-unreadable', at: this.deps.now(),
    })
    throw new ClaudeCodeDriverError(
      CLAUDE_CODE_TURN_ERROR_CODES.resumeFailed,
      `agent-claude-code-driver: seat "${this.seat}" cannot resume Claude session ${sdkSessionId}: transcript is ${state}. `
      + 'The seat needs a re-seed (start a new session whose first prompt is a digest of the old log); it will not start fresh silently.',
    )
  }

  /**
   * Flush the session so a binding appended in memory reaches durable storage
   * before any prompt is sent; a failed flush refuses the prompt and is retried next turn.
   */
  private async ensureBindingDurable(): Promise<void> {
    if (!this.bindingPending) return
    try {
      await this.deps.flush(this.session)
    } catch (error: unknown) {
      throw new ClaudeCodeDriverError(
        CLAUDE_CODE_TURN_ERROR_CODES.binding,
        `agent-claude-code-driver: seat "${this.seat}": could not make claude-code/session-bound durable (${errText(error)}); refusing to send a prompt that a crash could orphan`,
      )
    }
    this.bindingPending = false
  }

  private makeSpawn(live: LiveTurn): (options: SpawnOptions) => ManagedClaudeCodeProcess {
    return (spawnOptions) => {
      const child = this.deps.spawnProcess(claudeSpawnSpec(spawnOptions, this.deps.graceMs))
      live.child = child
      if (child.pid > 0) {
        try {
          this.deps.ledger?.record(this.seat, child.pid)
        } catch (error: unknown) {
          this.deps.warn(`agent-claude-code-driver: could not record child pid in the ledger: ${errText(error)}`)
        }
      }
      void child.done.then(() => undefined, () => undefined).then(() => {
        live.childExited = true
        if (child.pid <= 0) return
        try {
          this.deps.ledger?.clear(this.seat, child.pid)
        } catch (error: unknown) {
          this.deps.warn(`agent-claude-code-driver: could not clear child pid in the ledger: ${errText(error)}`)
        }
      })
      return new ManagedClaudeCodeProcess(child)
    }
  }

  /** Note a subscription-window refusal: record it, remember the pause, and stop the turn. */
  private notePause(live: LiveTurn, signal: PauseSignal): void {
    if (live.pause !== undefined) return
    live.pause = signal
    const until = untilOf(this.deps, signal.until)
    this.pausedUntil = until
    this.rec('claude-code/paused', { reason: signal.reason, until, at: this.deps.now() })
    live.abort.abort({ kind: 'hook', reason: 'claude-code paused' })
    void live.teardown()
  }

  /** Inspect one SDK message for turn-level facts. */
  private observe(phase: RunningPhase, live: LiveTurn, message: SDKMessage): void {
    if (this.killSwitchUp()) this.tripKillSwitch(live)
    if (message.type === 'system' && message.subtype === 'init') {
      live.initSeen = true
      this.checkInitTools(live, message.tools)
    } else if ((message.type === 'assistant' || message.type === 'result') && this.requireInit(live, message.type)) {
      return
    }
    live.mapper?.map(message)
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info
      // A rejection is a refusal only when it is unambiguous. SDK 0.3.263 reports
      // `isUsingOverage` (the request is being served on overage credit) and
      // `overageStatus` (allowed | allowed_warning | rejected) next to the window
      // that was rejected: a rejected five_hour/seven_day window with overage still
      // allowed (or in use) lets the CLI carry on, so it is not a pause. A rejected
      // `overage` window itself is a pause whatever `isUsingOverage` says, and so is
      // a rejection with no overage allowance.
      if (info.status !== 'rejected') return
      const servedOnOverage = info.isUsingOverage === true || info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning'
      if (info.rateLimitType !== 'overage' && servedOnOverage) return
      const exhausted = info.rateLimitType === 'overage' || info.errorCode === 'credits_required'
      this.notePause(live, { reason: exhausted ? 'usage-exhausted' : 'rate-limit', until: resetMs(info.resetsAt) })
      return
    }
    if (message.type === 'assistant' && message.error !== undefined) {
      if (message.error === 'rate_limit') {
        this.notePause(live, { reason: isUsageLimitText(assistantText(message)) ? 'usage-exhausted' : 'rate-limit' })
      } else if (message.error === 'billing_error') this.notePause(live, { reason: 'usage-exhausted' })
      return
    }
    if (message.type !== 'result') return
    live.result = message
    if (message.subtype === 'success' && message.is_error && isUsageLimitText(message.result)) {
      this.notePause(live, { reason: 'usage-exhausted' })
      return
    }
    if ('api_error_status' in message && message.api_error_status === 429) {
      this.notePause(live, { reason: 'rate-limit' })
      return
    }
    const answered = (message as { user_message_uuids?: readonly string[] }).user_message_uuids
    const matched = answered?.filter(uuid => live.unanswered.delete(uuid)).length ?? 0
    // A result that names none of our messages (older CLI, error result) answers everything pushed so far.
    if (matched === 0) live.unanswered.clear()
    if (live.unanswered.size === 0 && !this.steeringWaiting(live) && live.inflight === 0) live.stream.end()
    else this.pumpSteer(phase)
  }

  /** Abort the query when its init message reports a tool set other than the expected one. */
  private checkInitTools(live: LiveTurn, reported: unknown): void {
    if (live.expectedTools === undefined || live.toolMismatch !== undefined) return
    const mismatch = toolSetMismatch(live.expectedTools, reported)
    if (mismatch !== undefined) this.failToolSet(live, mismatch)
  }

  /**
   * Fail closed when a message that can start or end a tool call arrives before any `system/init`: the tool list
   * was never checked, so nothing the query does is trusted.
   * @returns true when the query was just aborted for it.
   */
  private requireInit(live: LiveTurn, kind: string): boolean {
    if (live.expectedTools === undefined || live.initSeen || live.toolMismatch !== undefined) return false
    this.failToolSet(live, `no system/init before first ${kind} message`)
    return true
  }

  /** Record a tool-set refusal, then abort and tear the query down. */
  private failToolSet(live: LiveTurn, mismatch: string): void {
    live.toolMismatch = mismatch
    this.rec('claude-code/refused', { reason: 'admission', detail: `tool set mismatch: ${mismatch}`, at: this.deps.now() })
    this.deps.warn(`agent-claude-code-driver: seat "${this.seat}": ${mismatch}; the query was aborted`)
    live.abort.abort({ kind: 'hook', reason: 'claude-code tool set mismatch' })
    void live.teardown()
  }

  /** Whether the kill-switch flag is up; an injected check that throws counts as up (fail closed). */
  private killSwitchUp(): boolean {
    try {
      return this.deps.killSwitchActive?.() === true
    } catch {
      return true
    }
  }

  /** The kill-switch file appeared mid-turn: record it, abort the running query. */
  private tripKillSwitch(live: LiveTurn): void {
    if (live.killed) return
    live.killed = true
    this.rec('claude-code/refused', { reason: 'kill-switch', detail: 'kill-switch flag file present; running query aborted', at: this.deps.now() })
    live.abort.abort({ kind: 'hook', reason: 'claude-code kill switch' })
    void live.teardown()
  }

  /** Refuse a turn while the kill-switch file is present. */
  private assertKillSwitchOff(): void {
    if (!this.killSwitchUp()) return
    this.rec('claude-code/refused', { reason: 'kill-switch', detail: 'kill-switch flag file present; turn refused', at: this.deps.now() })
    throw new ClaudeCodeDriverError(
      CLAUDE_CODE_TURN_ERROR_CODES.killSwitch,
      `agent-claude-code-driver: seat "${this.seat}" refused a turn: the kill-switch flag file is present; remove it to resume (its mail stays queued).`,
    )
  }

  /** Refuse a turn when the seat has used its calls for the window. */
  private assertWithinCallWindow(): void {
    const { maxCallsPerWindow, callWindowMs } = this.config
    const used = this.gate.callsInWindow(this.seat, this.deps.now(), callWindowMs)
    if (used < maxCallsPerWindow) return
    this.rec('claude-code/refused', {
      reason: 'call-window', detail: `${used} of ${maxCallsPerWindow} calls used in the current ${callWindowMs} ms window`, at: this.deps.now(),
    })
    throw new ClaudeCodeDriverError(
      CLAUDE_CODE_TURN_ERROR_CODES.callWindow,
      `agent-claude-code-driver: seat "${this.seat}" used ${used} of its ${maxCallsPerWindow} calls for this window; its mail stays queued until the window moves on.`,
    )
  }

  /** Claude reported its session id; rebind only if it differs from what the log says (never for a throwaway). */
  private noteSessionInit(live: LiveTurn, init: { readonly sdkSessionId: string; readonly model: string }): void {
    if (live.throwaway || init.sdkSessionId === this.sdkSessionId || !SDK_SESSION_ID.test(init.sdkSessionId)) return
    this.sdkSessionId = init.sdkSessionId
    this.bindingPending = true
    this.rec('claude-code/session-bound', {
      sessionId: this.id,
      sdkSessionId: init.sdkSessionId,
      model: init.model || this.config.model,
      driver: CLAUDE_CODE_DRIVER_NAME,
      at: this.deps.now(),
    })
  }

  /** Append one assistant text to the dsh log; never throws into the stream loop. */
  private appendAssistant(turn: number, text: string): void {
    try {
      this.session.append('assistant/message', {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text }],
          source: { provider: CLAUDE_CODE_DRIVER_NAME, model: this.config.model },
        }),
      }, { surfaceOp: 'append' })
    } catch (error: unknown) {
      this.deps.warn(`agent-claude-code-driver: could not log an assistant message: ${errText(error)}`)
    }
  }

  /**
   * Check claimed mail against the log before anything is sent. Mail already
   * settled is settled again and skipped; mail claimed earlier without an
   * outcome (a crash, or a copy still running) is never run twice; new mail
   * gets its `claude-code/mail-claimed` record. Non-mailbox messages pass.
   * @returns the messages to send.
   */
  private screenClaimed(claimed: readonly UserMessage[], mailIds: string[]): UserMessage[] {
    const run: UserMessage[] = []
    for (const message of claimed) {
      // A message queued before the admission rule existed can come back from the log: it must not run unrecorded.
      const unrecordable = unrecordableMailboxId(message)
      if (unrecordable !== undefined) {
        this.refuseUnrecordable('send', unrecordable)
        continue
      }
      const id = mailboxMessageId(message)
      if (id === undefined) {
        run.push(message)
        continue
      }
      const state = this.mail.get(id)
      if (state === 'settled') {
        void this.leaseCall(() => this.deps.lease?.settle(id))
      } else if (state !== undefined) {
        this.refuseDuplicate(id, state)
      } else if (this.rec('claude-code/mail-claimed', { messageId: id, tainted: isTaintedMail(message), at: this.deps.now() })) {
        this.mail.set(id, 'claimed')
        this.mailInFlight.add(id)
        mailIds.push(id)
        run.push(message)
      } else {
        void this.leaseCall(() => this.deps.lease?.fail(id, 'the claim record could not be written; the mail was not run'))
      }
    }
    return run
  }

  /** A redelivered message that must not run again: record it, and fail the lease unless its first copy is still running. */
  private refuseDuplicate(id: string, state: MailState): void {
    const running = this.mailInFlight.has(id)
    const detail = running ? 'redelivered while its first copy is still running; dropped' : `redelivered after it was already ${state}; not run again`
    this.rec('claude-code/refused', { reason: 'duplicate-in-flight', messageId: id, detail, at: this.deps.now() })
    this.deps.warn(`agent-claude-code-driver: seat "${this.seat}" dropped mailbox message ${id}: ${detail}`)
    if (!running) void this.leaseCall(() => this.deps.lease?.fail(id, detail))
  }

  /** Flush the session so claim records reach durable storage before any prompt is sent. */
  private async flushClaims(): Promise<void> {
    try {
      await this.deps.flush(this.session)
    } catch (error: unknown) {
      throw new ClaudeCodeDriverError(
        CLAUDE_CODE_TURN_ERROR_CODES.binding,
        `agent-claude-code-driver: seat "${this.seat}": could not make the mail claim records durable (${errText(error)}); refusing to send a prompt a crash could replay`,
      )
    }
    this.bindingPending = false
  }

  /** Write the outcome of one claimed (or cancelled-before-claim) mailbox message and settle or fail its lease. */
  private async finishMail(id: string, outcome: 'settled' | 'failed' | 'paused', reason: string): Promise<void> {
    const state = this.mail.get(id)
    if (state === 'settled' || state === 'failed' || state === 'paused') return
    this.mail.set(id, outcome)
    this.mailInFlight.delete(id)
    this.rec('claude-code/mail-outcome', { messageId: id, outcome, reason, at: this.deps.now() })
    const text = sanitizeFreeText(reason, MAX_ERROR_TEXT_CHARS)
    await this.leaseCall(() => (outcome === 'settled' ? this.deps.lease?.settle(id) : this.deps.lease?.fail(id, text)))
  }

  /**
   * Fail the lease of every queued mailbox message and take it off the queue: the turn cannot be started
   * for a reason that outlives this session (it needs a re-seed), or the agent was cancelled. Typed
   * input is left alone.
   */
  private async failQueuedMail(why: string, remove = false, only?: (message: UserMessage) => boolean): Promise<void> {
    const work: Promise<void>[] = []
    for (const message of [...this.inbox.nextStep, ...this.inbox.nextTurn]) {
      const id = mailboxMessageId(message)
      if (id === undefined || (only !== undefined && !only(message))) continue
      if (remove) this.inbox.remove(message.id)
      work.push(this.finishMail(id, 'failed', why))
    }
    await Promise.all(work)
  }

  /** Settle or fail every mailbox message the turn owned, from how the turn ended. */
  private async finishTurnMail(ids: readonly string[], live: LiveTurn | undefined, reason: TurnEndReason): Promise<void> {
    if (ids.length === 0) return
    let outcome: 'settled' | 'failed' | 'paused' = 'failed'
    let why = 'the turn was cancelled or interrupted before an answer'
    if (reason.kind === 'completed') {
      outcome = 'settled'
      why = ''
    } else if (live?.pause !== undefined) {
      outcome = 'paused'
      why = `the Claude subscription window refused work (${live.pause.reason}); seat paused until ${new Date(this.pausedUntil).toISOString()}`
    } else if (reason.kind === 'error') {
      why = reason.error.message
    }
    await Promise.all(ids.map(id => this.finishMail(id, outcome, why)))
  }

  /**
   * Decide which queued mail the next turn takes and whether it is tainted.
   * Tainted mail runs alone in a throwaway session, so a tainted head of the
   * turn queue waits behind pending steering, and a tainted batch (never
   * expected, since tainted mail is never queued as steering) is run as a whole.
   */
  private planClaim(): { target: InboxTarget; tainted: boolean } {
    const head = this.inbox.nextTurn[0]
    const headTainted = head !== undefined && isTaintedMail(head)
    if (this.inbox.nextStep.some(isTaintedMail)) return { target: 'next-turn', tainted: true }
    if (this.inbox.nextStep.length > 0) return { target: headTainted ? 'next-step' : 'next-turn', tainted: false }
    return { target: 'next-turn', tainted: headTainted }
  }

  /** Map the final result to the durable turn-completed record. */
  private recordResult(turn: number, result: SDKResultMessage, throwaway: boolean): void {
    const usage = result.usage
    this.rec('claude-code/turn-completed', {
      ...throwaway ? { throwaway: true } : {},
      turnIndex: turn,
      outcome: result.subtype,
      isError: result.is_error,
      model: this.config.model,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
      durationApiMs: result.duration_api_ms,
      estimatedCostUsd: result.total_cost_usd,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      },
      modelUsage: Object.fromEntries(Object.entries(result.modelUsage).map(([model, entry]) => [model, {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadInputTokens: entry.cacheReadInputTokens,
        cacheCreationInputTokens: entry.cacheCreationInputTokens,
        estimatedCostUsd: entry.costUSD,
        webSearchRequests: entry.webSearchRequests,
      }])),
      stopReason: result.stop_reason,
    })
  }

  /** The turn-end reason for everything that happened to this turn. */
  private endReason(signal: AbortSignal, live: LiveTurn | undefined, failure: unknown): TurnEndReason {
    if (live?.pause !== undefined) {
      const until = new Date(this.pausedUntil).toISOString()
      return {
        kind: 'error',
        error: {
          code: CLAUDE_CODE_TURN_ERROR_CODES.paused,
          message: `Claude subscription window refused work (${live.pause.reason}); seat paused until ${until}. The lease fails with a refusal notice; retry after that time.`,
        },
      }
    }
    if (live?.killed === true) {
      return {
        kind: 'error',
        error: { code: CLAUDE_CODE_TURN_ERROR_CODES.killSwitch, message: 'The kill-switch flag file appeared; the running query was aborted. Remove the file to resume.' },
      }
    }
    if (live?.toolMismatch !== undefined) {
      return {
        kind: 'error',
        error: {
          code: CLAUDE_CODE_TURN_ERROR_CODES.toolSet,
          message: `Claude Code reported a tool set the policy did not expect (${live.toolMismatch}); the query was aborted. Check the policy's tools against the live CLI.`,
        },
      }
    }
    if (live?.interrupted === true) {
      return { kind: 'aborted', reason: { kind: 'hook', reason: 'claude-code steer interrupt' } }
    }
    if (signal.aborted) return { kind: 'aborted', reason: signal.reason as AgentCancelCause }
    if (failure !== undefined) {
      return {
        kind: 'error',
        error: {
          code: failure instanceof ClaudeCodeDriverError ? failure.code : 'UNKNOWN',
          message: errText(failure),
        },
      }
    }
    if (live?.noQuery === true) return { kind: 'completed' }
    const result = live?.result
    if (result === undefined) {
      return { kind: 'error', error: { code: CLAUDE_CODE_TURN_ERROR_CODES.noResult, message: 'Claude Code ended without a result message' } }
    }
    if (result.is_error || result.subtype !== 'success') {
      const detail = result.subtype === 'success' ? 'success result marked as an error' : sanitizeFreeText(result.errors.join('; '), MAX_ERROR_TEXT_CHARS) || result.subtype
      return { kind: 'error', error: { code: `CLAUDE_CODE_${result.subtype.toUpperCase()}`, message: `Claude Code failed: ${detail}` } }
    }
    return { kind: 'completed' }
  }

  /** Run one turn; resolves true when queued work remains and the driver should run another. */
  private async turn(phase: RunningPhase): Promise<boolean> {
    const signal = phase.abort.signal

    const turn = phase.turn + 1
    this.session.append('turn/start', { turn })
    phase.turn = turn
    let live: LiveTurn | undefined
    let failure: unknown
    let stepOpen = false
    let holdsGate = false
    let binding: QueryBinding | undefined
    let executable: string | undefined
    let reason: TurnEndReason | undefined
    let unmarkedTainted = false
    const mailIds: string[] = []
    try {
      // Preflight before anything is claimed, so a refusal leaves the mail queued.
      assertCleanHostEnv(this.deps.hostEnv())
      executable = this.deps.attestedBinary?.(this.seat)
      this.assertKillSwitchOff()
      if (this.pausedUntilMs > 0) {
        this.notePauseRefusal()
      }
      this.assertWithinCallWindow()
      this.gate.acquire(this.seat, this)
      holdsGate = true
      const plan = this.planClaim()
      // A lead or coder turn, throwaway or not, needs the policy service as registered right now.
      this.requirePolicy()
      // Mark the turn before any of its messages are logged, so no re-seed digest can carry its untrusted text.
      if (plan.tainted && !this.rec('claude-code/throwaway-turn', { turnIndex: turn, at: this.deps.now() })) {
        unmarkedTainted = true
        throw new ClaudeCodeDriverError(
          CLAUDE_CODE_TURN_ERROR_CODES.tainted,
          `agent-claude-code-driver: seat "${this.seat}": could not record claude-code/throwaway-turn; refusing to run tainted mail unmarked`,
        )
      }
      // Tainted mail never touches the seat's Claude session: a fresh id, nothing bound, nothing resumed.
      binding = plan.tainted ? { kind: 'first', sdkSessionId: randomUUID() } : await this.resolveBinding()
      signal.throwIfAborted()
      // The binding await can outlast a policy change: look again before anything is claimed (a refusal keeps the mail queued).
      this.requirePolicy()

      const claimed = this.inbox.claim(plan.target, turn)
      const run = this.screenClaimed(claimed, mailIds)
      this.session.append('step/start', { turn, step: 1 })
      stepOpen = true
      for (const message of run) this.session.append('user/message', message, { surfaceOp: 'append' })
      // The claim records must be durable before the prompt is sent, like the binding.
      if (mailIds.length > 0) await this.flushClaims()

      live = new LiveTurn(turn, phase.abort, this.deps, plan.tainted, mailIds)
      phase.live = live
      if (run.length === 0) {
        live.noQuery = true
      } else {
        const active = live
        // The claim flush above can outlast a policy change too: the query uses the object read here, not an earlier one.
        const policy = this.requirePolicy()
        active.mapper = new StreamMapper({
          record: (type, data) => { this.rec(type, data) },
          assistantText: (text) => { this.appendAssistant(turn, text) },
          sessionInit: (init) => { this.noteSessionInit(active, init) },
          toolStarted: (name) => {
            if (!TAINTING_TOOLS.has(name)) return
            active.tainted = true
            if (!active.throwaway) this.markTurnTainted(`tool:${name}`)
          },
        }, this.deps.now, this.digestKey)
        const options = buildQueryOptions({
          seat: this.seat,
          config: this.config,
          cwd: this.cwd,
          binding,
          env: this.deps.childEnv(),
          abortController: phase.abort,
          spawn: this.makeSpawn(live),
          extension: plan.tainted || policy === undefined ? undefined : context => this.extendPolicy(policy, context),
          controls: {
            isTurnTainted: () => this.isTurnTainted(),
            markTurnTainted: (why) => { this.markTurnTainted(why) },
            deliveredTraceIds: () => this.deliveredTraceIds(),
          },
          executable,
          throwaway: plan.tainted,
          warn: this.deps.warn,
        })
        active.expectedTools = expectedInitTools(options)
        const violation = plan.tainted ? throwawayViolation(options, this.config.fableOk) : undefined
        if (violation !== undefined) {
          throw new ClaudeCodeDriverError(
            CLAUDE_CODE_TURN_ERROR_CODES.tainted,
            `agent-claude-code-driver: seat "${this.seat}": tainted mail must run with ${violation}; refusing to start the query`,
          )
        }
        // The awaits above (binding, flush) can outlast a switch set meanwhile: look once more right before the query.
        this.assertKillSwitchOff()
        for (const message of run) this.pushMessage(live, message)
        this.gate.noteCall(this.seat, this.deps.now())
        live.query = this.deps.query({ prompt: live.stream, options })
        this.pumpSteer(phase)
        // A flag file set while the query is busy inside one long tool call produces no stream message to notice it on.
        const poll = setInterval(() => {
          if (this.killSwitchUp()) this.tripKillSwitch(active)
        }, this.deps.killSwitchPollMs ?? KILL_SWITCH_POLL_MS)
        poll.unref()
        try {
          for await (const message of live.query) this.observe(phase, live, message)
        } catch (error: unknown) {
          // An interrupt, a cancel, or a pause makes the result iterator throw; that is the expected end.
          if (!signal.aborted && !live.interrupted) throw error
        } finally {
          clearInterval(poll)
        }
        if (live.result !== undefined && !live.result.is_error && !plan.tainted) this.transcriptKnown = true
      }
    } catch (error: unknown) {
      failure = error
    } finally {
      await live?.teardown()
      if (holdsGate) this.gate.release(this.seat, this)
      phase.live = undefined
      if (live?.result !== undefined && live.pause === undefined) this.recordResult(turn, live.result, live.throwaway)
      if (stepOpen) this.session.append('step/end', { turn, step: 1 })
      reason = this.endReason(signal, live, failure)
      this.session.append('turn/end', { turn, reason })
      await this.finishTurnMail(mailIds, live, reason)
      if (failure instanceof ClaudeCodeDriverError && failure.code === CLAUDE_CODE_TURN_ERROR_CODES.resumeFailed) {
        await this.failQueuedMail(`${failure.message} The queued mail was not delivered.`, true)
      } else if (unmarkedTainted) {
        // Nothing was claimed; the tainted mail cannot run without its marker, so its lease fails now.
        await this.failQueuedMail(`${errText(failure)} The tainted mail was not delivered.`, true, isTaintedMail)
      }
    }
    if (failure !== undefined && !signal.aborted) {
      this.dispatch.emit('agent/error', { turn, step: 1, error: failure })
    }
    // A failed turn, a cancel, a pause, or a refused resume must not spin on the still-queued mail;
    // only a clean turn, or one deliberately interrupted to deliver mail, runs again.
    const proceed = (reason.kind === 'completed' || live?.interrupted === true) && !signal.aborted
    if (!proceed || !this.hasMail() || this.pausedUntilMs > 0) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    return true
  }

  /**
   * The policy service for a lead or coder turn, after checking that it can serve the role right now. A failure is a
   * loud refusal (record, warning through the turn error) and leaves the mail queued, like a kill switch.
   */
  private requirePolicy(): ClaudeCodePolicy | undefined {
    if (this.config.role === 'mail-only') return undefined
    const policy = this.deps.policy?.()
    try {
      assertRoleServable(this.config.role, this.seat, policy)
    } catch (error: unknown) {
      this.rec('claude-code/refused', { reason: 'admission', detail: errText(error), at: this.deps.now() })
      throw new ClaudeCodeDriverError(CLAUDE_CODE_TURN_ERROR_CODES.policy, errText(error))
    }
    return policy
  }

  /** Ask the policy for its contribution; a seat it leaves with no tools is muted, loudly, instead of started. */
  private extendPolicy(policy: ClaudeCodePolicy, context: PolicyQueryContext): PolicyExtension {
    try {
      return policy.extend(context)
    } catch (error: unknown) {
      if (!(error instanceof SeatMutedByPolicyError)) throw error
      this.rec('claude-code/refused', { reason: 'admission', detail: `seat muted by policy: ${error.reason}`, at: this.deps.now() })
      throw new ClaudeCodeDriverError(CLAUDE_CODE_TURN_ERROR_CODES.muted, `agent-claude-code-driver: seat "${this.seat}" is muted by policy: ${errText(error.reason)}`)
    }
  }

  /** Whether mail is queued; a method so flow narrowing from earlier checks does not go stale across awaits. */
  private hasMail(): boolean {
    return this.inbox.hasPending
  }

  /** Refuse a turn while the seat is paused, naming the end time. */
  private notePauseRefusal(): never {
    throw new ClaudeCodeDriverError(
      CLAUDE_CODE_TURN_ERROR_CODES.paused,
      `agent-claude-code-driver: seat "${this.seat}" is paused until ${new Date(this.pausedUntil).toISOString()} after a subscription-window refusal; its mail stays queued.`,
    )
  }
}
