import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRUST_CHALLENGE_TTL_MS } from '../src/index.ts'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined; vi.useRealTimers() })

const ask = (h0: Harness) =>
  h0.engine.runs[0]!.request.approver!({ approvalId: 'engine-id', nodeId: 'ask', message: 'Ship it?', signal: new AbortController().signal })

describe('attachUi: the explicit human-present signal', () => {
  it('a subscriber alone is not a human: the approval fails closed with a remedy', async () => {
    h = await setup({ ui: false })
    h.ctx.workflowRuns.subscribe(() => undefined)
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    expect(await ask(h)).toBe('rejected')
    const store = await h.ctx.workflowRuns.storeFor(h.workspace)
    const record = (await store.getRun(started.runId)).approvals[0]
    expect(record).toMatchObject({ state: 'rejected' })
    expect(record!.reason).toContain('nobody is connected to answer it')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('an attachment lets the approval wait for an answer; its disposer restores the fast reject', async () => {
    h = await setup({ ui: false })
    const detach = h.ctx.workflowRuns.attachUi()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const pending = ask(h)
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    expect(await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'allow')).toBe('allowed')
    expect(await pending).toBe('allowed-once')
    detach()
    expect(await ask(h)).toBe('rejected')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })

  it('counts attachments: two tabs need two disposers, and a disposer called twice releases once', async () => {
    h = await setup({ ui: false })
    const first = h.ctx.workflowRuns.attachUi()
    const second = h.ctx.workflowRuns.attachUi()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    first()
    first()
    const pending = ask(h)
    await expect.poll(() => h!.ctx.workflowRuns.pendingApprovals().length).toBe(1)
    const waiting = h.ctx.workflowRuns.pendingApprovals()[0]!
    await h.ctx.workflowRuns.answerApproval(started.runId, waiting.approvalId, 'reject')
    expect(await pending).toBe('rejected')
    second()
    expect(await ask(h)).toBe('rejected')
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })
})

describe('cancel scoping (F9)', () => {
  it('answers exactly like an unknown run for another workspace or another session', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const elsewhere = await mkdtemp(join(tmpdir(), 'wfrun-other-'))
    try {
      expect(await h.ctx.workflowRuns.cancel(started.runId, 'x', { workspace: elsewhere })).toEqual({ found: false })
      expect(await h.ctx.workflowRuns.cancel(started.runId, 'x', { workspace: join(elsewhere, 'missing') })).toEqual({ found: false })
      expect(await h.ctx.workflowRuns.cancel(started.runId, 'x', { workspace: h.workspace, sessionId: 'someone-else' }))
        .toEqual({ found: false })
      expect(h.engine.runs[0]!.cancels).toHaveLength(0)
      const ok = await h.ctx.workflowRuns.cancel(started.runId, 'stop', { workspace: h.workspace, sessionId: 'parent' })
      expect(ok.found).toBe(true)
      expect(h.engine.runs[0]!.cancels).toEqual(['stop'])
    } finally {
      await started.done
    }
  })

  it('activeRuns names the owning workspace and parent session', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const active = h.ctx.workflowRuns.activeRuns()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ runId: started.runId, workspace: await realpath(h.workspace), sessionId: 'parent' })
    h.engine.runs[0]!.settle(COMPLETED)
    await started.done
  })
})

