import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import * as ContextPressureInvariant from '@deepseek-ai/dsh-context-pressure/invariant'
import { renderWarningText } from '@deepseek-ai/dsh-context-pressure/src/warning.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const PLUGIN = 'context-pressure'

/** Well-formed plugin source wrapping one warning's exact rendered text. */
function sourceFor(text: string): Record<string, unknown> {
  return {
    kind: 'plugin',
    plugin: PLUGIN,
    form: 'snapshot',
    sections: [{ name: PLUGIN, text }],
  }
}

/** Build one plugin-attributed message from real content blocks and an arbitrary (possibly malformed) source. */
function warningMessage(content: readonly ContentBlock[], source: Record<string, unknown>): UserMessage {
  return createUserMessage({
    content: [...content],
    source: source as never,
  })
}

/** Mount a real Cordis Context wiring sessions, the token meter, and this package's invariant. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  void new TokenMeter(ctx)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContextPressureInvariant)
  return ctx
}

/** Append one durable warning built from exact threshold/usage/window facts. */
function appendWarning(
  session: Session,
  thresholdRatio: number,
  totalTokens: number,
  contextWindow: number,
): SessionEvent<'user/message'> {
  const text = renderWarningText({ thresholdRatio, totalTokens, contextWindow })
  return session.append('user/message', warningMessage([{ type: 'text', text }], sourceFor(text)), { surfaceOp: 'append' })
}

describe('validatePosition (through validateWarning)', () => {
  it('rejects a warning appended with no open turn', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('pos-no-turn'))
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/must be appended inside an open turn/)
  })

  it('rejects a warning appended before step/start', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('pos-no-step'))
    session.append('turn/start', { turn: 1 })
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/must follow step\/start/)
  })

  it('rejects a warning appended after request/header opens the request', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('pos-after-header'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock-provider', model: 'mock-model' } },
      reason: 'initial',
    })
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/must precede request\/header/)
  })

  it('accepts a warning positioned after step/end closes a prior step', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('pos-after-step-end'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) }).not.toThrow()
  })

  it('rejects a warning appended after turn/end closes the enclosing turn', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('pos-after-turn-end'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/must be appended inside an open turn/)
  })
})

describe('validateWarning content shape', () => {
  it.each([
    ['no content blocks', []],
    ['a non-text block', [{
      type: 'image',
      attachment: { attachmentId: AttachmentId('a'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    }]],
    ['two text blocks', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]],
  ] as const)('rejects a warning with %s', async (label, content) => {
    const ctx = await mount()
    const session = Session.create(SessionId(`shape-${label.replace(/\s+/g, '-')}`))
    const event = session.append(
      'user/message',
      warningMessage([...content], sourceFor('irrelevant')),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/exactly one text block/)
  })

  it('rejects text that does not match the durable warning format', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('parse-fail'))
    const text = 'not a real warning'
    const event = session.append(
      'user/message',
      warningMessage([{ type: 'text', text }], sourceFor(text)),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/does not match the durable warning format/)
  })
})

describe('validateWarning source shape', () => {
  const text = renderWarningText({ thresholdRatio: 0.25, totalTokens: 1, contextWindow: 1_000_000 })
  const wellFormed = sourceFor(text)

  it.each([
    ['missing form and sections', { kind: 'plugin', plugin: PLUGIN }],
    ['an extra top-level key', { ...wellFormed, authority: {} }],
    ['a mismatched section text', {
      kind: 'plugin', plugin: PLUGIN, form: 'snapshot', sections: [{ name: PLUGIN, text: 'different text' }],
    }],
    ['non-array sections', {
      kind: 'plugin', plugin: PLUGIN, form: 'snapshot', sections: { 0: { name: PLUGIN, text }, length: 1 },
    }],
    ['an extra section key', {
      kind: 'plugin', plugin: PLUGIN, form: 'snapshot', sections: [{ name: PLUGIN, text, extra: true }],
    }],
  ] as const)('rejects a warning with %s', async (label, source) => {
    const ctx = await mount()
    const session = Session.create(SessionId(`source-${label.replace(/\s+/g, '-')}`))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const event = session.append(
      'user/message',
      warningMessage([{ type: 'text', text }], source),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/must carry only the exact snapshot text, not request authority/)
  })
})

