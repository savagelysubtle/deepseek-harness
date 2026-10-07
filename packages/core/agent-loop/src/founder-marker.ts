/**
 * Per-message founder marker (SWD-156). The founder stamp itself
 * (`MessageSourceMap.user.founder`, see `@deepseek-ai/dsh-llm`'s `message.ts`)
 * lives in event data and is never model-visible on its own — this module is
 * that stamp's model-facing rendering, applied ONLY to the array
 * `ReactLoopAgent.buildRequest` (`../src/agent.ts`) actually dispatches.
 *
 * Request-only, by design, not by oversight: SWD-125 settled that the
 * founder stamp lives in the conversation, never in `system`, and the
 * founder's own later ruling went further — "the system prompt must be
 * byte-stable across turns; per-turn material belongs in the conversation,
 * not the cache prefix" — which this module honors from the other
 * direction. A marker baked into a LOGGED message would itself become part
 * of every later turn's byte-stable prefix, varying turn to turn with which
 * messages happened to be founder-stamped; keeping it out of
 * `session.append`/`deriveMessages()` entirely means the durable log, and
 * therefore the provider prefix cache, never sees it at all. {@link
 * markFounderMessages} is called fresh on every dispatch (see
 * `buildRequest`'s call site, immediately beside the equally-ephemeral
 * clock tail from `./clock.ts`) and is a pure function of its input, so the
 * same founder-stamped message produces the identical marker block on every
 * later replay — the cache still warms.
 *
 * Leading position is likewise load-bearing, not cosmetic: both provider
 * adapters (`llm-deepseek`'s and `llm-pi-ai`'s `flattenText`) flatten every
 * `type: 'text'` block of a message with a plain join and no separator, so a
 * marker appended after other text could land mid-sentence depending on
 * block order. A leading block plus its own trailing blank line guarantees a
 * clean boundary before the message's real content, regardless of how many
 * further text blocks that message carries.
 *
 * The request-reconstruction invariant (`./invariant.ts`) recomputes this
 * same transform over its own `expected` side before comparing, so a
 * dispatched request that marks the wrong message (or omits the marker on a
 * message that should carry one) still fails that check — this is the
 * second known, deterministic, by-design divergence between a dispatched
 * request and the durable log, alongside the unconditional clock tail.
 *
 * @module @deepseek-ai/dsh-agent-loop/founder-marker
 */

import { isFounderMessage, type Message } from '@deepseek-ai/dsh-llm'

/**
 * Exact sentence prepended to a founder-stamped message's content at
 * dispatch time (founder ruling, 2026-10-06, final). No trailing newline is
 * baked into the constant itself — callers that render it as its own
 * leading block add the separating blank line at the use site, mirroring
 * `compaction-basic`'s `CHECKPOINT_PREAMBLE` pattern.
 */
export const FOUNDER_MARKER_TEXT =
  "This message is the founder's own, typed at this machine; it is not peer or relay traffic."

/**
 * Prepend {@link FOUNDER_MARKER_TEXT} as a leading text block to every
 * founder-stamped message in `messages` (per `isFounderMessage`), leaving
 * every other message untouched. Pure and reference-preserving: a message
 * that does not carry the founder stamp is returned by the SAME array
 * element, never copied, so an all-unstamped input is byte-identical to
 * calling code that never ran this transform at all. A founder-stamped
 * message instead becomes a shallow copy — same `id`/`role`/`source`, a new
 * `content` array of `[marker, ...original content]` — never mutating the
 * original message or its content blocks.
 * @param messages - candidate messages, in their existing order.
 * @returns a same-length, same-order array; founder-stamped elements are
 *   shallow copies carrying the leading marker block, every other element
 *   is the original reference.
 */
export function markFounderMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (!isFounderMessage(message.source)) return message
    return {
      ...message,
      content: [{ type: 'text', text: `${FOUNDER_MARKER_TEXT}\n\n` }, ...message.content],
    }
  })
}
