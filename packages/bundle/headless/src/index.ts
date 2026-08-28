/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates or resumes one Agent through the core registry, drives the task to
 * quiescence, flushes its Session, prints the final assistant text, and exits.
 *
 * With `sessionName` the durable session id is derived from the name and a
 * per-name lock serializes concurrent runners; a persisted log is resumed,
 * its absence creates the session for the first time.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
// Empty type imports carry the sessionPersistence Context merge for the
// existence probe, the loader Context merge for the settlement await, and the
// cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  acquireNamedSessionLock,
  assertValidSessionName,
  deriveNamedSessionId,
  type NamedSessionLock,
} from '@deepseek-ai/dsh-named-sessions'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionPersistence']

/** Output formats the runner can produce. */
export type OutputFormat = 'text' | 'json'

/** Plugin config: the task plus the optional named-session invocation shape. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
  /**
   * Run against the durable named session derived from this name: first use
   * creates it, later uses resume it. Absent for anonymous one-shot runs.
   */
  sessionName?: string
  /** Output mode; the schema default is `text`. */
  format?: OutputFormat
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  sessionName: z.string(),
  format: z.union(['text', 'json'] as const).default('text'),
})

/** Resolved execution parameters for one runner invocation. */
export type RunSpec =
  | {
    /** Anonymous run on a fresh random session id. */
    readonly kind: 'one-shot'
    /** Whether output streams NDJSON text parts instead of the final summary. */
    readonly json: boolean
  }
  | {
    /** Named run on the durable session id derived from the name. */
    readonly kind: 'named'
    /** Validated user-chosen name. */
    readonly name: string
    /** Durable session id derived from the name. */
    readonly sessionId: SessionId
    /** Whether output streams NDJSON text parts instead of the final summary. */
    readonly json: boolean
  }

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Resolve validated config into execution parameters. This step owns every
 * default: `run` never applies an implicit fallback beyond what the schema
 * already declares.
 * @param config - validated plugin config.
 * @returns the resolved execution parameters.
 * @throws when `config.sessionName` violates the accepted name grammar.
 */
export function resolveRunSpec(config: Config): RunSpec {
  const json = config.format === 'json'
  if (config.sessionName === undefined) {
    return { kind: 'one-shot', json }
  }
  assertValidSessionName(config.sessionName)
  return {
    kind: 'named',
    name: config.sessionName,
    sessionId: deriveNamedSessionId(config.sessionName),
    json,
  }
}

/** Join an assistant message's text blocks into one string. */
function assistantText(event: SessionEvent<'assistant/message'>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = assistantText(event)
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * Subscribe to this run's assistant messages and stream each as one NDJSON
 * line on stdout.
 * @param ctx - plugin context carrying the global session-event firehose.
 * @param sessionId - the driven session whose events stream.
 * @param firstSeq - first event seq belonging to this run's interval.
 * @param io - process-facing effects.
 * @returns the unsubscribe callback, invoked once the run settles.
 */
function streamAssistantText(ctx: Context, sessionId: SessionId, firstSeq: number, io: HeadlessIo): () => void {
  return ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.id !== sessionId || event.seq < firstSeq || event.type !== 'assistant/message') return
    const line = {
      type: 'text',
      sessionID: String(sessionId),
      part: { type: 'text', text: assistantText(event) },
    }
    io.stdout.write(`${JSON.stringify(line)}\n`)
  })
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Emit one run's end-of-run output and exit request. Text mode prints the
 * last non-empty assistant text; JSON mode suppresses that summary because
 * every assistant message already streamed as an NDJSON line. A terminal
 * error reason always writes its code and message to stderr.
 * @param spec - resolved execution parameters.
 * @param events - the flushed session log.
 * @param firstSeq - first event seq belonging to this run's interval.
 * @param io - process-facing effects.
 */
function emitOutcome(spec: RunSpec, events: readonly SessionEvent[], firstSeq: number, io: HeadlessIo): void {
  const outcome = summarize(events, firstSeq)
  if (!spec.json) io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Run one task through a freshly created or resumed Agent and request process
 * exit. A named run takes its per-name lock across the whole body, resumes
 * when a persisted log exists for the derived id (a present-but-unloadable log
 * surfaces the backend load error), and otherwise creates the session.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated task config.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  const spec = resolveRunSpec(config)
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    return
  }

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup: AgentSetup = (agentCtx): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }

  let lock: NamedSessionLock | undefined
  let persisted = false
  try {
    if (spec.kind === 'named') {
      // A named run exists to accumulate durable state across processes;
      // without the persistence backend that state cannot survive, which is
      // misconfiguration rather than a reason to abandon silently.
      if (persistence === undefined) {
        throw new Error('headless-runner: named sessions require a configured session-persistence backend')
      }
      lock = acquireNamedSessionLock(spec.name)
      // Metadata-only existence probe: only a genuinely absent log falls back
      // to first creation; corruption and backend failures stay loud via resume.
      persisted = (await persistence.list()).some(header => header.id === spec.sessionId)
    }
    const sessionId = spec.kind === 'named' ? spec.sessionId : SessionId(`session-${randomUUID()}`)
    const { agent } = persisted
      ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const stopStreaming = spec.json ? streamAssistantText(ctx, agent.session.id, firstSeq, io) : undefined
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: config.task }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await sessions.flush(agent.session)
    } finally {
      stopStreaming?.()
    }
    emitOutcome(spec, agent.session.events, firstSeq, io)
  } finally {
    lock?.release()
  }
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
