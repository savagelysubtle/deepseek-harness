/**
 * Canonical warning text shared by the injector, the dedup fold, and the
 * invariant companion. The template is stable so appended warnings reuse the
 * request prefix's KV-cache entries and replay can re-derive warned state.
 *
 * @module @deepseek-ai/dsh-context-pressure/warning
 */

import { formatPercent } from './config.ts'

/** Plugin-attributed message source name; also the Cordis plugin name. */
export const PLUGIN_SOURCE_NAME = 'context-pressure'

/** Inputs rendered into one warning. */
export interface WarningFacts {
  /** The crossed threshold's fraction. */
  readonly thresholdRatio: number
  /** Measured total tokens at fire time. */
  readonly totalTokens: number
  /** The routed model's context window. */
  readonly contextWindow: number
}

/** Exact shape of the two-line warning text after parsing. */
export interface ParsedWarning {
  /** Canonical crossed-threshold percent; the dedup key within a generation. */
  readonly thresholdPercent: string
  /** Canonical rendered share of the window in use at fire time. */
  readonly usedPercent: string
  /** Measured total tokens recorded at fire time. */
  readonly totalTokens: number
  /** Context window recorded at fire time. */
  readonly contextWindow: number
  /** Rendered remaining headroom (zero once usage meets or exceeds the window). */
  readonly remainingTokens: number
}

const WARNING_PATTERN = new RegExp(
  '^Context pressure notice: usage passed the (\\d+(?:\\.\\d+)?)% threshold of this model\'s context window: '
  + '(\\d+) of (\\d+) tokens in use \\((\\d+(?:\\.\\d+)?)%\\); (\\d+) tokens remain\\.\n'
  + 'Before rising pressure forces automatic compaction, you can request compaction yourself with the compact tool\\.$',
)

/**
 * Render the exact durable warning text for one crossing.
 * @param input - the crossed threshold, measured total, and model window.
 * @returns the two-line model-facing text embedded in the message body and source section.
 */
export function renderWarningText(input: WarningFacts): string {
  const remainingTokens = Math.max(0, input.contextWindow - input.totalTokens)
  return `Context pressure notice: usage passed the ${formatPercent(input.thresholdRatio)}% threshold `
    + `of this model's context window: ${input.totalTokens} of ${input.contextWindow} tokens in use `
    + `(${formatPercent(input.totalTokens / input.contextWindow)}%); ${remainingTokens} tokens remain.\n`
    + 'Before rising pressure forces automatic compaction, you can request compaction yourself '
    + 'with the compact tool.'
}

/**
 * Parse rendered warning text back into its recorded facts.
 * @param text - candidate warning text from a plugin-attributed message.
 * @returns the parsed facts, or undefined when the text is not this package's exact warning format.
 */
export function parseWarningText(text: string): ParsedWarning | undefined {
  const match = WARNING_PATTERN.exec(text)
  if (match === null) return undefined
  return {
    thresholdPercent: match[1] ?? '',
    totalTokens: Number(match[2] ?? -1),
    contextWindow: Number(match[3] ?? -1),
    usedPercent: match[4] ?? '',
    remainingTokens: Number(match[5] ?? -1),
  }
}
