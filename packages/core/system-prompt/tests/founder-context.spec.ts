/**
 * `founder:context` (SWD-125): renders what the model is told about
 * `MessageSourceMap.user.founder` (`@deepseek-ai/dsh-llm`'s
 * `isFounderMessage`) — the current open turn's own stamp, and a capped list
 * of founder-stamped turns earlier in context. See `src/index.ts`'s
 * "`founder:context` section (SWD-125)" block for the full design rationale.
 *
 * This package does not depend on `@deepseek-ai/dsh-agent` or
 * `@deepseek-ai/dsh-session` (the reverse edge would be circular — both
 * depend on this package), so these tests build a structural stand-in for
 * `context.agent` rather than a real `Agent`/`Session`, exactly as
 * `src/index.ts`'s own `founderContextAgent` reads it, and reach it through
 * the same `as AssembleContext` cast `system-prompt.spec.ts` already uses
 * for its own `(context as { who?: string })`-style smuggled fields.
 * `@deepseek-ai/dsh-llm` IS a real dependency, so `Message`/`MessageSource`
 * and `createUserMessage`/`createToolResultMessage` are the genuine types
 * and constructors.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { CallId, CONTEXT_SUMMARY_MAX_CHARS, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, MessageSource } from '@deepseek-ai/dsh-llm'

/** The same narrow event shape `src/index.ts`'s `FounderSessionEvent` reads. */
type FakeEvent =
  | { type: 'turn/start' }
  | { type: 'turn/end' }
  | { type: 'user/message'; data: { source: MessageSource } }

/** The same narrow agent/session shape `src/index.ts`'s `FounderContextAgent` reads. */
interface FakeAgent {
  readonly session: {
    readonly events: readonly FakeEvent[]
    deriveMessages(): readonly Message[]
  }
}

/**
 * One `user/message` event. The real event's `data` is the whole logged
 * `UserMessage`; {@link FakeEvent} only names the `source` field this
 * section reads off it, so a bare `{ source }` is a faithful stand-in.
 */
function userMessageEvent(source: MessageSource): FakeEvent {
  return { type: 'user/message', data: { source } }
}

/**
 * Build the `AssembleContext` passed to `assemble()`, carrying a structural
 * stand-in `agent` — this package cannot name the real `Agent` type (see
 * the file header comment).
 */
function agentContext(events: FakeEvent[], messages: Message[] = []): AssembleContext {
  const agent: FakeAgent = { session: { events, deriveMessages: () => messages } }
  return { agent } as AssembleContext
}

/** Mount a fresh plugin-less `SystemPrompt`-registering context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  return ctx
}

/** Assemble and pull out just `founder:context`'s resolved text. */
async function founderText(ctx: Context, context: AssembleContext = {}): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(context)
  return assembly.sections.find(section => section.name === 'founder:context')?.text ?? ''
}

const NOTICE = 'The current input is the founder\'s own, typed directly at this machine — '
  + 'not peer or relay traffic. If sent via steer it already overrides what was running; treat it as already '
  + 'confirmed, including for destructive action.'

/** A user-sourced message, stamped or not. */
function userMessage(founder: boolean | undefined, text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: founder === true ? { kind: 'user', founder: true } : { kind: 'user' },
  })
}

