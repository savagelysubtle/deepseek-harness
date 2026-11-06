/**
 * Mail bridge seat-driver behaviour (OP #292, S3 step 3): registry rows pick
 * the driver, a non-default seat admits only what its row lists, a driver flip
 * is refused from the stored or live log, and a row change revokes the
 * resident that was composed under the old row. Registries are block-style
 * files written under `os.tmpdir()`; nothing here reads `~/.dsh`.
 */

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admitsMail, loadOrgRegistry, seatRowHash } from '@deepseek-ai/dsh-mailbox'
import * as bridge from '../src/index.ts'
import {
  CC_TARGET, cleanupHarnesses, makeDriverHarness, rewriteRegistry, stubAgent, writeRegistry,
} from './driver-harness.ts'
import type { RegistryRows } from './driver-harness.ts'

afterEach(cleanupHarnesses)

/** Roster used by most cases: a Claude Code `target`, plus the seats it may name. */
function ccRegistry(overrides: Partial<RegistryRows['rows']> = {}, extra: Partial<RegistryRows> = {}): RegistryRows {
  return {
    rows: { target: CC_TARGET, alice: [], ghost: [], ...overrides },
    edges: [['alice', 'target'], ['ghost', 'target']],
    ...extra,
  }
}

/** The first create/resume call, narrowed to its binding. */
function bindingOf(call: { readonly args: Readonly<Record<string, unknown>> } | undefined): {
  readonly seat: string
  readonly rowHash: string
  readonly row: Record<string, unknown>
} {
  const options = call?.args.agentOptions as { seatBinding?: { seat: string; rowHash: string; row: Record<string, unknown> } } | undefined
  if (options?.seatBinding === undefined) throw new Error('no seatBinding on the call')
  return options.seatBinding
}

describe('the row picks the driver', () => {
  it('creates a never-run Claude Code seat with the row driver, a frozen binding and no model requirement', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path, noDefaultModel: true })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))

    expect(h.row(id)).toEqual({ state: 'done', reason: '' })
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]!
    expect(call.kind).toBe('create')
    expect(call.args.driver).toBe('claude-code')
    // No provider/model is chosen for a driver seat: the driver owns both.
    expect(Object.keys(call.args.agentOptions as object)).toEqual(['seatBinding'])
    const binding = bindingOf(call)
    const parsed = (await loadOrgRegistry(path)).seats.target!
    expect(binding.seat).toBe('target')
    expect(binding.rowHash).toBe(seatRowHash(parsed))
    expect(binding.row).toEqual(parsed)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.row)).toBe(true)
    expect(Object.isFrozen(binding.row.admit_from)).toBe(true)
    // The default loop's model installation did not run.
    expect(h.setupLog.filter(entry => entry.startsWith('on:'))).toEqual([])
    expect(h.registered.get(h.sessionIdOf('target'))?.followup).toHaveBeenCalledTimes(1)
  })

  it('cold-resumes a Claude Code seat with the row driver and the same binding shape', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({
      registryPath: path,
      persisted: ['target'],
      logs: { target: [{ type: 'claude-code/session-bound' }, { type: 'assistant/message' }] },
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).state).toBe('done')
    expect(h.calls.map(call => call.kind)).toEqual(['resume'])
    expect(h.calls[0]!.args.driver).toBe('claude-code')
    expect(h.calls[0]!.args.resumeSessionId).toBe(h.sessionIdOf('target'))
    expect(bindingOf(h.calls[0]).seat).toBe('target')
    expect(h.inspect).toHaveBeenCalledTimes(1)
  })

  it('applies the seat tool restriction to a driver seat without a notice in its log', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'tools:', '  deny:', '    - bash'] }))
    const h = await makeDriverHarness({ registryPath: path })
    const info = vi.spyOn(h.ctx.logger, 'info').mockImplementation(() => {})
    await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.setupLog).toContain('tools.restrict:{"deny":["bash"]}')
    // The default loop appends a restriction notice to the seat's log; a driver seat's log is not the bridge's to write.
    expect(h.setupLog).not.toContain('append:user/message')
    // The bus event and a log line both survive.
    expect(h.restrictions).toEqual([{ seatName: 'target', muted: false, degraded: false, missing: [], remaining: ['read'] }])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('tool restriction applied'))
  })

  it('fails closed when a tool rule exists and the agent context has no tools service', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'tools:', '  deny:', '    - bash'] }))
    const h = await makeDriverHarness({ registryPath: path, noTools: true })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    const row = h.row(id)
    expect(row.state).toBe('failed')
    expect(row.reason).toContain('no tools service')
    expect(h.registered.size).toBe(0)
  })

  it('refuses a driver seat whose tool rule leaves it no tools, never composing it', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'tools:', '  deny:', '    - read', '    - bash'] }))
    const h = await makeDriverHarness({ registryPath: path })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).reason).toContain('seat-tools-muted')
    expect(h.registered.size).toBe(0)
    expect(h.restrictions).toEqual([{ seatName: 'target', muted: true, degraded: false, missing: [], remaining: [] }])
  })

  it('refuses when the row names a driver this host has not registered', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path, drivers: ['default'] })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).reason).toContain('seat-driver-unavailable')
    expect(h.row(id).reason).toContain('claude-code')
    expect(h.calls).toEqual([])
  })
})

