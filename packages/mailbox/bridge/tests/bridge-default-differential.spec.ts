/**
 * Differential proof that the seat-driver work leaves the default-loop path as
 * it was: for a seat whose row names no driver (or names `default`), the exact
 * arguments `agents.create` / `agents.resume` receive carry no `driver` key and
 * no binding, and the setup side effects are the same as for a row that never
 * heard of drivers. Registries are block-style files under `os.tmpdir()`.
 */

import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '../src/index.ts'
import { cleanupHarnesses, makeDriverHarness, rewriteRegistry, writeRegistry } from './driver-harness.ts'
import type { DriverHarness, RegistryRows } from './driver-harness.ts'

afterEach(cleanupHarnesses)

const PLAIN: RegistryRows = { rows: { target: [], alice: [] }, edges: [['alice', 'target']] }
const EXPLICIT_DEFAULT: RegistryRows = { rows: { target: ['driver: default'], alice: [] }, edges: [['alice', 'target']] }
const RESTRICTED: RegistryRows = { rows: { target: ['tools:', '  deny:', '    - bash'], alice: [] }, edges: [['alice', 'target']] }

/** Drive one delivery of `alice` mail and return what the registry saw. */
async function run(rows: RegistryRows, options: { persisted?: boolean } = {}): Promise<DriverHarness> {
  const h = await makeDriverHarness({
    registryPath: writeRegistry(rows),
    persisted: options.persisted === true ? ['target'] : [],
  })
  await h.publish('alice')
  await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'], residencyIdleMs: 0 }))
  return h
}

describe('default-loop seats: the create/resume arguments are exactly what they were', () => {
  it('create carries only sessionId, meta, agentOptions and setup; the driver key is absent', async () => {
    const h = await run(PLAIN)
    expect(h.calls).toHaveLength(1)
    const { kind, args } = h.calls[0]!
    expect(kind).toBe('create')
    expect('driver' in args).toBe(false)
    expect(Object.keys(args).sort()).toEqual(['agentOptions', 'meta', 'sessionId', 'setup'])
    expect(args.agentOptions).toEqual({ provider: 'mock', model: 'mock' })
    expect('seatBinding' in (args.agentOptions as object)).toBe(false)
    expect(args.meta).toEqual({ cwd: expect.stringMatching(/target$/) as string })
  })

  it('resume carries only resumeSessionId, agentOptions and setup; the driver key is absent', async () => {
    const h = await run(PLAIN, { persisted: true })
    expect(h.calls).toHaveLength(1)
    const { kind, args } = h.calls[0]!
    expect(kind).toBe('resume')
    expect('driver' in args).toBe(false)
    expect(Object.keys(args).sort()).toEqual(['agentOptions', 'resumeSessionId', 'setup'])
    expect(args.agentOptions).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('a row that says `driver: default` is indistinguishable from one that says nothing', async () => {
    for (const persisted of [false, true]) {
      const plain = await run(PLAIN, { persisted })
      const explicit = await run(EXPLICIT_DEFAULT, { persisted })
      expect(explicit.calls.map(call => ({ kind: call.kind, keys: Object.keys(call.args).sort(), options: call.args.agentOptions })))
        .toEqual(plain.calls.map(call => ({ kind: call.kind, keys: Object.keys(call.args).sort(), options: call.args.agentOptions })))
      expect(explicit.setupLog).toEqual(plain.setupLog)
      expect(explicit.listDrivers).not.toHaveBeenCalled()
    }
  })

  it('setup runs the same side effects for a driverless row and an explicit default row, tool restriction included', async () => {
    for (const persisted of [false, true]) {
      const driverless = await run(RESTRICTED, { persisted })
      const explicit = await run({ rows: { ...RESTRICTED.rows, target: ['driver: default', ...RESTRICTED.rows.target!] }, edges: [['alice', 'target']] }, { persisted })
      expect(explicit.setupLog).toEqual(driverless.setupLog)
      // Model selection installed, the rule applied, and the restriction notice appended to the seat's log.
      expect(driverless.setupLog.some(entry => entry.startsWith('on:'))).toBe(true)
      expect(driverless.setupLog).toContain('tools.restrict:{"deny":["bash"]}')
      expect(driverless.setupLog).toContain('append:user/message')
      expect(driverless.restrictions).toEqual([{ seatName: 'target', muted: false, degraded: false, missing: [], remaining: ['read'] }])
      expect(explicit.restrictions).toEqual(driverless.restrictions)
    }
  })

  it('never consults the driver list or builds a binding for a default seat', async () => {
    const h = await run(PLAIN, { persisted: true })
    expect(h.listDrivers).not.toHaveBeenCalled()
    expect(JSON.stringify(h.calls.map(call => call.args.agentOptions))).not.toContain('seatBinding')
    // The cold path adds exactly one log inspection (the flip check); a create adds none.
    expect(h.inspect).toHaveBeenCalledTimes(1)
    const fresh = await run(PLAIN)
    expect(fresh.inspect).not.toHaveBeenCalled()
  })

  it('still requires the default model service, as before', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(PLAIN), noDefaultModel: true })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'] }))
    expect(h.row(id).state).toBe('failed')
    expect(h.row(id).reason).toContain('requires the default model-selection service')
  })

  it('an unreadable registry still composes a dormant default-loop sender: no driver key, same setup', async () => {
    // A registry that exists but will not load refuses the mail, and the refusal
    // notice then resumes the dormant default-loop sender through the same
    // composition path, which must fail open to the default loop.
    const path = writeRegistry(PLAIN)
    writeFileSync(path, 'seats: [this is: not a registry\n', 'utf8')
    const h = await makeDriverHarness({ registryPath: path, persisted: ['alice'] })
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['alice'], residencyIdleMs: 0 }))
    expect(h.row(id).reason).toContain('org-registry-unavailable')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused mail'))
    expect(h.calls).toHaveLength(1)
    const { kind, args } = h.calls[0]!
    expect(kind).toBe('resume')
    expect('driver' in args).toBe(false)
    expect(Object.keys(args).sort()).toEqual(['agentOptions', 'resumeSessionId', 'setup'])
    expect(args.agentOptions).toEqual({ provider: 'mock', model: 'mock' })
    expect(h.setupLog.some(entry => entry.startsWith('on:'))).toBe(true)
    // The durable notice still reached the sender's log.
    expect(h.setupLog).toContain('append:user/message')
  })
})

