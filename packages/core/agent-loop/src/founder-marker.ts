/**
 * Founder marker sentence (SWD-156). The founder stamp itself
 * (`MessageSourceMap.user.founder`, see `@deepseek-ai/dsh-llm`'s `message.ts`)
 * lives in event data and is never model-visible on its own; its model-facing
 * rendering is {@link FOUNDER_MARKER_TEXT} placed on a founder message's
 * header line, right after the per-message time stamp, by `renderDispatch`
 * (`./render-dispatch.ts`).
 *
 * Request-only, by design, not by oversight: SWD-125 settled that the founder
 * stamp lives in the conversation, never in `system`, and the system prompt
 * must be byte-stable across turns. The marker is rendered fresh on every
 * dispatch from the logged `founder` flag and never written through
 * `session.append`, so the durable log is untouched; it is a pure function of
 * the logged message, so the same founder message renders the identical header
 * on every later replay and the provider prefix cache keeps warming.
 *
 * @module @deepseek-ai/dsh-agent-loop/founder-marker
 */

/**
 * Exact sentence placed on a founder-stamped message's header line at
 * dispatch time (founder ruling, 2026-10-06, final). Wording is frozen. No
 * trailing newline is baked into the constant; the renderer adds the blank
 * line that separates the header from the message's own content.
 */
export const FOUNDER_MARKER_TEXT =
  "This message is the founder's own, typed at this machine; it is not peer or relay traffic."
