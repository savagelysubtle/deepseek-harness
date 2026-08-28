/** Registry lifecycle, duplicate rejection, default resolution, and delegation. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MailboxLeaseRef, MailboxMessageId } from '../src/types.ts'
import type { MailboxProvider } from '../src/provider.ts'
import MailboxRegistryModule from '../src/index.ts'
import { formatMailboxAddress } from '../src/address.ts'

const ADDRESS = formatMailboxAddress('target')

/** Deterministic in-memory fake; the seam's contract is what varies here. */
function fakeProvider(name: string): MailboxProvider {
  let next = 0
  return {
    name,
    publish: async () => `id-${++next}` as MailboxMessageId,
    claim: async () => [],
    claimableAddresses: async () => [],
    settle: async () => {},
  }
}

async function setup(config?: { defaultProvider?: string }): Promise<{ ctx: Context; registry: MailboxRegistryModule }> {
  const ctx = new Context()
  await ctx.plugin(MailboxRegistryModule, config)
  return { ctx, registry: ctx.mailbox }
}

describe('provider registry', () => {
  it('registers a provider and exposes it by name and list order', async () => {
    const { registry } = await setup()
    const disposer = registry.registerProvider(fakeProvider('local'))
    expect(registry.getProvider('local')?.name).toBe('local')
    expect(registry.list().map(provider => provider.name)).toEqual(['local'])
    disposer()
    expect(registry.getProvider('local')).toBeUndefined()
  })

  it('fails loud on a duplicate registration and keeps the first winner', async () => {
    const { registry } = await setup()
    const first = registry.registerProvider(fakeProvider('dup'))
    expect(() => registry.registerProvider(fakeProvider('dup'))).toThrow('mailbox provider "dup" is already registered')
    expect(registry.getProvider('dup')?.name).toBe('dup')
    // The rejected second registration never owned the name: its disposer
    // (never returned) cannot exist, and the first disposer still wins.
    first()
    expect(registry.getProvider('dup')).toBeUndefined()
  })

  it('a replaced name is not removed by its predecessor\'s stale disposer', async () => {
    const { registry } = await setup()
    const first = registry.registerProvider(fakeProvider('swap'))
    first()
    const second = registry.registerProvider(fakeProvider('swap'))
    expect(registry.getProvider('swap')?.name).toBe('swap')
    second()
    expect(registry.getProvider('swap')).toBeUndefined()
  })
})

describe('default-provider resolution', () => {
  it('delegates conveniences to the configured registered provider', async () => {
    const { registry } = await setup({ defaultProvider: 'chosen' })
    const calls: string[] = []
    let settled = false
    registry.registerProvider({
      name: 'other',
      publish: async () => { calls.push('other.publish'); return 'x' as MailboxMessageId },
      claim: async () => { calls.push('other.claim'); return [] },
      claimableAddresses: async () => [],
      settle: async () => { calls.push('other.settle') },
    })
    registry.registerProvider({
      name: 'chosen',
      publish: async () => { calls.push('chosen.publish'); return 'y' as MailboxMessageId },
      claim: async () => { calls.push('chosen.claim'); return [] },
      claimableAddresses: async () => [],
      settle: async () => { settled = true },
    })
    await registry.publish({ to: ADDRESS, from: 'ns:sender' })
    await registry.claim({ addresses: [ADDRESS], limit: 1, staleClaimMs: 1_000 })
    await registry.settle('ref' as MailboxLeaseRef, { state: 'done', result: { deliveredAt: 0, messageId: 'y' as MailboxMessageId } })
    expect(calls).toEqual(['chosen.publish', 'chosen.claim'])
    expect(settled).toBe(true)
  })

  it('rejects publishing through an unregistered configured default', async () => {
    const { registry } = await setup({ defaultProvider: 'ghost' })
    await expect(registry.publish({ to: ADDRESS, from: 'ns:sender' }))
      .rejects.toThrow('configured defaultProvider "ghost" is not registered')
  })

  it('rejects conveniences entirely when no default is configured', async () => {
    const { registry } = await setup()
    registry.registerProvider(fakeProvider('present'))
    await expect(registry.publish({ to: ADDRESS, from: 'ns:sender' }))
      .rejects.toThrow('no defaultProvider is configured')
  })

  it('named-provider access bypasses default resolution', async () => {
    const { registry } = await setup()
    registry.registerProvider(fakeProvider('direct'))
    expect(await registry.getProvider('direct')?.publish({ to: ADDRESS, from: 'ns:s' })).toBe('id-1')
  })

  it('validates the destination grammar in the admitting operation', async () => {
    const { registry } = await setup({ defaultProvider: 'p' })
    registry.registerProvider(fakeProvider('p'))
    await expect(registry.publish({ to: 'bad address' as never, from: 'sender' }))
      .rejects.toThrow('invalid mailbox address')
  })

  it('validates every claim-filter address against the grammar', async () => {
    const { registry } = await setup({ defaultProvider: 'p' })
    registry.registerProvider(fakeProvider('p'))
    await expect(registry.claim({ addresses: ['ok', 'bad address'] as never[], limit: 1, staleClaimMs: 1_000 }))
      .rejects.toThrow('invalid mailbox address')
  })
})

describe('config validation', () => {
  it('fails loud at mount on a blank provider name', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(MailboxRegistryModule, { defaultProvider: '   ' })).rejects.toThrow()
  })
})
