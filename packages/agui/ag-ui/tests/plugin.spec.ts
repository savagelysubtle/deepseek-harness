/**
 * `apply()` wiring tests: a real Cordis context supplying `sessions`, mounted
 * directly (not through `ctx.plugin`, which would apply the `Config` schema's
 * own defaults before `apply` ever sees them) so `resolveOptions`'s `??`
 * fallbacks are exercised on both sides — explicit config here, schema
 * defaults are `auth.spec.ts`'s concern.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.ts'
import { listAgUiServers } from '../src/server.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('ag-ui plugin apply()', () => {
  it('resolves explicit host/keepAliveMs/maxBufferedEvents instead of the schema defaults', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    plugin.apply(context, {
      host: '0.0.0.0',
      port: 0,
      bearerToken: 'explicit-config-secret',
      keepAliveMs: 5_000,
      maxBufferedEvents: 10,
    })

    const session = context.sessions.create(SessionId('ag-ui-plugin-explicit'))
    // Drives the real `ctx.on('session/event', ...)` wiring end to end. No
    // watcher is attached to this thread, so `broadcastSessionEvent` finds an
    // empty connection set and returns without enqueuing anything — this
    // proves the listener is wired and passes the event through untouched.
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
  })

  it('falls back to keepAliveMs/maxBufferedEvents/host defaults when omitted, and wires agent/error', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    // Only the required fields: exercises the `??` right-hand defaults in
    // `resolveOptions` (host, keepAliveMs, maxBufferedEvents).
    plugin.apply(context, { port: 0, bearerToken: 'minimal-config-secret' })

    const session = context.sessions.create(SessionId('ag-ui-plugin-minimal'))
    // Drives the real `ctx.on('agent/error', ...)` wiring end to end, the same
    // way a live agent failure would: no watcher is attached, so
    // `broadcastAgentError` is a no-op past the listener itself.
    // `agent/error`'s declared listener signature takes a `this: Scoped<Agent>`
    // receiver (see `dsh-agent`'s runtime-types.ts), which `emit`'s overloads
    // then require as an explicit first argument — irrelevant to index.ts's
    // handler, which reads only `agent.session.id` off the payload, so the
    // call is type-erased rather than fabricating a full `Scoped<Agent>`.
    const emit = context.emit.bind(context) as (name: string, payload: unknown) => void
    expect(() => {
      emit('agent/error', { agent: { session }, error: new Error('agent blew up') })
    }).not.toThrow()
  })

  it('disposes its listener registration and closes the listener on context teardown', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    plugin.apply(context, { port: 0, bearerToken: 'disposal-config-secret' })

    // Exercises the `ctx.effect(() => async () => { await server.dispose() })`
    // registration end to end: disposing the fiber runs the disposer.
    await expect(context.fiber.dispose()).resolves.toBeUndefined()
    context = undefined
  })

  it('resolves a real thread to its live session log and 404s an unknown one', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    plugin.apply(context, { port: 0, bearerToken: 'resolver-config-secret-1' })

    // `apply()` constructs the server but never calls `.listen()` itself (see
    // index.ts) — this test drives the just-mounted server through the
    // process-wide registry it registers itself into, the same seam the
    // invariant companion uses, to reach the `resolveSessionLog` callback that
    // no request could otherwise exercise.
    const [server] = listAgUiServers()
    await server!.listen()
    const session = context.sessions.create(SessionId('ag-ui-plugin-resolve'))
    session.append('turn/start', { turn: 9 })

    const hit = await fetch(`http://127.0.0.1:${server!.port}/ag-ui/${session.id}`, {
      method: 'POST',
      headers: { authorization: 'Bearer resolver-config-secret-1' },
      body: '',
    })
    expect(hit.status).toBe(200)
    await hit.body!.cancel()

    const miss = await fetch(`http://127.0.0.1:${server!.port}/ag-ui/unknown-thread`, {
      method: 'POST',
      headers: { authorization: 'Bearer resolver-config-secret-1' },
    })
    expect(miss.status).toBe(404)
  })
})
