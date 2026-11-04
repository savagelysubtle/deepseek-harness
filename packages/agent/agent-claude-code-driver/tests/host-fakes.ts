/**
 * Test doubles for the registry-routed (host seat) paths of the Claude Code driver: a fake subprocess
 * owner, a booted context, a registry row and binding builder, and a seat source that trusts the binding
 * (the real verifying source lives in the registry glue package and is tested there).
 */

import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { seatRowHash } from '@deepseek-ai/dsh-mailbox'
import type { OrgRegistrySeat, SeatBinding, SeatBindingOptions } from '@deepseek-ai/dsh-mailbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ClaudeCodeSeatSource } from '../src/index.ts'
import type { ClaudeCodeHostSeat } from '../src/seat-config.ts'
import { fakeChild, fakeClaudeBinary, tempDir } from './fakes.ts'

/** A subprocess owner that hands out fake children. */
export class FakeSubprocess extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(): SubprocessHandle {
    return fakeChild(4242)
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

/** The on-disk pieces a host-seat scenario needs. */
export interface HostWorld {
  readonly dshHome: string
  readonly stateDir: string
  readonly binary: string
  /** The one allowed binary directory. */
  readonly prefix: string
  /** The seat's pinned working directory (a realpath). */
  readonly cwd: string
}

/** A fresh harness home, attested fake binary under its own directory, and real working directory. */
export function hostWorld(): HostWorld {
  const dshHome = tempDir('cc-home-')
  const binary = fakeClaudeBinary()
  return { dshHome, stateDir: join(dshHome, 'claude-code'), binary, prefix: dirname(binary), cwd: tempDir('cc-work-') }
}

/** A valid host entry for the world, with overrides. */
export function hostSeat(world: HostWorld, overrides: Partial<ClaudeCodeHostSeat> = {}): ClaudeCodeHostSeat {
  return { model: 'haiku', role: 'mail-only', claude_path: world.binary, cwd: world.cwd, admit_from_ceiling: ['peer'], ...overrides }
}

/** A registry row routing a seat to the driver, pinned to the world's working directory. */
export function registryRow(world: HostWorld, overrides: Partial<OrgRegistrySeat> = {}): OrgRegistrySeat {
  return { cwd: world.cwd, driver: 'claude-code', admit_from: ['peer'], admit_sender_classes: ['seat'], ...overrides }
}

/** The binding the bridge would hand the driver for a row. */
export function bindingFor(seat: string, row: OrgRegistrySeat): SeatBinding {
  return { seat, rowHash: seatRowHash(row), row }
}

/** `agentOptions` carrying a binding (the neutral key the mailbox package declares). */
export function optionsWith(binding: SeatBinding | undefined): AgentOptions & SeatBindingOptions {
  return binding === undefined ? {} : { seatBinding: binding }
}

/** A seat source that trusts the binding it is given; records every request. */
export function trustingSource(): ClaudeCodeSeatSource & { readonly requests: unknown[] } {
  const requests: unknown[] = []
  return {
    requests,
    resolve: (request) => {
      requests.push(request)
      if (request.binding === undefined) throw new Error('fake source: no binding')
      return { seat: request.binding.seat, row: request.binding.row }
    },
  }
}
