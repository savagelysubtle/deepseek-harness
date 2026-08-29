/**
 * The host stream's relay of the persistence coordinator's caller-less drain
 * failure. `session/persistence-failed` rides the context bus — never the
 * session log, which is the thing that failed — and lands on the existing
 * `host/agent-error` frame, the documented outlet for live failures with no
 * turn position, so the UI renders it with no client-side work. This spec owns
 * the frame mapping and the reason-plus-remedy message; the emission side is
 * session-persistence's.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
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
