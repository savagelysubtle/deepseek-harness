/**
 * Opt-in context-window pressure warnings. Crossing a configured fraction of
 * the routed model's context window appends one durable, deduplicated warning
 * per compaction generation so the model can plan its own compaction.
 *
 * @module @deepseek-ai/dsh-context-pressure
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: loads the plugin-merged `compaction/end` session event folded below.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
// Type-only: resolves the tokenMeter service declaration read through `ctx`.
import type {} from '@deepseek-ai/dsh-token-meter'
import { DEFAULT_THRESHOLDS, resolveSpec, resolveWindowThresholds } from './config.ts'
import type { Config as PressureConfig } from './config.ts'
import { PLUGIN_SOURCE_NAME, parseWarningText, renderWarningText } from './warning.ts'

/** Plugin configuration contract; the validated schema value is {@link Config}. */
export type Config = PressureConfig

/** Cordis plugin name used by loader diagnostics. */
export const name = PLUGIN_SOURCE_NAME

/** Services providing routed-model metadata, replay measurement, and pre-step processing. */
export const inject = ['llm', 'tokenMeter', 'agents']

/**
 * Schemastery validation for {@link PressureConfig}. The array default is
 * declared here because Schemastery otherwise resolves an omitted array to
 * `[]`, which `Config.thresholds` defines as the explicit disable switch; the
 * documented default must stay distinguishable from it.
 */
export const Config: z<PressureConfig> = z.object({
  thresholds: z.array(z.number()).default([...DEFAULT_THRESHOLDS]),
})

/** Warned-threshold bookkeeping for one session, folded from the durable log. */
interface PressureFoldState {
  /** Number of durable events already consumed; the next unread seq. */
  consumedEvents: number
  /** Canonical threshold percents already warned during the current compaction generation. */
  warnedPercents: Set<string>
  /** Seq of the latest durable warning, or -1 before any. */
  latestWarningSeq: number
}

/** Resolve the exact provider/model durably routed by the latest logged request header. */
function routedTarget(session: Session): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined) return undefined
  if (config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** Narrow a session event to a message attributed to this plugin. */
function isPluginWarning(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === PLUGIN_SOURCE_NAME
}

/** First text block of a plugin-attributed message, or empty when it has none. */
function warningText(message: UserMessage): string {
  const blocks = message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => (
    block.type === 'text'
  ))
  return blocks[0]?.text ?? ''
}

/**
 * Fold one session's durable log up to its tail into warned-threshold state.
 * Deriving from the log (instead of caching process-local flags) keeps restarts
 * and resumes from re-warning at already-durable thresholds, and a
 * `compaction/end` newer than the latest warning resets every threshold.
 * @param folds - per-session fold storage owned by the plugin closure.
 * @param session - session whose events are consumed incrementally.
 * @returns the up-to-date fold state for that session.
 */
function foldPressureState(
  folds: WeakMap<Session, PressureFoldState>,
  session: Session,
): PressureFoldState {
  let state = folds.get(session)
  if (state === undefined) {
    state = { consumedEvents: 0, warnedPercents: new Set(), latestWarningSeq: -1 }
    folds.set(session, state)
  }
  while (state.consumedEvents < session.events.length) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
    const event = session.events[state.consumedEvents]!
    state.consumedEvents += 1
    if (isPluginWarning(event)) {
      const parsed = parseWarningText(warningText(event.data))
      // Foreign or malformed text under this plugin name stays uncounted.
      if (parsed !== undefined) {
        state.warnedPercents.add(parsed.thresholdPercent)
        state.latestWarningSeq = event.seq
      }
    } else if (event.type === 'compaction/end' && event.seq > state.latestWarningSeq) {
      state.warnedPercents.clear()
    }
  }
  return state
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`. On each
 * entering step the listener delegates first, then measures post-compaction
 * pressure for the durably routed target and appends at most one warning for
 * the smallest not-yet-warned crossed threshold of the current generation.
 * Unknown or unresolvable model capacity logs one diagnostic per target and
 * never blocks or fails the step.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - pressure thresholds validated through {@link resolveSpec} at load.
 * @throws TypeError when `config.thresholds` violates its contract.
 */
export function apply(ctx: Context, config: PressureConfig): void {
  const spec = resolveSpec(config)
  const folds = new WeakMap<Session, PressureFoldState>()
  const warnedCapacityTargets = new Set<string>()

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const target = routedTarget(agent.session)
    if (target === undefined) return decision
    let contextWindow: number | undefined
    try {
      contextWindow = (await ctx.llm.resolveModelInfo(target.provider, target.model, signal))
        .context?.contextWindow
    } catch {
      // Adapter lookup can reject (for example NO_ADAPTER) before any request
      // exists; the step proceeds and the once-per-target diagnostic below
      // reports the missing capacity.
      contextWindow = undefined
    }
    const targetKey = `${target.provider}/${target.model}`
    if (contextWindow === undefined) {
      if (!warnedCapacityTargets.has(targetKey)) {
        warnedCapacityTargets.add(targetKey)
        ctx.logger.warn(
          `context-pressure: ${targetKey} has no resolvable context window; skipping pressure warnings for it`,
        )
      }
      return decision
    }
    const state = foldPressureState(folds, agent.session)
    const measurement = ctx.tokenMeter.measure(agent.session)
    const crossed = resolveWindowThresholds(spec, contextWindow).find(threshold =>
      !state.warnedPercents.has(threshold.percent) && measurement.totalTokens >= threshold.tokens)
    if (crossed === undefined) return decision
    const text = renderWarningText({
      thresholdRatio: crossed.ratio,
      totalTokens: measurement.totalTokens,
      contextWindow,
    })
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name: PLUGIN_SOURCE_NAME, text }],
          },
        }),
      ],
    }
  }, { prepend: true })
}
