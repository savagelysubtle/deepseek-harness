import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import { AgUiServer } from '../src/server.ts'
import { apply as companionApply, frameRelationViolation } from '../src/invariant.ts'
import * as invariantService from '@deepseek-ai/dsh-invariants'

const servers: AgUiServer[] = []
let context: Context | undefined

afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose()
  await context?.fiber.dispose()
  context = undefined
})

function ev(type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent {
  return { type, seq: 1, time: 0, data } as unknown as SessionEvent
}

describe('frameRelationViolation', () => {
  it('accepts a well-formed open/close sequence', () => {
    expect(frameRelationViolation(false, { type: 'RUN_STARTED', threadId: 't', runId: 'r' })).toBeUndefined()
    expect(frameRelationViolation(true, { type: 'RUN_FINISHED', threadId: 't', runId: 'r' })).toBeUndefined()
    expect(frameRelationViolation(true, { type: 'RUN_ERROR', message: 'x' })).toBeUndefined()
    expect(frameRelationViolation(true, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'd' })).toBeUndefined()
  })

  it('rejects frame types outside the AG-UI union', () => {
    const impostor = { type: 'SESSION_EVENT', leak: true } as unknown as Parameters<typeof frameRelationViolation>[1]
    expect(frameRelationViolation(false, impostor)).toContain('outside the AG-UI event union')
  })

  it('rejects RUN_STARTED while a run is open and closings without an open run', () => {
    expect(frameRelationViolation(true, { type: 'RUN_STARTED', threadId: 't', runId: 'r' }))
      .toContain('already open')
    expect(frameRelationViolation(false, { type: 'RUN_FINISHED', threadId: 't', runId: 'r' }))
      .toContain('no open run')
    expect(frameRelationViolation(false, { type: 'RUN_ERROR', message: 'x' }))
      .toContain('no open run')
  })
})

describe('invariant companion wiring', () => {
  it('observes live traffic without failing on a well-formed run', async () => {
    // Manual topology: the focused invariant suite owns its service mounts.
    context = new Context()
    await context.plugin(invariantService.default)
    await context.plugin({ name: 'ag-ui-invariant-under-test', inject: ['invariants'], apply: companionApply })

    const logs = new Map([[sessionIdOf('s-inv'), { events: [] as SessionEvent[] }]])
    const server = new AgUiServer(
      { host: '127.0.0.1', port: 0, bearerToken: 'token-value-1', keepAliveMs: 15_000, maxBufferedEvents: 64 },
      threadId => logs.get(threadId)?.events,
      undefined,
    )
    servers.push(server)
    await server.listen()
    // The companion installed BEFORE this server existed; the creation
    // subscription must have attached to it already.
    const response = await fetch(`http://127.0.0.1:${server.port}/ag-ui/s-inv`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-value-1' },
      body: '',
    })
    void response
    server.broadcastSessionEvent(sessionIdOf('s-inv'), ev('turn/start', { turn: 1 }))
    server.broadcastSessionEvent(sessionIdOf('s-inv'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await new Promise<void>((resolve) => { setImmediate(resolve); setImmediate(resolve) })
  })

  it('notifies frame observers exactly once per emitted frame', async () => {
    // Manual topology: the focused invariant suite owns its service mounts.
    context = new Context()
    await context.plugin(invariantService.default)
    await context.plugin({ name: 'ag-ui-invariant-under-test', inject: ['invariants'], apply: companionApply })

    const logs = new Map([[sessionIdOf('s-once'), { events: [] as SessionEvent[] }]])
    const server = new AgUiServer(
      { host: '127.0.0.1', port: 0, bearerToken: 'token-value-1', keepAliveMs: 15_000, maxBufferedEvents: 64 },
      threadId => logs.get(threadId)?.events,
      undefined,
    )
    servers.push(server)
    await server.listen()
    // A doubled notification would corrupt every bracket tracker: RUN_STARTED
    // observed twice reads as a protocol violation even though the wire saw
    // one frame. The acceptance-time notification is the only one.
    const seen: string[] = []
    server.onFrame((_label, frame) => { seen.push(frame.type) })
    const response = await fetch(`http://127.0.0.1:${server.port}/ag-ui/s-once`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-value-1' },
      body: '',
    })
    void response
    server.broadcastSessionEvent(sessionIdOf('s-once'), ev('turn/start', { turn: 1 }))
    server.broadcastSessionEvent(sessionIdOf('s-once'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await new Promise<void>((resolve) => { setImmediate(resolve); setImmediate(resolve) })
    expect(seen.filter(type => type === 'RUN_STARTED')).toHaveLength(1)
    expect(seen.filter(type => type === 'RUN_FINISHED')).toHaveLength(1)
  })
})
