/**
 * Unit coverage for the `mailbox/await` durable event module: version
 * round-trip through snapshot and parse, rejection of an unsupported
 * version, and every malformed-payload rejection the schema enforces.
 * Mirrors `packages/subagent/subagent/tests/settlement.spec.ts`'s shape,
 * adapted: there is no fold-over-a-slice here (see `await-event.ts`'s module
 * doc for why), so every case decodes one payload directly.
 */

import { describe, expect, it } from 'vitest'
import {
  MAILBOX_AWAIT_EVENT_VERSION,
  parseMailboxAwaitEvent,
  snapshotMailboxAwaitEvent,
} from '../src/await-event.ts'

describe('mailbox await event', () => {
  it('round-trips a minimal snapshotted event through parse and rejects unsupported versions', () => {
    const minimal = snapshotMailboxAwaitEvent({
      outcome: 'reply',
      startedAt: 1_000,
      endedAt: 1_500,
      waitedMs: 500,
      messageCount: 2,
    })
    expect(minimal).toEqual({
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      startedAt: 1_000,
      endedAt: 1_500,
      waitedMs: 500,
      messageCount: 2,
    })
    expect(parseMailboxAwaitEvent(minimal)).toEqual(minimal)

    expect(parseMailboxAwaitEvent({
      version: MAILBOX_AWAIT_EVENT_VERSION + 1,
      outcome: 'reply',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    })).toBeUndefined()
  })

  it('round-trips an event carrying every optional field', () => {
    const full = snapshotMailboxAwaitEvent({
      outcome: 'timeout',
      traceId: 'trace-1',
      counterpart: 'other-seat',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
      refusalReason: 'declined',
      sentState: 'delivered',
      deliveredAt: 3,
      errorName: 'Error',
      errorMessage: 'boom',
    })
    expect(full).toEqual({
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'timeout',
      traceId: 'trace-1',
      counterpart: 'other-seat',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
      refusalReason: 'declined',
      sentState: 'delivered',
      deliveredAt: 3,
      errorName: 'Error',
      errorMessage: 'boom',
    })
    expect(parseMailboxAwaitEvent(full)).toEqual(full)
  })

  it.each(['reply', 'refused', 'timeout', 'aborted', 'error'] as const)(
    'round-trips outcome %s',
    (outcome) => {
      const data = snapshotMailboxAwaitEvent({
        outcome,
        startedAt: 1,
        endedAt: 2,
        waitedMs: 1,
        messageCount: 0,
      })
      expect(parseMailboxAwaitEvent(data)).toEqual(data)
    },
  )

  it.each(['delivered', 'claimed', 'pending', 'unknown'] as const)(
    'round-trips sentState %s',
    (sentState) => {
      const data = snapshotMailboxAwaitEvent({
        outcome: 'timeout',
        sentState,
        startedAt: 1,
        endedAt: 2,
        waitedMs: 1,
        messageCount: 0,
      })
      expect(parseMailboxAwaitEvent(data)).toEqual(data)
    },
  )

  it('rejects a snapshot input that is not losslessly JSON-serializable', () => {
    expect(() => snapshotMailboxAwaitEvent({
      outcome: 'error',
      startedAt: 1,
      endedAt: 2,
      waitedMs: Number.NaN,
      messageCount: 0,
    })).toThrow('not losslessly JSON-serializable')
  })

  it.each([
    ['string payload', 'invalid', 'payload must be an object'],
    ['null payload', null, 'payload must be an object'],
    ['array payload', [], 'payload must be an object'],
    ['missing version', {
      outcome: 'reply', startedAt: 1, endedAt: 2, waitedMs: 1, messageCount: 0,
    }, 'version must be a number'],
    ['string version', {
      version: '1', outcome: 'reply', startedAt: 1, endedAt: 2, waitedMs: 1, messageCount: 0,
    }, 'version must be a number'],
    ['unknown field', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
      extra: true,
    }, 'payload has unknown field "extra"'],
    ['missing outcome', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'outcome must be one of'],
    ['invalid outcome type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'outcome must be one of'],
    ['unsupported outcome value', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'bogus',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'outcome must be one of'],
    ['invalid sentState value', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'timeout',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
      sentState: 'bogus',
    }, 'sentState must be one of'],
    ['invalid traceId type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      traceId: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'traceId must be a string'],
    ['invalid counterpart type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      counterpart: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'counterpart must be a string'],
    ['invalid refusalReason type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'refused',
      refusalReason: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'refusalReason must be a string'],
    ['invalid deliveredAt type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'timeout',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
      deliveredAt: 'not-a-number',
    }, 'deliveredAt must be a number'],
    ['invalid errorName type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'error',
      errorName: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'errorName must be a string'],
    ['invalid errorMessage type', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'error',
      errorMessage: 7,
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'errorMessage must be a string'],
    ['missing startedAt', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      endedAt: 2,
      waitedMs: 1,
      messageCount: 0,
    }, 'startedAt must be a number'],
    ['invalid endedAt', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      startedAt: 1,
      endedAt: '2',
      waitedMs: 1,
      messageCount: 0,
    }, 'endedAt must be a number'],
    ['invalid waitedMs', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      startedAt: 1,
      endedAt: 2,
      waitedMs: '1',
      messageCount: 0,
    }, 'waitedMs must be a number'],
    ['invalid messageCount', {
      version: MAILBOX_AWAIT_EVENT_VERSION,
      outcome: 'reply',
      startedAt: 1,
      endedAt: 2,
      waitedMs: 1,
      messageCount: '0',
    }, 'messageCount must be a number'],
  ])('rejects a malformed persisted event: %s', (_case, data, detail) => {
    expect(() => parseMailboxAwaitEvent(data)).toThrow(detail)
  })
})
