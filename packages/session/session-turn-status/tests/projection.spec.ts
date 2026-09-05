/**
 * The `turnStatus` projection unit: mounting the plugin beside the projection
 * registry serves the open bit and last close cause folded from
 * `turn/start`/`turn/end` boundaries; compositions without the registry are
 * unaffected; unmounting the plugin removes the key (HMR safety). SWD-120's
 * core claim is pinned here directly: a user stop and a crash-repair
 * interruption fold to different, distinguishable causes, and a turn that
 * merely STARTED (the crash-but-not-reloaded gotcha) folds to `open: true`
 * with no cause at all — never anything that could be mistaken for a
 * deliberate stop.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionTurnStatusPlugin from '@deepseek-ai/dsh-session-turn-status'
import { sessionTurnStatusProjectionDefinition } from '@deepseek-ai/dsh-session-turn-status/src/projection.ts'
import type { SessionTurnStatusProjection } from '@deepseek-ai/dsh-session-turn-status/types'

async function harness(withPlugin: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlugin) await ctx.plugin(SessionTurnStatusPlugin)
  return { ctx, session: ctx.sessions.create(SessionId('turn-status')) }
}

function status(ctx: Context, session: Session): SessionTurnStatusProjection {
  return ctx.sessionProjections.snapshot(session).values.turnStatus as SessionTurnStatusProjection
}

describe('turnStatus projection unit (registry drive)', () => {
  it('serves the closed, causeless default on the empty log', async () => {
    const { ctx, session } = await harness(true)
    expect(status(ctx, session)).toEqual({ open: false, cause: null })
  })

  it('reports open with no cause while a turn is executing', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    expect(status(ctx, session)).toEqual({ open: true, cause: null })
  })

  it('distinguishes a deliberate user stop from every other cause', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(status(ctx, session)).toEqual({
      open: false,
      cause: { kind: 'aborted', cause: { kind: 'user' } },
    })
  })

  it('distinguishes a programmatic cancellation by its sub-cause', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'permission denied' } },
    })
    expect(status(ctx, session)).toEqual({
      open: false,
      cause: { kind: 'aborted', cause: { kind: 'hook', reason: 'permission denied' } },
    })
  })

  it('distinguishes a crash-repair interruption from a deliberate stop', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    // This is the exact synthetic closer `interruptedTurnClosers` appends on
    // reload — the durable evidence a crash left behind.
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    const value = status(ctx, session)
    expect(value.cause).toEqual({ kind: 'interrupted' })
    expect(value.cause?.kind).not.toBe('aborted')
  })

  it('never reports the crash-but-not-yet-reloaded gotcha as a stop: a dangling turn/start alone stays open with no cause', async () => {
    const { ctx, session } = await harness(true)
    // No repair has run: the log holds only the dangling turn/start a real
    // crash would leave behind (repair happens at load time, in dsh-session,
    // not here). This unit must fold exactly what the log contains.
    session.append('turn/start', { turn: 7 })
    const value = status(ctx, session)
    expect(value.open).toBe(true)
    expect(value.cause).toBeNull()
  })

  it('reports a terminal error with its code and message', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'provider unavailable', code: 'UNAVAILABLE' } },
    })
    expect(status(ctx, session)).toEqual({
      open: false,
      cause: { kind: 'error', code: 'UNAVAILABLE', message: 'provider unavailable' },
    })
  })

  it('reports completion, blocked, and max-tokens verbatim', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(status(ctx, session).cause).toEqual({ kind: 'completed' })

    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } })
    expect(status(ctx, session).cause).toEqual({ kind: 'blocked' })

    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'max-tokens' } })
    expect(status(ctx, session).cause).toEqual({ kind: 'max-tokens' })
  })

  it('only reflects the most recently closed turn, never a stale cause from an earlier one', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(status(ctx, session).cause).toEqual({ kind: 'aborted', cause: { kind: 'user' } })

    // A fresh turn opening must immediately hide the old cause (open
    // suppresses it), and the next close must report only its own reason.
    session.append('turn/start', { turn: 2 })
    expect(status(ctx, session)).toEqual({ open: true, cause: null })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(status(ctx, session)).toEqual({ open: false, cause: { kind: 'completed' } })
  })

  it('notifies the change feed with the causing seq on turn/end', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    session.append('turn/start', { turn: 1 })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(changes.map(c => c.key)).toEqual(['turnStatus', 'turnStatus'])
    expect(changes.at(-1)).toMatchObject({ seq: end.seq, value: { open: false, cause: { kind: 'completed' } } })
  })

  it('registers nothing without the projection registry composed (no throw, fiber stays pending)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTurnStatusPlugin)
    const session = ctx.sessions.create(SessionId('no-registry'))
    // No registry mounted: the plugin's injected fiber stays pending and
    // nothing throws when the session is used.
    session.append('turn/start', { turn: 1 })
    expect(ctx.get('sessionProjections')).toBeUndefined()
  })

  it('has no turnStatus key without the plugin, and drops it when the plugin unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('turnStatus' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionTurnStatusPlugin)
    session.append('turn/start', { turn: 1 })
    expect(status(ctx, session)).toEqual({ open: true, cause: null })
    await fiber.dispose()
    expect('turnStatus' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('exports the raw unit definition unchanged', () => {
    expect(sessionTurnStatusProjectionDefinition.key).toBe('turnStatus')
    expect(sessionTurnStatusProjectionDefinition.stateVersion).toBe(1)
  })
})