describe('trust challenge (F10)', () => {
  const dryFor = async (caller?: string) => {
    const dry = await h!.ctx.workflowRuns.dryRun(h!.workspace, { name: 'demo', ...caller === undefined ? {} : { caller } })
    if (!dry.ok) throw new Error(dry.message)
    return dry
  }
  const startWith = (trustHash?: string, trustChallenge?: string) => h!.ctx.workflowRuns.start({
    parent: h!.parent,
    name: 'demo',
    ...trustHash === undefined ? {} : { trustHash },
    ...trustChallenge === undefined ? {} : { trustChallenge },
  })

  it('issues a challenge only for an untrusted plan and only when a caller is named', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    expect((await dryFor()).trustChallenge).toBeUndefined()
    const dry = await dryFor('parent')
    expect(dry.trustChallenge).toMatch(/^[0-9a-f]{48}$/)
  })

  it('refuses the trust key without a challenge: the key alone proves nothing', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const dry = await dryFor('parent')
    expect(await startWith(dry.trustKey)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    expect(await startWith(dry.trustKey, 'f'.repeat(48))).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    expect(h.engine.runs).toHaveLength(0)
  })

  it('accepts a live challenge once; replaying it fails even for the same content', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const dry = await dryFor('parent')
    const first = await startWith(dry.trustKey, dry.trustChallenge)
    expect(first.ok).toBe(true)
    h.engine.runs[0]!.settle(COMPLETED)
    if (first.ok) await first.done
    // The content is now trusted, so a plain start works; a replayed challenge on new content does not.
    await h.writeWorkflow('demo', `${DEMO}# edited\n`)
    const edited = await dryFor('parent')
    expect(edited.trustKey).not.toBe(dry.trustKey)
    expect(await startWith(edited.trustKey, dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
  })

  it('a consumed challenge cannot be redeemed twice', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const dry = await dryFor('parent')
    expect(await startWith('0'.repeat(64), dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    // The wrong key spent it: the right key with the same challenge is now refused.
    expect(await startWith(dry.trustKey, dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    expect(h.engine.runs).toHaveLength(0)
  })

  it('expires after the ttl', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    vi.useFakeTimers({ toFake: ['Date'] })
    const dry = await dryFor('parent')
    vi.setSystemTime(Date.now() + TRUST_CHALLENGE_TTL_MS + 1)
    expect(await startWith(dry.trustKey, dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    expect(h.engine.runs).toHaveLength(0)
    vi.useRealTimers()
    const fresh = await dryFor('parent')
    expect((await startWith(fresh.trustKey, fresh.trustChallenge)).ok).toBe(true)
    h.engine.runs[0]!.settle(COMPLETED)
  })

  it('is bound to the caller: a challenge issued to another session is refused', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const dry = await dryFor('another-session')
    expect(await startWith(dry.trustKey, dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    expect(h.engine.runs).toHaveLength(0)
  })

  it('is bound to the workspace: a challenge for one workspace does not unlock a same-named file in another', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const other = await setup()
    try {
      await other.writeWorkflow('demo', DEMO)
      // Same service, same content, same caller id, but the challenge was issued for the other workspace.
      const dry = await h.ctx.workflowRuns.dryRun(other.workspace, { name: 'demo', caller: 'parent' })
      if (!dry.ok) throw new Error(dry.message)
      expect(await startWith(dry.trustKey, dry.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    } finally {
      await other.cleanup()
    }
  })

  it('the model tool never receives a challenge or the trust key', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const result = await h.execute({ name: 'demo', dryRun: true })
    expect(JSON.stringify(result)).not.toMatch(/trustChallenge|trustKey/)
  })

  it('one caller cannot evict another caller\'s live challenge', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const human = await dryFor('parent')
    for (let i = 0; i < 70; i += 1) await dryFor('spammer')
    expect(await startWith(human.trustKey, human.trustChallenge)).toMatchObject({ ok: true })
  })

  it('holds at most four open challenges per caller, dropping that caller\'s oldest', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const issued = []
    for (let i = 0; i < 5; i += 1) issued.push(await dryFor('parent'))
    expect(await startWith(issued[0]!.trustKey, issued[0]!.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
    const started = await startWith(issued[4]!.trustKey, issued[4]!.trustChallenge)
    expect(started).toMatchObject({ ok: true })
  })

  it('ignores a supplied trust key and challenge when the content is already trusted', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const dry = await dryFor('parent')
    const first = await startWith(dry.trustKey, dry.trustChallenge)
    expect(first).toMatchObject({ ok: true })
    h.engine.runs[0]!.settle(COMPLETED)
    if (first.ok) await first.done
    expect(await startWith(dry.trustKey, 'f'.repeat(48))).toMatchObject({ ok: true })
  })

  it('the challenge map is bounded', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const first = await dryFor('parent')
    for (let i = 0; i < 70; i += 1) await dryFor('parent')
    expect(await startWith(first.trustKey, first.trustChallenge)).toMatchObject({ ok: false, error: 'TRUST_REQUIRED' })
  })
})