describe('a driver seat admits only what its row lists', () => {
  const spec = (h: Awaited<ReturnType<typeof makeDriverHarness>>) =>
    h.spec({ addresses: ['target'], admitFrom: ['alice', 'ghost', 'sender'] })

  it('refuses a seat sender missing from admit_from, naming the failing part', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    const id = await h.publish('ghost')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toBe('seat-driver-admission-denied: seat "target" does not admit mail from "ghost": sender "ghost" is not in admit_from')
    expect(h.calls).toEqual([])
    expect(h.refusals).toEqual([{ from: 'ghost', to: 'target', reason: h.row(id).reason }])
  })

  it('refuses everyone when admit_from is empty', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry(ccRegistry({ target: ['driver: claude-code', 'admit_from: []', 'admit_sender_classes:', '  - seat'] })),
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).reason).toContain('admit_from is empty')
    expect(h.calls).toEqual([])
  })

  it('refuses a listed sender whose class is not listed', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry(ccRegistry({ target: ['driver: claude-code', 'admit_from:', '  - alice'] })),
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).reason).toContain('sender class "seat" is not in admit_sender_classes')
  })

  it('refuses guest mail even when the row admits seats', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    const id = await h.publish('guest:operator')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toContain('seat-driver-admission-denied')
    expect(h.calls).toEqual([])
  })

  it('refuses a guest forging a roster from, even when the row also admits unverified senders', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry(ccRegistry({
        target: ['driver: claude-code', 'admit_from:', '  - alice', 'admit_sender_classes:', '  - seat', '  - unverified'],
      })),
    })
    // The transport stamps the guest prefix; the forged roster name rides behind it.
    const id = await h.publish('guest:alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).reason).toBe('seat-driver-admission-denied: seat "target" does not admit mail from "guest:alice": sender "guest:alice" is not in admit_from')
    expect(h.calls).toEqual([])
  })

  it('delivers mail from a listed seat sender', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id)).toEqual({ state: 'done', reason: '' })
    expect(h.calls).toHaveLength(1)
  })

  it('refuses closed when the admission step throws', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()), listDriversThrows: true })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toContain('seat-driver-admission-error')
    expect(h.row(id).reason).toContain('listDrivers exploded')
    expect(h.calls).toEqual([])
  })

  it('refuses closed when resolving the row view throws', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => { throw new Error('clone exploded') })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toContain('seat-driver-admission-error')
    expect(h.row(id).reason).toContain('clone exploded')
    expect(h.calls).toEqual([])
  })

  it('settles the lease exactly once, after the follow-up, and never provides mail hooks', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    const settle = vi.spyOn(h.ctx.mailbox, 'settle')
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec(h))
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]![1]).toMatchObject({ state: 'done' })
    const agent = h.registered.get(h.sessionIdOf('target'))!
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.invocationCallOrder[0]!).toBeLessThan(settle.mock.invocationCallOrder[0]!)
    expect(h.row(id).state).toBe('done')
    expect((h.ctx as unknown as { get(name: string): unknown }).get('claudeCodeMailHooks')).toBeUndefined()
  })
})

