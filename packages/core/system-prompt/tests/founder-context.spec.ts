/**
 * `founder:context` (SWD-125): renders what the model is told about
 * `MessageSourceMap.user.founder` (`@deepseek-ai/dsh-llm`'s
 * `isFounderMessage`) — whether the CURRENTLY OPEN turn's own input is the
 * founder's own. See `src/index.ts`'s "`founder:context` section (SWD-125)"
 * block for the full design rationale.
 *
 * Founder ruling 2026-10-02: the section used to also render a capped list
 * of earlier founder-stamped turns still in context, but that list grew
 * turn over turn, which meant the system prompt (the provider cache prefix)
 * changed on every founder turn after the first — caught by the ACP
 * snapshot suite as a header-stability violation. The history layer was
 * removed outright; this spec now tests ONLY the current-turn notice and
 * its byte-stability across turns, plus the `source.kind` filter on which
 * `user/message` event of the open turn counts as "the current input".
 *
 * This package does not depend on `@deepseek-ai/dsh-agent` or
 * `@deepseek-ai/dsh-session` (the reverse edge would be circular — both
 * depend on this package), so these tests build a structural stand-in for
 * `context.agent` rather than a real `Agent`/`Session`, exactly as
 * `src/index.ts`'s own `founderContextAgent` reads it, and reach it through
 * the same `as AssembleContext` cast `system-prompt.spec.ts` already uses
 * for its own `(context as { who?: string })`-style smuggled fields.
 * `@deepseek-ai/dsh-llm` IS a real dependency, so `MessageSource` is the
 * genuine type.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { MessageSource } from '@deepseek-ai/dsh-llm'

/**
 * Minimal real-shaped `MailboxRelaySource` / `SubagentSettledMessageSource`
 * literals (`packages/mailbox/mailbox/src/source.ts:19-50,82-88`,
 * `packages/subagent/subagent/src/continuation.ts:82-96`). Both augmenting
 * packages are already part of this repo's single `tsc -b tsconfig.host.json`
 * program (every package's `tests/**` is swept into that one program by
 * `tsconfig.host.json`'s own `include`), so their real `MessageSourceMap`
 * merges are already visible here — no local `declare module` is needed, or
 * safe: a locally-redeclared member with a DIFFERENT type than the real one
 * is a duplicate-declaration error in that shared program, not a shadow.
 * Each source's branded id field (`MailboxAddress`/`MailboxMessageId`,
 * `SessionId`) cannot be minted here without adding `@deepseek-ai/dsh-mailbox`
 * / `@deepseek-ai/dsh-subagent` as a dependency of this package purely for a
 * test fixture, so the boundary cast below bridges only that nominal brand —
 * every field name and plain-string value is the real shape.
 */
function mailboxRelaySource(): MessageSource {
  return {
    kind: 'mailbox', form: 'relay', address: 'addr', from: 'sender', messageId: 'msg-1',
  } as unknown as MessageSource
}

/** See {@link mailboxRelaySource}'s doc comment. */
function subagentSettledSource(): MessageSource {
  return {
    kind: 'subagent-settled', form: 'notice', summary: 'settled', senderSessionId: 'child-1',
  } as unknown as MessageSource
}

/** The same narrow event shape `src/index.ts`'s `FounderSessionEvent` reads. */
type FakeEvent =
  | { type: 'turn/start' }
  | { type: 'turn/end' }
  | { type: 'user/message'; data: { source: MessageSource } }

/** The same narrow agent/session shape `src/index.ts`'s `FounderContextAgent` reads. */
interface FakeAgent {
  readonly session: {
    readonly events: readonly FakeEvent[]
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
function agentContext(events: FakeEvent[]): AssembleContext {
  const agent: FakeAgent = { session: { events } }
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

    it('still notices a stamped human message when the runtime-context snapshot (its real '
      + 'plugin id — isMechanicalContextSource recognizes it by this exact id) '
      + 'follows it in the same step (the real agent-loop ordering: preStep appends the claimed '
      + 'human message, then the runtime-context snapshot, both logged as user/message events)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        userMessageEvent({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe(NOTICE)
    })

    it('does NOT notice when a later BARE kind:\'user\' message follows a stamped one '
      + '(the mechanical-context skip must not reach past a genuine later human turn)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        userMessageEvent({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }),
        userMessageEvent({ kind: 'user' }),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })

    it('does NOT notice when a mailbox relay (outside-controlled content) follows a stamped '
      + 'message — mailbox is not on the closed mechanical-context allowlist, so it counts as '
      + 'the latest message and denies (sentinel ruling, 2026-10-02)', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        userMessageEvent(mailboxRelaySource()),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })

    it('does NOT notice when a subagent-settled notice (outside-controlled content) follows a '
      + 'stamped message', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
        userMessageEvent(subagentSettledSource()),
      ]
      expect(await founderText(ctx, agentContext(events))).toBe('')
    })
  })

  describe('cache-prefix stability (founder ruling 2026-10-02)', () => {
    it('renders byte-identical text across two consecutive founder-stamped turns', async () => {
      const ctx = await mount()
      const turnOne: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
      ]
      const turnTwo: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user', founder: true }),
      ]
      const first = await founderText(ctx, agentContext(turnOne))
      const second = await founderText(ctx, agentContext(turnTwo))
      expect(first).toBe(second)
      expect(first).toBe(NOTICE)
    })

    it('renders byte-identical empty text across two consecutive unstamped turns', async () => {
      const ctx = await mount()
      const turnOne: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }),
      ]
      const turnTwo: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }),
      ]
      const first = await founderText(ctx, agentContext(turnOne))
      const second = await founderText(ctx, agentContext(turnTwo))
      expect(first).toBe(second)
      expect(first).toBe('')
    })

    it('never renders a history list, no matter how many founder-stamped turns preceded this one', async () => {
      const ctx = await mount()
      // A long run of closed, founder-stamped turns followed by one more
      // open, founder-stamped turn. Only the fixed notice may appear —
      // nothing resembling the old "Earlier in this context…" list or a
      // rendered turn-position bullet.
      const events: FakeEvent[] = []
      for (let i = 0; i < 7; i += 1) {
        events.push({ type: 'turn/start' }, userMessageEvent({ kind: 'user', founder: true }), { type: 'turn/end' })
      }
      events.push({ type: 'turn/start' }, userMessageEvent({ kind: 'user', founder: true }))
      const text = await founderText(ctx, agentContext(events))
      expect(text).toBe(NOTICE)
      expect(text).not.toContain('Earlier in this context')
      expect(text).not.toMatch(/turn \d+ of \d+/)
    })
  })

  describe('combined and edge cases', () => {
    it('renders nothing for an agent-less assembly (the default {} context)', async () => {
      const ctx = await mount()
      expect(await founderText(ctx)).toBe('')
    })

    it('renders nothing when the agent has no events', async () => {
      const ctx = await mount()
      expect(await founderText(ctx, agentContext([]))).toBe('')
    })

    it('a resumed pre-stamp log (no founder field anywhere) renders nothing and does not throw', async () => {
      const ctx = await mount()
      const events: FakeEvent[] = [
        { type: 'turn/start' },
        userMessageEvent({ kind: 'user' }),
      ]
      await expect(founderText(ctx, agentContext(events))).resolves.toBe('')
    })
  })
})
