/**
 * Dispatch-time rendering of the session transcript: the one pure function
 * that turns the logged, timed message list into the exact `messages` a
 * request carries. Replaces the former clock tail message and the separate
 * founder-marker stage.
 *
 * Every user-role TEXT message gets its own header line built from its own
 * logged event time, `[Thu 2026-10-30 11:54 PDT]`; a founder-stamped message
 * puts {@link FOUNDER_MARKER_TEXT} on the same line after the stamp. Because
 * each stamp is a pure function of the message's own logged bytes, the
 * rendered prefix never changes as the conversation grows, so the provider's
 * prefix cache keeps warming. Adjacent same-run harness notices (the
 * allowlist in {@link isMergeableNotice}) collapse into their head message so
 * a step-start burst reads as one user turn instead of several. Tool results
 * and assistant messages are returned untouched, by reference.
 *
 * Request-only by design: nothing here is ever written to the session log.
 * Shared by `buildRequest`, the request-reconstruction invariant and
 * `compaction-basic`'s summarization input so all three agree byte for byte.
 *
 * @module @deepseek-ai/dsh-agent-loop/render-dispatch
 */

import { isFounderMessage, isMechanicalContextSource } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm'
import { formatMessageStamp } from '@deepseek-ai/dsh-system-prompt'
import { FOUNDER_MARKER_TEXT } from './founder-marker.ts'

/** A derived message paired with the logged event time that produced it. */
export interface TimedMessage {
  /** The derived (logged) message. */
  readonly message: Message
  /** The producing session event's `time`, epoch milliseconds. */
  readonly time: number
}

/** Options for {@link renderDispatch}. */
export interface RenderDispatchOptions {
  /** IANA zone the stamps are rendered in; resolve once via {@link resolveDispatchTimeZone}. */
  readonly timeZone: string
}

/**
 * The process's own IANA zone, the single zone every dispatch stamp uses.
 * @returns the resolved zone name, e.g. `America/Vancouver`.
 */
export function resolveDispatchTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Plugin id of tool-jobs completion notices (carry a model-chosen job label). */
const TOOL_JOBS_PLUGIN = 'tool-jobs'
/** Plugin id of the context-pressure warning (fixed numeric template). */
const CONTEXT_PRESSURE_PLUGIN = 'context-pressure'
/** Plugin id of the agent-instructions budget notice (transcript-only). */
const AGENT_INSTRUCTIONS_PLUGIN = 'agent-instructions'
/** A line shaped like a dispatch stamp; a notice carrying one could forge a message boundary. */
const STAMP_SHAPED_LINE = /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} /m

/**
 * Whether a source is on the harness-notice merge allowlist: the mechanical
 * context set (`isMechanicalContextSource`, untouched) plus the exact
 * `tool-jobs` and `context-pressure` plugin ids. May only widen, never
 * narrow, the authority-skip set.
 * @param source - the message source to test.
 * @returns whether messages from this source may merge into a run.
 */
export function isMergeableNoticeSource(source: MessageSource): boolean {
  return isMechanicalContextSource(source)
    || (source.kind === 'plugin' && (source.plugin === TOOL_JOBS_PLUGIN || source.plugin === CONTEXT_PRESSURE_PLUGIN))
}

/**
 * Whether a message is a mergeable harness notice: an allowlisted source AND
 * no text that could forge the founder marker or a dispatch stamp line.
 * @param message - a stampable user message.
 * @returns whether it may join a run behind its head.
 */
export function isMergeableNotice(message: Message): boolean {
  if (!isMergeableNoticeSource(message.source)) return false
  // Serializers join adjacent text blocks with '', so test the joined text: a
  // marker or stamp line split across blocks is still one string on the wire.
  const joined = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  return !joined.includes(FOUNDER_MARKER_TEXT) && !STAMP_SHAPED_LINE.test(joined)
}

/**
 * Transcript-only sources: logged and shown to the founder, never dispatched to
 * the model. Currently only the agent-instructions budget-overflow notice
 * (founder ruling: loud on screen, but the model gains nothing from it).
 */
