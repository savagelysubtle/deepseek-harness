import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  freezeMessage,
  isFounderMessage,
  isMechanicalContextSource,
  MessageId,
  selectFounderAuthorityMessage,
  type MessageSource,
  type MessageSourceMap,
} from '@deepseek-ai/dsh-llm'

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

describe('message construction', () => {
  it('assigns identity immediately and returns a detached deep-frozen message', () => {
    const input = {
      content: [{ type: 'text' as const, text: 'original' }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    }

    const message = createUserMessage(input)

    expect(message.id).toEqual(expect.any(String))
    expect(message.role).toBe('user')
    expect(message.id).not.toHaveLength(0)
    expect(message).not.toBe(input)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)

    input.content[0]!.text = 'caller mutation'
    expect(message.content).toEqual([{ type: 'text', text: 'original' }])
    expect(() => {
      (message.content[0] as { text: string }).text = 'observer mutation'
    }).toThrow()
  })

  it('freezes an existing identity without minting a replacement', () => {
    const id = MessageId('existing')
    const input = {
      id,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'answer' }],
      source: { kind: 'model' as const, provider: 'test', model: 'test' },
    }

    const message = freezeMessage(input)

    expect(message).not.toBe(input)
    expect(message.id).toBe(id)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })

  it('fixes the assistant role and model source kind at creation', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: {
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })

    expect(message).toMatchObject({
      role: 'assistant',
      source: {
        kind: 'model',
        provider: 'test-provider',
        model: 'test-model',
        replayState: { request: 1 },
      },
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('couples tool-result content and its cited call seq to one call identity', () => {
    const callId = CallId('call-1')
    const message = createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    })

    expect(message).toMatchObject({
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }],
    })
    expect(message.id).not.toHaveLength(0)
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content[0])).toBe(true)
  })
})

describe('isFounderMessage', () => {
  it('is true only for a user source explicitly stamped founder: true', () => {
    expect(isFounderMessage({ kind: 'user', founder: true })).toBe(true)
  })

  it('is false for a bare user source carrying no founder field', () => {
    expect(isFounderMessage({ kind: 'user' })).toBe(false)
  })

  it('is false for every other source kind, founder field or not', () => {
    expect(isFounderMessage({ kind: 'model', provider: 'test', model: 'test' })).toBe(false)
    expect(isFounderMessage({ kind: 'tool', callId: CallId('call-1') })).toBe(false)
    expect(isFounderMessage({ kind: 'plugin', plugin: 'test' })).toBe(false)
  })

  it('rejects a founder value other than the literal true at the type level', () => {
    // @ts-expect-error founder must be the literal `true`, never `false`
    const rejectedFalse: MessageSourceMap['user'] = { kind: 'user', founder: false }
    // @ts-expect-error founder must be the literal `true`, never the string "true"
    const rejectedString: MessageSourceMap['user'] = { kind: 'user', founder: 'true' }
    expect(rejectedFalse).toBeDefined()
    expect(rejectedString).toBeDefined()
  })
})

describe('isMechanicalContextSource', () => {
  it('is true for the runtime-context snapshot plugin id', () => {
    expect(isMechanicalContextSource({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })).toBe(true)
  })

  it('is false for a different plugin id, even one that also steers (hook steering)', () => {
    expect(isMechanicalContextSource({ kind: 'plugin', plugin: '@deepseek-ai/dsh-hooks-claude-code' })).toBe(false)
  })

  it('is true for the skill catalog', () => {
    expect(isMechanicalContextSource({ kind: 'skill-catalog', form: 'catalog', entries: [] })).toBe(true)
  })

  it('is true for agent-instructions reconciliation', () => {
    expect(isMechanicalContextSource({ kind: 'agent-instructions', form: 'instructions', changes: [] })).toBe(true)
  })

  it('is false for a mailbox relay (outside-controlled content)', () => {
    expect(isMechanicalContextSource(mailboxRelaySource())).toBe(false)
  })

  it('is false for a subagent settlement notice (outside-controlled content)', () => {
    expect(isMechanicalContextSource(subagentSettledSource())).toBe(false)
  })

  it('is false for a bare user source', () => {
    expect(isMechanicalContextSource({ kind: 'user' })).toBe(false)
  })
})

describe('selectFounderAuthorityMessage', () => {
  function withSource(source: MessageSource): { source: MessageSource } {
    return { source }
  }

  it('returns undefined for an empty list', () => {
    const authority = selectFounderAuthorityMessage<{ source: MessageSource }>([])
    expect(authority).toBeUndefined()
  })

  it('returns the stamped message when it is followed by the runtime-context snapshot', () => {
    const stamped = withSource({ kind: 'user', founder: true })
    const snapshot = withSource({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })
    expect(selectFounderAuthorityMessage([stamped, snapshot])).toBe(stamped)
  })

  it('returns the mailbox relay when it follows a stamped message (denies, not skipped)', () => {
    const stamped = withSource({ kind: 'user', founder: true })
    const mailbox = withSource(mailboxRelaySource())
    expect(selectFounderAuthorityMessage([stamped, mailbox])).toBe(mailbox)
  })

  it('returns the later bare user message over an earlier stamped one', () => {
    const stamped = withSource({ kind: 'user', founder: true })
    const bare = withSource({ kind: 'user' })
    expect(selectFounderAuthorityMessage([stamped, bare])).toBe(bare)
  })
})
