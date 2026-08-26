/** The id/lock relation invariant: announced named ids must hold their locks. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as NamedSessionsInvariant from '../src/invariant.ts'
import {
  acquireNamedSessionLock,
  deriveNamedSessionId,
} from '../src/index.ts'

let home: string | undefined

afterEach(() => {
  if (home !== undefined) {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
  home = undefined
})

/** Point DSH_HOME at a fresh temp directory so checks probe a private artifact root. */
function useTempHome(): string {
  home = mkdtempSync(join(tmpdir(), 'dsh-named-sessions-invariant-'))
  process.env.DSH_HOME = home
  return home
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(NamedSessionsInvariant)
  return ctx
}

describe('named-sessions id/lock invariant', () => {
  it('accepts an announced derived id that holds its lock', async () => {
    useTempHome()
    const ctx = await setup()
    const lock = acquireNamedSessionLock('alpha')
    try {
      expect(() => { ctx.sessions.create(deriveNamedSessionId('alpha')) }).not.toThrow()
      expect(existsSync(lock.path)).toBe(true)
    } finally {
      lock.release()
    }
  })

  it('rejects an announced derived id announced without its held lock', async () => {
    useTempHome()
    const ctx = await setup()
    const id = deriveNamedSessionId('unlocked')
    expect(() => { ctx.sessions.create(id) }).toThrow(InvariantError)
    try {
      ctx.sessions.create(id)
    } catch (error) {
      expect((error as InvariantError).packageName).toBe('@deepseek-ai/dsh-named-sessions')
      expect((error as InvariantError).message).toContain('without its held per-name lock')
    }
  })

  it('rejects a named-prefixed id outside the derivation form', async () => {
    useTempHome()
    const ctx = await setup()
    expect(() => { ctx.sessions.create(SessionId('named-not-hex')) })
      .toThrow(InvariantError)
  })

  it('ignores ids outside the named-run derivation', async () => {
    useTempHome()
    const ctx = await setup()
    expect(() => { ctx.sessions.create() }).not.toThrow()
  })
})
