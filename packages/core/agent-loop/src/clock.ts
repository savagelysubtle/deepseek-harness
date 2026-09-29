/**
 * Unconditional per-request clock tail message (SWD-113). Every dispatched
 * request ends with a freshly-read current-date-and-time message, appended
 * by `ReactLoopAgent.buildRequest` after the session-derived boundary —
 * never through `session.append`, so it is never persisted to the session
 * log and never grows the durable history. Keeping the clock off the system
 * prompt AND off the persisted message prefix means everything before this
 * one tail message stays byte-stable across steps, which is what lets a
 * provider's prefix cache actually reuse it; the clock itself still advances
 * every request, exactly as before, just from a location that costs nothing
 * to keep fresh.
 *
 * @module @deepseek-ai/dsh-agent-loop/clock
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { formatDateTime } from '@deepseek-ai/dsh-system-prompt'

/**
 * Plugin source tag identifying the clock tail message. Never written to the
 * session log, so this tag never appears in a persisted `user/message`
 * event — {@link isClockMessage} exists so a caller checking a DISPATCHED
 * request (never a session log) can still recognize it. Module-private: no
 * caller outside this module needs the raw tag, only the two functions below.
 */
const CLOCK_PLUGIN = '@deepseek-ai/dsh-agent-loop/clock'

/**
 * Build the clock tail message for one request, read fresh from `now` and
 * the process's own resolved IANA zone. Callers append the result only to
 * the outgoing `messages` array for THIS dispatch, after the session-derived
 * boundary — never to the session itself.
 * @param now - clock read once for this message (test-injectable via
 *   `AgentLoop.Config.now`).
 * @returns a fresh, freshly-identified user message; never reused across calls.
 */
export function buildClockMessage(now: () => Date): UserMessage {
  const text = formatDateTime(now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: CLOCK_PLUGIN },
  })
}

/**
 * Whether `message` is this package's ephemeral clock tail message. Guards
 * `source` defensively (rather than trusting the static `Message` contract)
 * because a caller checking an arbitrary dispatched-request message array —
 * the request-reconstruction invariant, tests building fixtures by hand —
 * cannot assume every element was actually built through {@link createUserMessage}.
 * @param message - one message from a dispatched request's `messages` array.
 * @returns whether it is the clock tail message this module builds.
 */
export function isClockMessage(message: Message): boolean {
  return message.role === 'user'
    // `source` is non-optional in the static Message contract, but a caller
    // here may be checking a hand-built fixture that never satisfied it.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    && message.source?.kind === 'plugin'
    && message.source.plugin === CLOCK_PLUGIN
}