describe('quarantined rows are refused on both sides', () => {
  it('refuses mail to an invalid recipient with the quarantine reason, before the test boundary', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'claude_path: /usr/bin/x', 'test: true'] }))
    const h = await makeDriverHarness({ registryPath: path })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toBe('seat-row-invalid: seat "target": claude_path belongs in host config')
    expect(h.calls).toEqual([])
  })

  it('refuses mail from an invalid sender with the quarantine reason', async () => {
    const path = writeRegistry(ccRegistry({ alice: ['model: opus'] }))
    const h = await makeDriverHarness({ registryPath: path })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target', 'alice'], admitFrom: [] }))
    expect(h.row(id).reason).toContain('seat-row-invalid: seat "alice"')
    expect(h.calls).toEqual([])
  })

  it('refuses an invalid recipient on the live path too, and disposes its resident', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(spec.residents.has('target')).toBe(true)
    rewriteRegistry(path, ccRegistry({ target: [...CC_TARGET, 'fable_ok: true'] }))
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).reason).toBe('seat-row-invalid: seat "target": fable_ok belongs in host config')
    expect(h.disposes()).toBe(1)
    expect(spec.residents.has('target')).toBe(false)
    expect(h.registered.size).toBe(0)
  })

  it('disposes a resident the moment a registry reload quarantines its seat, with no mail waiting', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(spec.residents.has('target')).toBe(true)
    rewriteRegistry(path, ccRegistry({ target: [...CC_TARGET, 'claude_path: /bin/x'] }))
    await bridge.internals.drainOnce(h.ctx, spec)
    await vi.waitFor(() => { expect(h.disposes()).toBe(1) })
    expect(spec.residents.has('target')).toBe(false)
    expect(h.rowChanges).toEqual([{ seat: 'target', changed: ['driver', 'admit_from', 'admit_sender_classes', 'invalid'] }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry row of seat "target" changed'))
  })
})

