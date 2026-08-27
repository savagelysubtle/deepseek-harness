/** Package-owned durable context-pressure warning invariants. @module @deepseek-ai/dsh-context-pressure/invariant */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the plugin-merged `compaction/end` session event scanned below.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: resolves the tokenMeter service declaration read through `ctx`.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { formatPercent } from './config.ts'
import { PLUGIN_SOURCE_NAME, parseWarningText } from './warning.ts'
import type { ParsedWarning } from './warning.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-pressure'

/** Cordis companion plugin name. */
export const name = 'context-pressure-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** One durable plugin-attributed warning with its parsed facts. */
interface DurableWarning {
  readonly seq: number
  readonly parsed: ParsedWarning
}

/** Narrow a session event to a message attributed to this plugin. */
function isPluginWarning(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === PLUGIN_SOURCE_NAME
}

/** Validate that one warning was appended inside an entering step, before its request header. */
function validatePosition(history: readonly SessionEvent[], fail: InvariantFailure): void {
  let openTurn = false
  let openStep = false
  let requestStarted = false
  for (const event of history) {
    switch (event.type) {
      case 'turn/start':
        openTurn = true
        openStep = false
        requestStarted = false
        break
      case 'step/start':
        openStep = true
        requestStarted = false
        break
      case 'request/header':
        requestStarted = true
        break
      case 'step/end':
        openStep = false
        requestStarted = false
        break
      case 'turn/end':
        openTurn = false
        openStep = false
        requestStarted = false
        break
      default:
        // Merge-extensible session events: non-boundary records change nothing.
        break
    }
  }
  if (!openTurn) fail('context-pressure warning must be appended inside an open turn')
  if (!openStep) fail('context-pressure warning must follow step/start')
  if (requestStarted) fail('context-pressure warning must precede request/header')
}

/** Validate one warning's message body, source shape, and recorded facts. */
function validateWarning(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const block = event.data.content[0]
  if (event.data.content.length !== 1 || block?.type !== 'text') {
    fail('context-pressure warnings must contain exactly one text block')
  }
  const text = block.text
  const parsed = parseWarningText(text)
  if (parsed === undefined) fail('context-pressure warning does not match the durable warning format')
  validatePosition(history, fail)
  const source = event.data.source
  /* v8 ignore next 2 -- replay and dispatch callers select this exact package-owned source before validation. */
  if (source.kind !== 'plugin' || source.plugin !== PLUGIN_SOURCE_NAME) {
    fail('context-pressure source must retain package ownership')
  }
  const sections: unknown = 'sections' in source ? source.sections : undefined
  const sectionValue: unknown = Array.isArray(sections) ? sections[0] : undefined
  const section = typeof sectionValue === 'object' && sectionValue !== null
    ? sectionValue as Record<string, unknown>
    : undefined
  if (Object.keys(source).length !== 4
    || source.form !== 'snapshot'
    || !Array.isArray(sections)
    || sections.length !== 1
    || section === undefined
    || Object.keys(section).length !== 2
    || section.name !== PLUGIN_SOURCE_NAME
    || section.text !== text) {
    fail('context-pressure source must carry only the exact snapshot text, not request authority')
  }
  if (parsed.remainingTokens !== Math.max(0, parsed.contextWindow - parsed.totalTokens)) {
    fail('context-pressure remaining tokens disagree with its recorded usage and window')
  }
  if (formatPercent(Number(parsed.thresholdPercent) / 100) !== parsed.thresholdPercent) {
    fail(`context-pressure threshold percent ${parsed.thresholdPercent} is not canonical`)
  }
  if (formatPercent(parsed.totalTokens / parsed.contextWindow) !== parsed.usedPercent) {
    fail(`context-pressure used percent ${parsed.usedPercent} disagrees with its recorded usage and window`)
  }
}

/** Collect every durable plugin-attributed warning in log order. */
function collectWarnings(events: readonly SessionEvent[]): DurableWarning[] {
  const warnings: DurableWarning[] = []
  for (const event of events) {
    if (!isPluginWarning(event)) continue
    const block = event.data.content[0]
    if (block?.type !== 'text') {
      continue
    }
    const parsed = parseWarningText(block.text)
    // Unparseable text under this package's name is foreign content; the
    // per-warning format check reports it only where that event validates.
    if (parsed === undefined) continue
    warnings.push({ seq: event.seq, parsed })
  }
  return warnings
}

/**
 * Validate every warning pair of one generation: thresholds strictly ascend,
 * and in the final generation — whose pressure the current tail still prices —
 * measured usage never fell below an earlier same-generation warning's total.
 * A newer warning existing at all proves an intervening request raised the
 * measured total past its own crossed threshold.
 */
function validateGenerations(session: Session, meter: TokenMeter, fail: InvariantFailure): void {
  const warnings = collectWarnings(session.events)
  let previous: DurableWarning | undefined
  for (const current of warnings) {
    const prior = previous
    if (prior !== undefined) {
      const generationClosed = session.events.some(event =>
        event.type === 'compaction/end' && event.seq > prior.seq && event.seq < current.seq)
      if (!generationClosed) {
        if (Number(current.parsed.thresholdPercent) <= Number(prior.parsed.thresholdPercent)) {
          fail(
            'context-pressure thresholds must ascend within one compaction generation: '
            + `${prior.parsed.thresholdPercent}% is followed by ${current.parsed.thresholdPercent}%`,
          )
        }
        // Only the final generation is still priced at the current tail; earlier
        // pairs are validated against their own recorded totals alone.
        const superseded = session.events.some(event =>
          event.type === 'compaction/end' && event.seq > current.seq)
        if (!superseded) {
          const currentTotal = meter.measure(session).totalTokens
          if (currentTotal < prior.parsed.totalTokens) {
            fail(
              `context-pressure measured total ${currentTotal} fell below earlier same-generation `
              + `warning total ${prior.parsed.totalTokens} without an intervening compaction`,
            )
          }
        }
      }
    }
    previous = current
  }
}

/** Validate all package-owned warnings already present in one session. */
function validateSession(session: Session, meter: TokenMeter, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (!isPluginWarning(event)) continue
    validateWarning(session.events.slice(0, index), event, fail)
  }
  validateGenerations(session, meter, fail)
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Install validation for loaded and newly appended context warnings. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const meter = ctx.tokenMeter
  for (const session of ctx.sessions.list()) validateSession(session, meter, fail)
  ctx.on('session/created', (session) => { validateSession(session, meter, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isPluginWarning(event)) return
    validateSession(session, meter, fail)
  }, { global: true })
}, { inject: ['sessions', 'tokenMeter'] })
/* jscpd:ignore-end */

/**
 * Register the context-pressure invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
