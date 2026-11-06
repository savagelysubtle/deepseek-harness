/**
 * Shared test doubles for the registry glue: a fake `mailboxSeatRows` service (the bridge's, without the
 * bridge), a booted context, an attested fake `claude` binary, and mailbox mail. The real binary and the
 * SDK are never started.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { forbiddenEnvPresent } from '@deepseek-ai/dsh-agent-claude-code-driver'
import type { ClaudeCodeHostSeat } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { seatDriverKey, seatRowHash } from '@deepseek-ai/dsh-mailbox'
import type { OrgRegistrySeat, SeatBinding } from '@deepseek-ai/dsh-mailbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SeatRowsService } from '../src/index.ts'

const tempDirs: string[] = []

/** A fresh temporary directory, removed by {@link cleanTempDirs}. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory {@link tempDir} made. */
export function cleanTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Unset every environment variable the driver forbids in the host environment (undone by `vi.unstubAllEnvs`). */
export function cleanHostEnv(): void {
  for (const name of forbiddenEnvPresent(process.env)) vi.stubEnv(name, undefined)
}

/** A private executable standing in for the claude binary. */
function fakeClaudeBinary(): string {
  const dir = tempDir('cc-registry-bin-')
  chmodSync(dir, 0o700)
  const file = join(dir, 'claude')
  writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}

/** The on-disk pieces of one scenario. */
export interface World {
  readonly dshHome: string
  readonly binary: string
  readonly cwd: string
}

/** A harness home, an attested fake binary and a working directory. */
export function world(): World {
  return { dshHome: tempDir('cc-registry-home-'), binary: fakeClaudeBinary(), cwd: tempDir('cc-registry-work-') }
}

/** A valid host entry for the world. */
export function hostSeat(w: World, overrides: Partial<ClaudeCodeHostSeat> = {}): ClaudeCodeHostSeat {
  return { model: 'haiku', role: 'mail-only', claude_path: w.binary, cwd: w.cwd, admit_from_ceiling: ['peer'], ...overrides }
}

/** The binary directory a host entry's path must lie under. */
export function prefixOf(w: World): string {
  return dirname(w.binary)
}

/** A registry row routing a seat to the driver. */
export function row(w: World, overrides: Partial<OrgRegistrySeat> = {}): OrgRegistrySeat {
  return { cwd: w.cwd, driver: 'claude-code', admit_from: ['peer'], admit_sender_classes: ['seat'], ...overrides }
}

/** The binding the bridge would hand the driver for a row. */
export function binding(seat: string, seatRow: OrgRegistrySeat): SeatBinding {
  return { seat, rowHash: seatRowHash(seatRow), row: seatRow }
}

/** A fake `mailboxSeatRows` service over a mutable table of rows. */
export function fakeRows(initial: Record<string, OrgRegistrySeat>): SeatRowsService & { table: Record<string, OrgRegistrySeat> } {
  const table = { ...initial }
  return {
    table,
    current: (seat) => {
      const found = Object.hasOwn(table, seat) ? table[seat] : undefined
      if (found === undefined) return undefined
      return {
        rowHash: seatRowHash(found),
        driver: seatDriverKey(found),
        admit_from: found.admit_from ?? [],
        admit_sender_classes: found.admit_sender_classes ?? [],
      }
    },
  }
}

/** A subprocess owner that hands out fake children (nothing in these specs spawns). */
export class FakeSubprocess extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(): SubprocessHandle {
    return {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: undefined,
      collected: {},
      done: new Promise(() => {}),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    } as unknown as SubprocessHandle
  }
}

/** The fake stand-in for the mailbox bridge: a plugin that only provides the row service, as the real bridge does. */
export function fakeBridge(rows: SeatRowsService): (ctx: Context) => void {
  return function fakeMailboxBridge(ctx: Context): void {
    ctx.provide('mailboxSeatRows' as never, rows as never)
  }
}

/** A context with the session store, agent registry and fake subprocess owner. */
export async function bootedContext(): Promise<Context> {
  const ctx = new Context()
  const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeSubprocess)
  return ctx
}

/** Mailbox relay mail as the bridge delivers it. */
export function mail(from: string, messageId: string, source: Record<string, unknown> = {}) {
  return createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'mailbox', form: 'relay', address: 'ops', from, messageId, senderClass: 'seat', ...source } as never,
  })
}