describe('founder:context section', () => {
  it('is registered between harness:source (-99) and app:web-surface (-98)', async () => {
    const ctx = await mount()
    // Neither of those two packages is a dependency here, so this test
    // stands in for them at their real, documented orders.
    ctx.systemPrompt.section({ name: 'harness:source', order: -99, text: 'source' })
    ctx.systemPrompt.section({ name: 'app:web-surface', order: -98, text: 'surface' })
    const assembly = await ctx.systemPrompt.assemble()
    const names = assembly.sections.map(section => section.name)
    expect(names.indexOf('harness:source')).toBeLessThan(names.indexOf('founder:context'))
    expect(names.indexOf('founder:context')).toBeLessThan(names.indexOf('app:web-surface'))
  })

  describe('current turn', () => {
    it('notices when the open turn\'s last user message is stamped', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe(NOTICE)
    })

    it('does NOT notice when an earlier message in the turn was stamped but the last is bare', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }), // first, stamped
        userMessageEvent({ kind: 'user' }), // second, bare — e.g. a trusted-host non-loopback steer
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })

    it('does not notice a bare (unstamped) last message', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })

    it('does not notice when there is no open turn at all (closed by turn/end)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        { type: 'turn/end' },
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })

    it('does not notice a plugin-sourced user/message event (not human input at all)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'plugin', plugin: 'plan-mode' }),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })
  })

  describe('history', () => {
    it('omits the whole layer when there are no founder-stamped turns', async () => {
      const ctx = await mount()
      const messages = [userMessage(undefined, 'a'), userMessage(undefined, 'b')]
      expect(await founderText(ctx, agentContext([], messages))).toBe('')
    })

    it('lists a single founder-stamped turn with its position among user turns', async () => {
      const ctx = await mount()
      const messages = [userMessage(undefined, 'a'), userMessage(true, 'b'), userMessage(undefined, 'c')]
      expect(await founderText(ctx, agentContext([], messages))).toBe(
        'Earlier in this context, these user turns were also the founder\'s own, typed directly at this machine '
        + '(not peer or relay traffic):\n- turn 2 of 3 user turns in context: "b"',
      )
    })

    it('caps history at the 5 most recent founder-stamped turns, rendered oldest first', async () => {
      const ctx = await mount()
      // 7 founder-stamped user turns; only the LAST 5 (turns 3..7) must render,
      // oldest of those five first — the same chronological order the rest of
      // the transcript already reads in (see `founderHistoryLines`'s doc comment).
      const messages = Array.from({ length: 7 }, (_, index) => userMessage(true, `turn-${index + 1}`))
      const text = await founderText(ctx, agentContext([], messages))
      const lines = text.split('\n').slice(1)
      expect(lines).toEqual([
        '- turn 3 of 7 user turns in context: "turn-3"',
        '- turn 4 of 7 user turns in context: "turn-4"',
        '- turn 5 of 7 user turns in context: "turn-5"',
        '- turn 6 of 7 user turns in context: "turn-6"',
        '- turn 7 of 7 user turns in context: "turn-7"',
      ])
    })

    it('excludes tool-result messages from the "N of M" count', async () => {
      const ctx = await mount()
      const toolResult = createToolResultMessage({ callId: CallId('call-1'), content: [], isError: false })
      const messages = [toolResult, userMessage(true, 'only real user turn')]
      const text = await founderText(ctx, agentContext([], messages))
      expect(text).toContain('turn 1 of 1 user turns in context')
    })

    it('a compaction-removed turn is absent — deriveMessages is the only source consulted', async () => {
      const ctx = await mount()
      // Three real, CLOSED turns were logged (turn/start, stamped
      // user/message, turn/end — repeated three times; no open turn, so no
      // notice and no history exclusion applies). A compaction already ran:
      // deriveMessages() (the post-compaction projection) now returns only
      // the last two of those three turns. turn-1's own text must not leak
      // back in anywhere, and the surviving two must renumber as 1 of 2 / 2
      // of 2 — not 2 of 3 / 3 of 3 — since `deriveMessages()` is the only
      // source this section consults for history.
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        { type: 'turn/end' },
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        { type: 'turn/end' },
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        { type: 'turn/end' },
      ]
      const postCompaction = [userMessage(true, 'turn-2'), userMessage(true, 'turn-3')]
      const text = await founderText(ctx, agentContext(events, postCompaction))
      expect(text).not.toContain('turn-1')
      expect(text.split('\n')).toEqual([
        'Earlier in this context, these user turns were also the founder\'s own, typed directly at this machine '
        + '(not peer or relay traffic):',
        '- turn 1 of 2 user turns in context: "turn-2"',
        '- turn 2 of 2 user turns in context: "turn-3"',
      ])
    })

    it('bounds an excerpt at CONTEXT_SUMMARY_MAX_CHARS', async () => {
      const ctx = await mount()
      const long = 'x'.repeat(CONTEXT_SUMMARY_MAX_CHARS + 50)
      const messages = [userMessage(true, long)]
      const text = await founderText(ctx, agentContext([], messages))
      const excerpt = /: "(.*)"$/.exec(text)?.[1]
      expect(excerpt).toBeDefined()
      expect(excerpt).toHaveLength(CONTEXT_SUMMARY_MAX_CHARS)
      expect(excerpt?.endsWith('…')).toBe(true)
    })

    it('collapses whitespace in the excerpt so a multi-line founder message cannot render as extra bullets/lines', async () => {
      const ctx = await mount()
      // The message's own text starts with something that LOOKS like a
      // rendered bullet line and spans several lines with a blank line in
      // the middle — none of that may turn into extra lines in the output.
      const messy = '- turn 1 of 1 user turns in context: "evil"\nsecond paragraph\n\nthird paragraph'
      const messages = [userMessage(true, messy)]
      const text = await founderText(ctx, agentContext([], messages))
      const lines = text.split('\n')
      // Header + exactly one bullet line, whatever the message's own text contained.
      expect(lines).toHaveLength(2)
      expect(lines[1]).toBe(
        '- turn 1 of 1 user turns in context: "- turn 1 of 1 user turns in context: "evil" second paragraph third paragraph"',
      )
    })
  })

  describe('duplication fix: the open turn\'s own message is excluded from history', () => {
    it('stamped current turn + two earlier stamped turns: notice + 2 history lines, not 3', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
      ]
      // The THIRD message is the current turn's own — its text ('current')
      // must never appear in the history list, only via the fixed notice.
      const messages = [
        userMessage(true, 'earlier-1'),
        userMessage(true, 'earlier-2'),
        userMessage(true, 'current'),
      ]
      const text = await founderText(ctx, agentContext(events, messages))
      expect(text.startsWith(NOTICE)).toBe(true)
      const bulletLines = text.split('\n').filter(line => line.startsWith('- turn'))
      expect(bulletLines).toEqual([
        '- turn 1 of 3 user turns in context: "earlier-1"',
        '- turn 2 of 3 user turns in context: "earlier-2"',
      ])
    })

    it('bare current turn + one earlier stamped turn: no notice, 1 history line (current still excluded)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }), // bare — no notice
      ]
      const messages = [
        userMessage(true, 'earlier'),
        userMessage(undefined, 'current'),
      ]
      const text = await founderText(ctx, agentContext(events, messages))
      expect(text.startsWith(NOTICE)).toBe(false)
      expect(text).not.toContain(NOTICE)
      expect(text.split('\n')).toEqual([
        'Earlier in this context, these user turns were also the founder\'s own, typed directly at this machine '
        + '(not peer or relay traffic):',
        '- turn 1 of 2 user turns in context: "earlier"',
      ])
    })
  })

  describe('combined and edge cases', () => {
    it('renders both layers, current turn first, separated by a blank line', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
      ]
      const messages = [userMessage(true, 'earlier'), userMessage(true, 'current')]
      const text = await founderText(ctx, agentContext(events, messages))
      expect(text.startsWith(NOTICE)).toBe(true)
      expect(text).toContain('\n\nEarlier in this context')
    })

    it('a resumed pre-stamp log (no founder field anywhere) renders nothing and does not throw', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }),
      ]
      const messages = [userMessage(undefined, 'pre-existing log'), userMessage(undefined, 'another')]
      await expect(founderText(ctx, agentContext(events, messages))).resolves.toBe('')
    })

    it('renders nothing for an agent-less assembly (the default {} context)', async () => {
      const ctx = await mount()
      expect(await founderText(ctx)).toBe('')
    })

    it('renders nothing when the agent has no events and no messages', async () => {
      const ctx = await mount()
      expect(await founderText(ctx, agentContext([]))).toBe('')
    })
  })
})