describe('driver flips are refused from the stored log', () => {
  const FOUNDER = 'ask the founder to reseed this seat or revert the row'

  it('refuses a Claude Code row over a log holding default-loop history, naming the founder and printing no command', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry(ccRegistry()),
      persisted: ['target'],
      logs: { target: [{ type: 'request/header' }, { type: 'assistant/message' }] },
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    const row = h.row(id)
    expect(row.state).toBe('failed')
    expect(row.reason).toBe(`seat-driver-flip: seat "target" row says driver "claude-code" but its session log holds "default" history; ${FOUNDER}`)
    expect(row.reason).not.toMatch(/`|pnpm|dsh-hire|--reseed|rm |sqlite/)
    expect(h.calls).toEqual([])
  })

  it('refuses a default row over a log holding Claude Code history', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry({ rows: { target: [], alice: [] }, edges: [['alice', 'target']] }),
      persisted: ['target'],
      logs: { target: [{ type: 'claude-code/session-bound' }, { type: 'assistant/message' }] },
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).reason).toBe(`seat-driver-flip: seat "target" row says driver "default" but its session log holds "claude-code" history; ${FOUNDER}`)
    expect(h.calls).toEqual([])
  })

  it('always refuses a mixed log, whichever driver the row names', async () => {
    const mixed = [{ type: 'claude-code/session-bound' }, { type: 'request/header' }]
    for (const rows of [ccRegistry(), { rows: { target: [], alice: [] }, edges: [['alice', 'target']] as const }]) {
      const h = await makeDriverHarness({ registryPath: writeRegistry(rows), persisted: ['target'], logs: { target: mixed } })
      const id = await h.publish('alice')
      await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
      expect(h.row(id).reason).toContain('holds "mixed" history')
      expect(h.calls).toEqual([])
      cleanupHarnesses()
    }
  })

  it('does not treat a log holding only user messages as a flip', async () => {
    const h = await makeDriverHarness({
      registryPath: writeRegistry(ccRegistry()),
      persisted: ['target'],
      logs: { target: [{ type: 'user/message' }, { type: 'user/message' }] },
    })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).state).toBe('done')
    expect(h.calls.map(call => call.kind)).toEqual(['resume'])
  })

  it('fails closed for a driver seat when the stored log cannot be inspected', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()), persisted: ['target'], inspectThrows: true })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toContain('cannot verify the stored session log of seat "target"')
    expect(h.calls).toEqual([])
  })

  it('A7: a user-only log flipped to Claude Code delivers, and once bound a flip back to default is refused', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({
      registryPath: path,
      persisted: ['target'],
      logs: { target: [{ type: 'user/message' }] },
    })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'], residencyIdleMs: 0 })
    const first = await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(first).state).toBe('done')
    expect(h.calls[0]!.args.driver).toBe('claude-code')
    // The driver's first turn writes this event (its own suite asserts that);
    // here the stored log is what it leaves behind.
    h.logs.set(h.sessionIdOf('target'), [{ type: 'user/message' }, { type: 'claude-code/session-bound' }, { type: 'assistant/message' }])
    rewriteRegistry(path, { rows: { target: [], alice: [], ghost: [] }, edges: [['alice', 'target']] })
    const second = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(second).reason).toContain('row says driver "default" but its session log holds "claude-code" history')
    expect(h.calls).toHaveLength(1)
  })

  it('delivers after a reseed: a new sessionId names a fresh log', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'sessionId: named-old'] }))
    const h = await makeDriverHarness({
      registryPath: path,
      persisted: ['target'],
      sessionIds: { target: 'named-old' },
      logs: { target: [{ type: 'request/header' }, { type: 'assistant/message' }] },
    })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'], residencyIdleMs: 0 })
    const refused = await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(refused).reason).toContain('seat-driver-flip')
    rewriteRegistry(path, ccRegistry({ target: [...CC_TARGET, 'sessionId: named-new'] }))
    const delivered = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(delivered).state).toBe('done')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.kind).toBe('create')
    expect(h.calls[0]!.args.sessionId).toBe('named-new')
    expect(h.calls[0]!.args.driver).toBe('claude-code')
  })
})

describe('the live path: revocation and the flip check', () => {
  const live = (h: Awaited<ReturnType<typeof makeDriverHarness>>) => h.registered.get(h.sessionIdOf('target'))!

  it('does not dispose a resident whose row is unchanged, even after the file is touched', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    rewriteRegistry(path, ccRegistry())
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).state).toBe('done')
    expect(h.calls).toHaveLength(1)
    expect(h.disposes()).toBe(0)
    expect(live(h).steer).toHaveBeenCalledTimes(1)
    expect(h.rowChanges).toEqual([])
  })

  it('keeps a resident when only an irrelevant field of its row changes, with no change event', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    rewriteRegistry(path, ccRegistry({ target: [...CC_TARGET, 'lead: true', 'department: ops'] }))
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).state).toBe('done')
    expect(h.disposes()).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.rowChanges).toEqual([])
  })

  it('disposes a resident when a security field of its row changes, and the next delivery is cold', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice', 'ghost'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    const firstHash = bindingOf(h.calls[0]).rowHash
    rewriteRegistry(path, ccRegistry({
      target: ['driver: claude-code', 'admit_from:', '  - alice', '  - ghost', 'admit_sender_classes:', '  - seat'],
    }))
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).state).toBe('done')
    expect(h.disposes()).toBe(1)
    expect(h.calls.map(call => call.kind)).toEqual(['create', 'resume'])
    expect(bindingOf(h.calls[1]).rowHash).not.toBe(firstHash)
    expect(bindingOf(h.calls[1]).rowHash).toBe(seatRowHash((await loadOrgRegistry(path)).seats.target!))
    // The change was loud: a bus event naming the field and a warn.
    expect(h.rowChanges).toEqual([{ seat: 'target', changed: ['admit_from'] }])
    expect(warn).toHaveBeenCalledWith('mailbox-bridge: registry row of seat "target" changed (admit_from)')
  })

  it('disposes a default-loop resident when its seat is flipped to Claude Code, then refuses on the default history', async () => {
    const path = writeRegistry({ rows: { target: [], alice: [] }, edges: [['alice', 'target']] })
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.calls[0]!.kind).toBe('create')
    expect('driver' in h.calls[0]!.args).toBe(false)
    // The default loop answered, so its log now holds model-turn history.
    h.logs.set(h.sessionIdOf('target'), [{ type: 'request/header' }, { type: 'assistant/message' }])
    rewriteRegistry(path, { rows: { target: CC_TARGET, alice: [] }, edges: [['alice', 'target']] })
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    // The resident carried no recorded row hash, so it is gone and the cold path judged the log.
    expect(h.disposes()).toBe(1)
    expect(h.row(id).reason).toContain('row says driver "claude-code" but its session log holds "default" history')
    expect(h.calls).toHaveLength(1)
  })

  it('disposes a Claude Code resident when its row flips back to default, then refuses on the Claude Code history', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    h.logs.set(h.sessionIdOf('target'), [{ type: 'claude-code/session-bound' }, { type: 'assistant/message' }])
    rewriteRegistry(path, { rows: { target: [], alice: [] }, edges: [['alice', 'target']] })
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.disposes()).toBe(1)
    expect(h.row(id).reason).toContain('row says driver "default" but its session log holds "claude-code" history')
  })

  it('refuses to steer into a live agent the bridge did not compose for a driver seat', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(ccRegistry()) })
    const foreign = stubAgent(h.sessionIdOf('target'))
    h.registered.set(h.sessionIdOf('target'), foreign)
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).reason).toContain('seat-driver-live-unmanaged')
    expect(foreign.steer).not.toHaveBeenCalled()
    expect(foreign.followup).not.toHaveBeenCalled()
  })

  it('refuses a live resident whose log turns up mixed, and caches a verified match so the log is not re-read', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    const agent = live(h)
    const events = [{ type: 'claude-code/session-bound' }, { type: 'assistant/message' }]
    let reads = 0
    Object.defineProperty(agent.session, 'events', { get: () => { reads += 1; return events } })
    const two = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(two).state).toBe('done')
    expect(reads).toBe(1)
    const three = await h.publish('alice', 'three')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(three).state).toBe('done')
    // The positive match was cached: the log was not read a second time.
    expect(reads).toBe(1)
  })

  it('refuses a live resident whose log mixes the drivers before a match was ever cached', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    live(h).session.events.push({ type: 'claude-code/session-bound' }, { type: 'request/header' })
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).reason).toContain('holds "mixed" history')
    expect(live(h).steer).not.toHaveBeenCalled()
  })

  it('refuses mail into a default-loop resident whose live log holds Claude Code history', async () => {
    const path = writeRegistry({ rows: { target: [], alice: [] }, edges: [['alice', 'target']] })
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    live(h).session.events.push({ type: 'claude-code/session-bound' })
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).reason).toContain('row says driver "default" but its session log holds "claude-code" history')
    expect(live(h).steer).not.toHaveBeenCalled()
  })
})

describe('refusal notices never reach a driver seat', () => {
  it('logs no notice into a Claude Code sender: no resume, no append, the bus event and a warn kept', async () => {
    const path = writeRegistry(ccRegistry({ alice: ['driver: claude-code', 'admit_from: []'] }, { edges: [['alice', 'target']] }))
    const h = await makeDriverHarness({ registryPath: path, persisted: ['alice'], logs: { alice: [{ type: 'claude-code/session-bound' }] } })
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    const liveAlice = stubAgent(h.sessionIdOf('alice'))
    const dormant = await h.publish('alice')
    // alice is not a served address nor admitted by the spec: sender-not-admitted, then the notice step.
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: [] }))
    expect(h.row(dormant).reason).toContain('sender-not-admitted')
    expect(h.calls).toEqual([])
    expect(h.refusals).toEqual([{ from: 'alice', to: 'target', reason: 'sender-not-admitted' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusal notice for sender "alice" not logged'))

    // A live Claude Code sender is left alone too.
    h.registered.set(h.sessionIdOf('alice'), liveAlice)
    await h.publish('alice', 'again')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: [] }))
    expect(liveAlice.session.append).not.toHaveBeenCalled()
  })

  it('logs no notice into a quarantined sender, whose driver cannot be known', async () => {
    const path = writeRegistry(ccRegistry({ alice: ['model: opus'] }))
    const h = await makeDriverHarness({ registryPath: path, persisted: ['alice'] })
    const liveAlice = stubAgent(h.sessionIdOf('alice'))
    h.registered.set(h.sessionIdOf('alice'), liveAlice)
    await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: [] }))
    expect(liveAlice.session.append).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
  })

  it('still logs the refusal into a default-loop sender when a Claude Code target refuses it', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    const liveGhost = stubAgent(h.sessionIdOf('ghost'))
    h.registered.set(h.sessionIdOf('ghost'), liveGhost)
    const id = await h.publish('ghost')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target', 'ghost'], admitFrom: [] }))
    expect(h.row(id).reason).toContain('seat-driver-admission-denied')
    expect(liveGhost.session.append).toHaveBeenCalledTimes(1)
    const [type, data] = liveGhost.session.append.mock.calls[0] as [string, { source: { reason: string } }]
    expect(type).toBe('user/message')
    expect(data.source.reason).toContain('seat-driver-admission-denied')
  })
})

describe('the mailboxSeatRows service', () => {
  /** Mount the bridge on the harness context (its `apply`, the same entry the loader calls). */
  async function mount(h: Awaited<ReturnType<typeof makeDriverHarness>>, orgRegistryPath: string, addresses = ['target']): Promise<void> {
    await bridge.apply(h.ctx, { addresses, orgRegistryPath, pollIntervalMs: 600_000, admitFrom: ['alice'] })
  }

  it('answers with the bridge cache: the same hash a binding carries, and a narrowed view', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    await mount(h, path)
    const rows = h.ctx.get('mailboxSeatRows')!
    expect(rows.registryPath).toBe(path)
    expect(path.startsWith(tmpdir())).toBe(true)
    const current = rows.current('target')!
    const parsed = (await loadOrgRegistry(path)).seats.target!
    expect(current.rowHash).toBe(seatRowHash(parsed))
    expect(current.driver).toBe('claude-code')
    expect(current.admit_from).toEqual(parsed.admit_from)
    expect(current.admit_sender_classes).toEqual(parsed.admit_sender_classes)
    expect(Object.isFrozen(current)).toBe(true)
    expect(rows.current('nobody')).toBeUndefined()

    await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(bindingOf(h.calls[0]).rowHash).toBe(current.rowHash)
  })

  it('exposes no row, cwd, session id or tools, and the view still admits through admitsMail', async () => {
    const path = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: path })
    await mount(h, path)
    const current = h.ctx.get('mailboxSeatRows')!.current('target')!
    expect(Object.keys(current).sort()).toEqual(['admit_from', 'admit_sender_classes', 'driver', 'rowHash'])
    for (const key of ['row', 'cwd', 'sessionId', 'tools']) expect(current).not.toHaveProperty(key)
    expect(admitsMail(current, { from: 'alice', classes: ['seat'] })).toEqual({ allow: true })
    expect(admitsMail(current, { from: 'mallory', classes: ['seat'] }).allow).toBe(false)
  })

  it('serves nothing for a quarantined seat', async () => {
    const path = writeRegistry(ccRegistry({ target: [...CC_TARGET, 'model: opus'] }))
    const h = await makeDriverHarness({ registryPath: path })
    await mount(h, path)
    expect(h.ctx.get('mailboxSeatRows')!.current('target')).toBeUndefined()
  })

  it('fails the mount of a second bridge that reads a different registry path', async () => {
    const pathA = writeRegistry(ccRegistry())
    const pathB = writeRegistry(ccRegistry())
    const h = await makeDriverHarness({ registryPath: pathA })
    await mount(h, pathA)
    await expect(mount(h, pathB, ['ghost'])).rejects.toThrow(/differs from the .* another mounted bridge already provides mailboxSeatRows for/)
    expect(h.ctx.get('mailboxSeatRows')!.registryPath).toBe(pathA)
  })
})
