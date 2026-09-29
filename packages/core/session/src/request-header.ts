/**
 * Request-header reconstruction utilities over full `request/header` session
 * events. Anyone holding a session log reconstructs the {@link EpochHeader}
 * any request was built under by taking the latest canonical snapshot; the
 * loop uses the same equality helper to avoid logging unchanged headers.
 *
 * @module dsh-session/request-header
 */

import { callConfigEquals } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent } from './types.ts'

/**
 * The built-in `harness:now` (SWD-113, `@deepseek-ai/dsh-system-prompt`)
 * section's volatile first line — the weekday/date/time/zone/offset/ISO-instant
 * stamp. Matches per line so it scrubs regardless of surrounding content; the
 * fixed second sentence ("This is the time this prompt was assembled…") is
 * left untouched, since it carries no run-specific value. Same shape as
 * `scrubNowLine` in `packages/test-support/acp-snapshot/src/normalize.ts`
 * (a snapshot-normalization concern, kept separate from this runtime one).
 */
const NOW_LINE_RE = /^Current date and time: .*$/gm

/**
 * Replace the `harness:now` clock line in rendered system-prompt text with a
 * stable placeholder, leaving the rest of the text untouched. Comparison-only:
 * {@link headerEquals} uses this so a header that changed only because the
 * clock advanced does not read as a request-envelope change and trigger a
 * fresh `request/header` log entry. Never applied to a header before it is
 * logged or reconstructed — the persisted and replayed header always carries
 * its own real clock reading (see {@link EpochHeader}'s `system` field).
 * Accepted risk: the underlying regex matches ANY line in the full rendered
 * system text starting with `Current date and time: `, not just the
 * `harness:now` section specifically — a persona or plugin emitting a line
 * with that exact prefix would have its differences ignored too by
 * {@link headerEquals} and the agent-loop reconstructability invariant. Only
 * `@deepseek-ai/dsh-system-prompt` emits this line today.
 * @param system - rendered system-prompt text that may contain the block.
 * @returns `system` with the volatile stamp line replaced by a stable token.
 */
export function scrubNowLine(system: string): string {
  return system.replace(NOW_LINE_RE, 'Current date and time: {{now}}')
}

/**
 * Normalize a header to canonical form: an empty system prompt and empty tool
 * list become absent fields, matching how requests are built. Logging, folding,
 * and comparison use this one representation.
 * @param header - the header to normalize (not mutated).
 * @returns the canonical header.
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.system !== undefined && header.system.length > 0 ? { system: header.system } : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/** Canonical JSON equality for tool schemas assembled through the same path. */
function sameSchema(a: ToolSchema, b: ToolSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * `system` text equality that ignores the `harness:now` clock line alone: two
 * texts differing only in that line's instant compare equal (see
 * {@link scrubNowLine}), so a per-assembly clock advance is never, by itself,
 * a request-envelope change.
 * @param a - one header's `system` field.
 * @param b - the other.
 * @returns whether the two texts are equal once the clock line is ignored.
 */
function systemEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return scrubNowLine(a) === scrubNowLine(b)
}

/**
 * Field-wise equality over canonical headers. Tool schemas compare in order.
 * `system` ignores the `harness:now` clock line alone (see
 * {@link systemEquals}) — the logged/persisted header still carries the real
 * clock reading; only comparison treats it as insignificant.
 * @param a - one canonical header.
 * @param b - the other.
 * @returns whether config, system (modulo the clock line), and tools all match.
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (
    !callConfigEquals(a.config, b.config)
    || a.adapterDefaults?.reasoningEffort !== b.adapterDefaults?.reasoningEffort
    || a.adapterDefaults?.maxTokens !== b.adapterDefaults?.maxTokens
    || !systemEquals(a.system, b.system)
  ) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))
}

/**
 * Fold the header events of a log (or any prefix) into the
 * {@link EpochHeader} in force after the last snapshot. Non-header events are
 * skipped. This is the pure offline reconstruction path; the live session
 * tracks the same fold incrementally.
 * @param events - session events in log order.
 * @param from - a previously folded state to continue from.
 * @returns the latest canonical header, or undefined when none exists yet.
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state = from
  for (const event of events) {
    if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  }
  return state
}
