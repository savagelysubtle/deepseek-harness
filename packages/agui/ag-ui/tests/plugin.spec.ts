/**
 * `apply()` wiring tests: a real Cordis context supplying `sessions`, mounted
 * directly (not through `ctx.plugin`, which would apply the `Config` schema's
 * own defaults before `apply` ever sees them) so `resolveOptions`'s `??`
 * fallbacks are exercised on both sides — explicit config here, schema
 * defaults are `auth.spec.ts`'s concern.
 */
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
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
    await plugin.apply(context, {
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
    await plugin.apply(context, { port: 0, bearerToken: 'minimal-config-secret' })

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
    await plugin.apply(context, { port: 0, bearerToken: 'disposal-config-secret' })

    // Exercises the `ctx.effect(() => async () => { await server.dispose() })`
    // registration end to end: disposing the fiber runs the disposer.
    await expect(context.fiber.dispose()).resolves.toBeUndefined()
    context = undefined
  })

  it('mounts the plugin, binds its own listener, and resolves a real thread while 404ing an unknown one', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    // `apply()` now awaits `server.listen()` itself (see index.ts), so by the
    // time this resolves the socket is already bound — the fetches below are
    // the proof. The process-wide registry is only used to read back the
    // ephemeral port a wire-level fetch could not otherwise discover.
    await plugin.apply(context, { port: 0, bearerToken: 'resolver-config-secret-1' })

    const [server] = listAgUiServers()
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

  it('rejects when the configured port is already bound, naming the host and port', async () => {
    context = new Context()
    await context.plugin(SessionStore)

    const occupied = createNetServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => { resolve() })
    })
    const port = (occupied.address() as AddressInfo).port

    try {
      await expect(
        plugin.apply(context, { host: '127.0.0.1', port, bearerToken: 'listen-failure-secret' }),
      ).rejects.toThrow(`127.0.0.1:${port}`)

      // The failed server must not linger in the process-wide registry: a
      // leaked, never-listening instance would otherwise shadow later tests'
      // `listAgUiServers()` reads.
      expect(listAgUiServers()).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => { occupied.close(() => { resolve() }) })
    }
  })

  it('closes its listener on dispose, releasing the port for reuse', async () => {
    context = new Context()
    await context.plugin(SessionStore)
    await plugin.apply(context, { port: 0, bearerToken: 'dispose-release-secret' })

    const [server] = listAgUiServers()
    const port = server!.port

    await context.fiber.dispose()
    context = undefined

    // Proof the socket was actually released: a plain listener can rebind the
    // exact same port immediately after dispose.
    const reclaimed = createNetServer()
    try {
      await new Promise<void>((resolve, reject) => {
        reclaimed.once('error', reject)
        reclaimed.listen(port, '127.0.0.1', () => { resolve() })
      })
    } finally {
      await new Promise<void>((resolve) => { reclaimed.close(() => { resolve() }) })
    }
  })
})

describe('ag-ui plugin mounted through ctx.plugin(...) — the production path', () => {
  // Every test above calls `plugin.apply(ctx, config)` directly so it can
  // supply explicit config and exercise `resolveOptions`'s `??` defaults
  // without `ctx.plugin`'s own `Config` schema defaults pre-filling them
  // first (see the file header). But `ctx.plugin(...)` — not a bare
  // `apply()` call — is how every real composition mounts a plugin, and it
  // is specifically `ctx.plugin` that funnels a rejected `apply()` promise
  // into the fiber's own failure path: `Fiber._execute` unwraps the
  // returned promise as a thenable effect (`effect.then(safeCollect)`,
  // vendor/cordis/src/fiber.ts ~373), `Fiber._reload` catches the rejection
  // and stores it as the fiber's own `_error` (~646-666), and `Fiber.await()`
  // rethrows that `_error` to whoever awaits the mount (~704-710) — which is
  // exactly what `Registry.plugin()`'s returned thenable wires `await
  // ctx.plugin(...)` to (registry.ts:316-336). These two tests mount through
  // that real path instead of calling `apply()` directly, so the listen-bind
  // fix is proven reachable from production, not only from this file's
  // direct-call shape.
  it('surfaces a listen failure through ctx.plugin(...), the production mount path', async () => {
    context = new Context()
    await context.plugin(SessionStore)

    const occupied = createNetServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => { resolve() })
    })
    const port = (occupied.address() as AddressInfo).port

    try {
      await expect(
        context.plugin(plugin, { host: '127.0.0.1', port, bearerToken: 'ctx-plugin-listen-failure-secret' }),
      ).rejects.toThrow(`127.0.0.1:${port}`)

      // Same invariant as the direct-call failure test: nothing lingers in
      // the process-wide registry past a failed mount.
      expect(listAgUiServers()).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => { occupied.close(() => { resolve() }) })
    }
  })

  it('binds its listener through ctx.plugin(...) and releases the port on dispose', async () => {
    context = new Context()
    await context.plugin(SessionStore)

    const fiber = await context.plugin(plugin, { port: 0, bearerToken: 'ctx-plugin-bind-secret' })

    const [server] = listAgUiServers()
    const port = server!.port

    // Proof the socket is really bound while the plugin is mounted: a plain
    // listener cannot rebind the same port and fails with EADDRINUSE.
    const rebindAttempt = createNetServer()
    await expect(
      new Promise<void>((resolve, reject) => {
        rebindAttempt.once('error', reject)
        rebindAttempt.listen(port, '127.0.0.1', () => { resolve() })
      }),
    ).rejects.toThrow(/EADDRINUSE/)

    await fiber.dispose()

    // Proof the socket was released: the same port can now be rebound.
    const reclaimed = createNetServer()
    try {
      await new Promise<void>((resolve, reject) => {
        reclaimed.once('error', reject)
        reclaimed.listen(port, '127.0.0.1', () => { resolve() })
      })
    } finally {
      await new Promise<void>((resolve) => { reclaimed.close(() => { resolve() }) })
    }
  })
})