describe('validateWarning recorded-fact consistency', () => {
  it('rejects remaining tokens that disagree with usage and window', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('fact-remaining'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const text = 'Context pressure notice: usage passed the 25% threshold '
      + "of this model's context window: 50000 of 100000 tokens in use "
      + '(50%); 1 tokens remain.\n'
      + 'Before rising pressure forces automatic compaction, you can request compaction yourself '
      + 'with the compact tool.'
    const event = session.append(
      'user/message',
      warningMessage([{ type: 'text', text }], sourceFor(text)),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/remaining tokens disagree with its recorded usage and window/)
  })

  it('rejects a non-canonical threshold percent', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('fact-threshold'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const text = 'Context pressure notice: usage passed the 25.0% threshold '
      + "of this model's context window: 50000 of 100000 tokens in use "
      + '(50%); 50000 tokens remain.\n'
      + 'Before rising pressure forces automatic compaction, you can request compaction yourself '
      + 'with the compact tool.'
    const event = session.append(
      'user/message',
      warningMessage([{ type: 'text', text }], sourceFor(text)),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/threshold percent 25\.0 is not canonical/)
  })

  it('rejects a used percent that disagrees with recorded usage and window', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('fact-used'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const text = 'Context pressure notice: usage passed the 25% threshold '
      + "of this model's context window: 25000 of 100000 tokens in use "
      + '(30%); 75000 tokens remain.\n'
      + 'Before rising pressure forces automatic compaction, you can request compaction yourself '
      + 'with the compact tool.'
    const event = session.append(
      'user/message',
      warningMessage([{ type: 'text', text }], sourceFor(text)),
      { surfaceOp: 'append' },
    )
    expect(() => { ctx.emit('session/event', session, event) })
      .toThrow(/used percent 30 disagrees with its recorded usage and window/)
  })

  it('accepts a fully well-formed, well-positioned warning', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('fact-valid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const event = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, event) }).not.toThrow()
  })
})

describe('validateGenerations', () => {
  it('rejects descending thresholds within one open compaction generation', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-descend'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendWarning(session, 0.5, 1, 1_000_000)
    const second = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, second) })
      .toThrow(/thresholds must ascend within one compaction generation: 50% is followed by 25%/)
  })

  it('accepts two ascending warnings in the same still-open generation when the measured total holds', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-ascend-ok'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendWarning(session, 0.25, 1, 1_000_000)
    const second = appendWarning(session, 0.5, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, second) }).not.toThrow()
  })

  it('rejects a measured total that regresses within the still-open final generation', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-regress'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    // Inflated recorded total: no real usage in this session comes close.
    appendWarning(session, 0.25, 500_000, 1_000_000)
    const second = appendWarning(session, 0.5, 2, 1_000_000)
    expect(() => { ctx.emit('session/event', session, second) })
      .toThrow(/measured total \d+ fell below earlier same-generation warning total 500000 without an intervening compaction/)
  })

  it('resets the generation check after an intervening compaction/end', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-reset'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendWarning(session, 0.75, 500_000, 1_000_000)
    session.append('compaction/end', { compactionId: CompactionId('reset'), turn: null })
    const second = appendWarning(session, 0.25, 1, 1_000_000)
    expect(() => { ctx.emit('session/event', session, second) }).not.toThrow()
  })

  it('skips the regression check once a later compaction/end supersedes the pair', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-superseded'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendWarning(session, 0.25, 500_000, 1_000_000)
    const second = appendWarning(session, 0.5, 2, 1_000_000)
    session.append('compaction/end', { compactionId: CompactionId('super'), turn: null })
    expect(() => { ctx.emit('session/event', session, second) }).not.toThrow()
  })

  it('ignores non-plugin and non-warning events while dispatching', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('gen-ignore'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const other = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary user text' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => { ctx.emit('session/event', session, other) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })
})

describe('install-time validation', () => {
  it('validates every pre-existing session when the invariant registers late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    void new TokenMeter(ctx)
    const session = ctx.sessions.create(SessionId('late-valid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    appendWarning(session, 0.25, 1, 1_000_000)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ContextPressureInvariant)).resolves.toBeDefined()
  })

  it('rejects an invalid pre-existing session when the invariant registers late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    void new TokenMeter(ctx)
    const session = ctx.sessions.create(SessionId('late-invalid'))
    // No turn/start: violates validatePosition.
    appendWarning(session, 0.25, 1, 1_000_000)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ContextPressureInvariant).then(() => undefined))
      .rejects.toThrow(/must be appended inside an open turn/)
  })

  it('rejects an invalid session seeded and created after the invariant is already registered', async () => {
    const ctx = await mount()
    const text = renderWarningText({ thresholdRatio: 0.25, totalTokens: 1, contextWindow: 1_000_000 })
    expect(() => {
      ctx.sessions.create(SessionId('created-invalid'), {
        seed: [
          {
            type: 'user/message',
            seq: 0,
            time: Date.now(),
            data: warningMessage([{ type: 'text', text }], sourceFor(text)),
            surfaceOp: 'append',
          } as unknown as SessionEvent<'user/message'>,
        ],
      })
    }).toThrow(/must be appended inside an open turn/)
  })

  it('accepts a valid session seeded and created after the invariant is already registered', async () => {
    const ctx = await mount()
    const text = renderWarningText({ thresholdRatio: 0.25, totalTokens: 1, contextWindow: 1_000_000 })
    expect(() => {
      ctx.sessions.create(SessionId('created-valid'), {
        seed: [
          { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: Date.now(), data: { turn: 1, step: 1 } },
          {
            type: 'user/message',
            seq: 2,
            time: Date.now(),
            data: warningMessage([{ type: 'text', text }], sourceFor(text)),
            surfaceOp: 'append',
          } as unknown as SessionEvent<'user/message'>,
        ],
      })
    }).not.toThrow()
  })
})