function isTranscriptOnly(source: MessageSource): boolean {
  return source.kind === 'plugin'
    && source.plugin === AGENT_INSTRUCTIONS_PLUGIN
    && source.form === 'notice'
}

/** Whether a message receives a header: user role, not tool-sourced, carrying no tool-result block. */
function isStampable(message: Message): boolean {
  return message.role === 'user'
    && message.source.kind !== 'tool'
    && !message.content.some(block => block.type === 'tool-result')
}

/** The header block for a head message at `time`. */
function headerBlock(head: Message, time: number, timeZone: string): ContentBlock {
  const stamp = formatMessageStamp(new Date(time), timeZone)
  const line = isFounderMessage(head.source) ? `${stamp} ${FOUNDER_MARKER_TEXT}` : stamp
  return { type: 'text', text: `${line}\n\n` }
}

/** `content` with a blank-line separator block placed after its last text block (at the end when none). */
function withSeparator(content: readonly ContentBlock[]): ContentBlock[] {
  const out = [...content]
  let at = out.length
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.type === 'text') {
      at = i + 1
      break
    }
  }
  out.splice(at, 0, { type: 'text', text: '\n\n' })
  return out
}

/**
 * Render the dispatched `messages` from the logged, timed message list. Pure:
 * the result depends only on the argument bytes and `timeZone`.
 *
 * Runs: a stampable user message starts a run (its head); following stampable
 * messages join while they are {@link isMergeableNotice}. A non-founder,
 * non-notice head renders LAST in the merged message, after its notices in log
 * order; an all-notice run keeps log order. A founder head is NEVER merged: its
 * content is exactly the header (stamp, marker) plus its own blocks, and the
 * run's notices render as one all-notice message placed immediately before it
 * (header = the first notice's own time, id and source = the first notice's), so
 * file-sourced or model-labelled notice text never sits beneath the founder
 * marker. A lone message is just stamped; a merged message keeps the head's id
 * and source and its header uses the head's own time.
 * Transcript-only notices (`agent-instructions` `form: 'notice'`) are dropped here.
 * @param allTimed - `session.deriveTimedMessages()` (or an equivalent region).
 * @param options - the stamp zone.
 * @returns the messages to dispatch; non-stampable elements are the SAME references.
 */
export function renderDispatch(
  allTimed: readonly TimedMessage[],
  options: RenderDispatchOptions,
): Message[] {
  const { timeZone } = options
  const timed = allTimed.filter(entry => !isTranscriptOnly(entry.message.source))
  const out: Message[] = []
  let i = 0
  while (i < timed.length) {
    // i < timed.length, so the element exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const entry = timed[i]!
    const head = entry.message
    i++
    if (!isStampable(head)) {
      out.push(head)
      continue
    }
    const headIsFounder = isFounderMessage(head.source)
    const headIsNotice = isMergeableNotice(head)
    const members: TimedMessage[] = []
    while (i < timed.length) {
      // i < timed.length, so the element exists.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const next = timed[i]!
      if (!isStampable(next.message) || !isMergeableNotice(next.message)) break
      members.push(next)
      i++
    }
    if (headIsFounder) {
      // A founder message is never merged with anything: its own text is the only
      // thing that renders beneath the founder marker. Notices that followed it in
      // the run render as ONE all-notice message immediately BEFORE it.
      const first = members[0]
      if (first !== undefined) {
        const noticeContent: ContentBlock[] = [headerBlock(first.message, first.time, timeZone)]
        for (const member of members) noticeContent.push(...withSeparator(member.message.content))
        out.push({ ...first.message, content: noticeContent })
      }
      out.push({ ...head, content: [headerBlock(head, entry.time, timeZone), ...head.content] })
      continue
    }
    const content: ContentBlock[] = [headerBlock(head, entry.time, timeZone)]
    if (headIsNotice) {
      // All-notice run: log order, head first.
      content.push(...(members.length === 0 ? head.content : withSeparator(head.content)))
      members.forEach((member, index) => {
        content.push(...(index === members.length - 1 ? member.message.content : withSeparator(member.message.content)))
      })
    } else {
      for (const member of members) content.push(...withSeparator(member.message.content))
      content.push(...head.content)
    }
    out.push({ ...head, content })
  }
  return out
}
