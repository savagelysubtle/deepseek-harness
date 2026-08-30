/**
 * The host stream's relays onto the `host/agent-error` frame — the documented
 * outlet for live failures with no turn position. `session/persistence-failed`
 * rides the context bus — never the session log, which is the thing that
 * failed — and `mailbox/refused` carries an admission refusal to the refused
 * sender's session, since the bridge's logger warning has no sink in this
 * deployment. This spec owns both frame mappings and their human-readable
 * messages; the emission sides are session-persistence's and the bridge's.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
import type { HostFrame } from '../src/api/index.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`host-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{ ctx: Context; api: ReturnType<typeof createApiProxy> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  // Host-stream opener reads the committed-workspace baseline; the stub
  // suffices — the real workspace composition is api-proxy-workspace.spec's.
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  return { ctx, api: createApiProxy(ctx, DEFAULTS) }
}

/** Drain `count` host frames matching `types` while `run` emits, then stop. */
async function collectHost(
  api: ReturnType<typeof createApiProxy>,
  types: string[],
  count: number,
  run: () => void,
): Promise<HostFrame[]> {
  const abort = new AbortController()
  const frames: HostFrame[] = []
  const stream = api.events.host(request({}), abort.signal)
  const consume = (async () => {
    for await (const frame of stream) {
      if (!types.includes(frame.payload.type)) continue
      frames.push(frame.payload)
      if (frames.length >= count) abort.abort()
    }
  })()
  run()
  await consume
  return frames
}

describe('host stream: session/persistence-failed relay', () => {
  it('relays a stale session as host/agent-error with the reason and the reload remedy', async () => {
    const { ctx, api } = await harness()
    const frames = await collectHost(api, ['host/agent-error'], 1, () => {
      ctx.emit('session/persistence-failed', {
        sessionId: SessionId('persist-stale'),
        error: new Error('session "persist-stale" changed on disk since this process last read it (expected gen-1, found gen-2)'),
        stale: true,
      })
    })

    expect(frames).toEqual([{
      type: 'host/agent-error',
      sessionId: 'persist-stale',
      message: 'Session persistence failed: session "persist-stale" changed on disk since this process last read it '
        + '(expected gen-1, found gen-2). This session is stale — its log advanced on disk outside this process, '
        + 'so it can no longer be written to from here. Reload the session from disk to continue; '
        + 'it cannot be repaired in place.',
    }])
  })

  it('relays a non-stale failure with the buffered-retry remedy', async () => {
    const { ctx, api } = await harness()
    const frames = await collectHost(api, ['host/agent-error'], 1, () => {
      ctx.emit('session/persistence-failed', {
        sessionId: SessionId('persist-transient'),
        error: new Error('disk full'),
        stale: false,
      })
    })

    expect(frames).toEqual([{
      type: 'host/agent-error',
      sessionId: 'persist-transient',
      message: 'Session persistence failed: disk full. Events written after this failure are buffered and retry '
        + 'with the session\'s next write; if failures continue, reload the session from disk.',
    }])
  })
})

describe('host stream: mailbox/refused relay', () => {
  it('relays a refusal to the sender session as host/agent-error, naming who mailed whom and why', async () => {
    const { ctx, api } = await harness()
    const frames = await collectHost(api, ['host/agent-error'], 1, () => {
      ctx.emit('mailbox/refused', {
        from: 'alice',
        to: 'batman',
        reason: 'test-boundary-violation: test seat "alice" may not mail "batman" (not marked test: true)',
      })
    })

    // The sender's session id is derived the way the bridge routes a seat:
    // the address IS the session name. The bridge's logger warning has no
    // sink in this deployment, so this frame is where the operator reads it.
    expect(frames).toEqual([{
      type: 'host/agent-error',
      sessionId: deriveNamedSessionId('alice'),
      message: 'Mail from "alice" to "batman" was refused by the mailbox bridge: '
        + 'test-boundary-violation: test seat "alice" may not mail "batman" (not marked test: true)',
    }])
  })

  it('reports nothing for a sender with no session — guest or unparseable — while still relaying real seats', async () => {
    const { ctx, api } = await harness()
    // Each dead-end refusal is emitted BEFORE the seat refusal that serves as
    // the control: the stream is demonstrably open and relaying, so a frame
    // for a sessionless sender would have arrived ahead of it.
    const frames = await collectHost(api, ['host/agent-error'], 1, () => {
      ctx.emit('mailbox/refused', {
        from: 'guest:claude-code',
        to: 'batman',
        reason: 'sender-not-admitted',
      })
      ctx.emit('mailbox/refused', {
        from: 'robin',
        to: 'batman',
        reason: 'sender-not-admitted',
      })
      ctx.emit('mailbox/refused', {
        from: 'no separator',
        to: 'batman',
        reason: 'sender-not-admitted',
      })
    })

    expect(frames).toEqual([{
      type: 'host/agent-error',
      sessionId: deriveNamedSessionId('robin'),
      message: 'Mail from "robin" to "batman" was refused by the mailbox bridge: sender-not-admitted',
    }])
  })
})