describe('default-loop seats: residents and admission are untouched by the driver work', () => {
  it('keeps a default resident through a registry edit to a security field of its row', async () => {
    const path = writeRegistry(PLAIN)
    const h = await makeDriverHarness({ registryPath: path })
    const spec = h.spec({ addresses: ['target'], admitFrom: ['alice'] })
    await h.publish('alice', 'one')
    await bridge.internals.drainOnce(h.ctx, spec)
    rewriteRegistry(path, RESTRICTED)
    const id = await h.publish('alice', 'two')
    await bridge.internals.drainOnce(h.ctx, spec)
    expect(h.row(id).state).toBe('done')
    expect(h.disposes()).toBe(0)
    expect(h.calls).toHaveLength(1)
    // A default seat that stays default and valid raises no row-change event.
    expect(h.rowChanges).toEqual([])
  })

  it('admits mail to a default seat on the pre-existing rules alone: no admit lists consulted', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(PLAIN) })
    const id = await h.publish('sender')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: ['sender'] }))
    expect(h.row(id)).toEqual({ state: 'done', reason: '' })
    expect(h.listDrivers).not.toHaveBeenCalled()
  })

  it('still appends the refusal notice to a default-loop sender', async () => {
    const h = await makeDriverHarness({ registryPath: writeRegistry(PLAIN), persisted: ['alice'] })
    const id = await h.publish('alice')
    await bridge.internals.drainOnce(h.ctx, h.spec({ addresses: ['target'], admitFrom: [], residencyIdleMs: 0 }))
    expect(h.row(id).reason).toBe('sender-not-admitted')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.kind).toBe('resume')
    expect(h.setupLog).toContain('append:user/message')
  })
})
