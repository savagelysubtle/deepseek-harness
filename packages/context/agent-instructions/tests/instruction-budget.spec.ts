import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SESSION_FORMAT_VERSION, type UserMessage } from '@deepseek-ai/dsh-session'
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions'
import { renderWorkspaceContext, type LoadedInstructionFile } from '@deepseek-ai/dsh-agent-instructions'
import { describeBudgetOverflow } from '../src/overflow.ts'

const KB = 1024

function file(displayPath: string, bytes: number): LoadedInstructionFile {
  return { absolutePath: `/abs/${displayPath}`, displayPath, content: 'x'.repeat(bytes) }
}

describe('instruction budget at real-world sizes', () => {
  const global = file('~/.agents/AGENTS.md', 65 * KB)
  const project = file('AGENTS.md', 16 * KB)

  it('drops the broad global file whole at maxBytes 65536 and keeps the project file intact', () => {
    const rendered = renderWorkspaceContext([global, project], { maxBytes: 65536 })
    expect(rendered.omitted.map(f => f.displayPath)).toEqual(['~/.agents/AGENTS.md'])
    expect(rendered.truncated).toEqual([])
    expect(rendered.text).toContain('Workspace instruction budget 65536 bytes: omitted ~/.agents/AGENTS.md')
    expect(rendered.text).toContain('x'.repeat(16 * KB))
    expect(rendered.text).not.toContain('x'.repeat(16 * KB + 1))
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(65536)
  })

  it('fits the same pair intact at maxBytes 131072', () => {
    const rendered = renderWorkspaceContext([global, project], { maxBytes: 131072 })
    expect(rendered.omitted).toEqual([])
    expect(rendered.truncated).toEqual([])
    expect(rendered.text).not.toContain('Workspace instruction budget')
    expect(rendered.text).toContain('x'.repeat(65 * KB))
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(131072)
  })
})

function stubAgent(cwd: string): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('unused') },
    cancel() { return false },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function setup(globalBytes: number, projectBytes: number, maxBytes: number, sub = '') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-budget-root-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-budget-home-'))
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'p'.repeat(projectBytes))
  await writeFile(join(home, 'AGENTS.md'), 'g'.repeat(globalBytes))
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(workspaceContext, { dshHome: home, maxBytes })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  await mkdir(join(root, sub), { recursive: true })
  const agent = stubAgent(join(root, sub))
  const enter = async (messages: UserMessage[], step = 1): Promise<UserMessage[]> => {
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages, turn: 1, step, signal: AbortSignal.timeout(5000) },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    )
    return decision.kind === 'enter' ? decision.messages : []
  }
  const cleanup = async (): Promise<void> => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
  const append = (messages: readonly UserMessage[]): void => {
    for (const message of messages) {
      const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
      ctx.emit('session/event', agent.session, event)
    }
  }
  const touch = async (path: string): Promise<void> => {
    ctx.emit('tools/result', {
      token: Symbol('budget-test') as ToolExecutionToken,
      callId: CallId('c1'),
      rootCallId: CallId('c1'),
      name: 'read',
      arguments: { file_path: path },
      signal: AbortSignal.timeout(5000),
      agent,
    } as ToolExecution, { content: [], isError: false, value: null })
    await Promise.resolve()
  }
  return { agent, warn, enter, append, touch, cleanup, root, home }
}

const prompt = (): UserMessage => createUserMessage({
  content: [{ type: 'text', text: 'go' }],
  source: { kind: 'user' },
})

async function mountSecond(home: string, maxBytes: number) {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(workspaceContext, { dshHome: home, maxBytes })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  return { ctx, warn }
}

describe('overflow reporting edges', () => {
  it('reports an identical overflow again after a fitting pass', async () => {
    const t = await setup(200, 200, 3000)
    try {
      t.append(await t.enter([prompt()]))
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(6000))
      t.append(await t.enter([], 2))
      expect(t.warn).toHaveBeenCalledTimes(1)
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(300))
      t.append(await t.enter([], 3))
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(6000))
      const entered = await t.enter([], 4)
      expect(t.warn).toHaveBeenCalledTimes(2)
      expect(entered.some(m => m.source.kind === 'plugin')).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('does not announce again on resume when the visible baseline already carries the marker', async () => {
    const t = await setup(5000, 1000, 3000)
    try {
      t.append(await t.enter([prompt()]))
      expect(t.warn).toHaveBeenCalledTimes(1)
      const second = await mountSecond(t.home, 3000)
      try {
        const entered = await agentEvents(second.ctx, t.agent).waterfall(
          'agent/pre-step',
          { messages: [], turn: 2, step: 2, signal: AbortSignal.timeout(5000) },
          () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
        )
        expect(entered.kind === 'enter' ? entered.messages : []).toEqual([])
        expect(second.warn).not.toHaveBeenCalled()
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await t.cleanup()
    }
  })

  it('delivers the notice at the batch end when a visible baseline now overflows after a resume', async () => {
    const t = await setup(200, 200, 3000)
    try {
      t.append(await t.enter([prompt()]))
      expect(t.warn).not.toHaveBeenCalled()
      await writeFile(join(t.home, 'AGENTS.md'), 'g'.repeat(5000))
      const second = await mountSecond(t.home, 3000)
      try {
        const decision = await agentEvents(second.ctx, t.agent).waterfall(
          'agent/pre-step',
          { messages: [], turn: 2, step: 2, signal: AbortSignal.timeout(5000) },
          () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
        )
        const entered = decision.kind === 'enter' ? decision.messages : []
        expect(second.warn).toHaveBeenCalled()
        expect(entered.at(-1)?.source).toMatchObject({ kind: 'plugin', form: 'notice' })
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await t.cleanup()
    }
  })

  it('drops a parked notice when the baseline later fits', async () => {
    const t = await setup(5000, 1000, 3000)
    try {
      expect(await t.enter([])).toEqual([])
      expect(t.warn).toHaveBeenCalledTimes(1)
      expect(t.agent.inbox.claim('next-step', 1)).toHaveLength(1)
      await writeFile(join(t.home, 'AGENTS.md'), 'small')
      const entered = await t.enter([prompt()], 2)
      expect(entered.map(m => m.source.kind)).toEqual(['user', 'agent-instructions'])
    } finally {
      await t.cleanup()
    }
  })

  it('drops a parked baseline notice once the baseline identity changes', async () => {
    const t = await setup(5000, 1000, 3000, 'sub')
    try {
      // Park the baseline notice: an empty first entry keeps the baseline pending.
      expect(await t.enter([])).toEqual([])
      expect(t.warn).toHaveBeenCalledTimes(1)
      // Discard the queued baseline so the next pass composes from scratch, then
      // move the project root to the cwd (a new baseline identity) with files that fit.
      expect(t.agent.inbox.claim('next-step', 1)).toHaveLength(1)
      await rm(join(t.root, '.git'), { recursive: true, force: true })
      await mkdir(join(t.root, 'sub', '.git'), { recursive: true })
      await writeFile(join(t.home, 'AGENTS.md'), 'small')
      const entered = await t.enter([prompt()], 2)
      expect(entered.map(m => m.source.kind)).toEqual(['user', 'agent-instructions'])
      expect(t.warn).toHaveBeenCalledTimes(1)
    } finally {
      await t.cleanup()
    }
  })
})

describe('dynamic transition overflow reporting', () => {
  it('warns and parks one notice when an edited file overflows the budget, then delivers it', async () => {
    const t = await setup(200, 200, 3000)
    try {
      t.append(await t.enter([prompt()]))
      expect(t.warn).not.toHaveBeenCalled()
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(6000))
      const entered = await t.enter([], 2)
      expect(t.warn).toHaveBeenCalledTimes(1)
      expect(String(t.warn.mock.calls[0]?.[1])).toContain('truncated AGENTS.md (6000 bytes')
      expect(entered.map(m => m.source.kind)).toEqual(['agent-instructions', 'plugin'])
      expect(entered[1]?.source).toMatchObject({ form: 'notice', plugin: 'agent-instructions' })
      await t.enter([], 3)
      expect(t.warn).toHaveBeenCalledTimes(1)
    } finally {
      await t.cleanup()
    }
  })

  it('reports an omitted file when several edited files overflow together', async () => {
    const t = await setup(200, 200, 3000)
    try {
      t.append(await t.enter([prompt()]))
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(2500))
      await writeFile(join(t.home, 'AGENTS.md'), 'r'.repeat(2500))
      await t.enter([], 2)
      expect(t.warn).toHaveBeenCalledTimes(1)
      expect(String(t.warn.mock.calls[0]?.[1])).toMatch(/omitted .*AGENTS.md \(2500 bytes\)/)
    } finally {
      await t.cleanup()
    }
  })

  it('still warns and enters the notice alone when every transition is dropped', async () => {
    const t = await setup(20, 20, 400)
    try {
      t.append(await t.enter([prompt()]))
      expect(t.warn).not.toHaveBeenCalled()
      const dir = join(t.root, 'd'.repeat(150))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'AGENTS.md'), 'q'.repeat(6000))
      await t.touch(join(dir, 'file.txt'))
      await vi.waitFor(() => { expect(t.warn).toHaveBeenCalledTimes(1) })
      expect(t.agent.inbox.nextStep).toHaveLength(0)
      expect(String(t.warn.mock.calls[0]?.[1])).toContain('(6000 bytes')
      const entered = await t.enter([], 2)
      expect(entered.map(m => m.source.kind)).toEqual(['plugin'])
      expect(entered[0]?.source).toMatchObject({ form: 'notice', plugin: 'agent-instructions' })
      await t.enter([], 3)
      expect(t.warn).toHaveBeenCalledTimes(1)
    } finally {
      await t.cleanup()
    }
  })

  it('emits nothing for a transition that fits', async () => {
    const t = await setup(200, 200, 3000)
    try {
      t.append(await t.enter([prompt()]))
      await writeFile(join(t.root, 'AGENTS.md'), 'q'.repeat(300))
      const entered = await t.enter([], 2)
      expect(entered.map(m => m.source.kind)).toEqual(['agent-instructions'])
      expect(t.warn).not.toHaveBeenCalled()
    } finally {
      await t.cleanup()
    }
  })
})

describe('instruction budget overflow reporting', () => {
  it('warns in the host log and enters one session notice after the baseline', async () => {
    const t = await setup(5000, 1000, 3000)
    try {
      const entered = await t.enter([prompt()])
      expect(entered.map(m => m.source.kind)).toEqual(['user', 'agent-instructions', 'plugin'])
      const notice = entered[2]!
      expect(notice.source).toMatchObject({ kind: 'plugin', plugin: 'agent-instructions', form: 'notice' })
      const text = (notice.content[0] as { text: string }).text
      expect(text).toContain('budget of 3000 bytes')
      expect(text).toContain('AGENTS.md (5000 bytes)')
      expect(t.warn).toHaveBeenCalledTimes(1)
      const line = String(t.warn.mock.calls[0]?.[1])
      expect(line).toMatch(/budget 3000 bytes exceeded; rendered \d+ bytes; omitted .*AGENTS.md \(5000 bytes\)/)
    } finally {
      await t.cleanup()
    }
  })

  it('does not repeat the log or notice when the baseline recomposes', async () => {
    const t = await setup(5000, 1000, 3000)
    try {
      await t.enter([prompt()])
      const again = await t.enter([prompt()], 2)
      expect(t.warn).toHaveBeenCalledTimes(1)
      expect(again.some(m => m.source.kind === 'plugin')).toBe(false)
    } finally {
      await t.cleanup()
    }
  })

  it('places the notice after a baseline that was already queued and is claimed later', async () => {
    const t = await setup(5000, 1000, 3000)
    try {
      expect(await t.enter([])).toEqual([])
      const claimed = t.agent.inbox.claim('next-step', 1)
      expect(claimed).toHaveLength(1)
      const entered = await t.enter([...claimed], 2)
      expect(entered.map(m => m.source.kind)).toEqual(['agent-instructions', 'plugin'])
    } finally {
      await t.cleanup()
    }
  })

  it('emits nothing when the files fit', async () => {
    const t = await setup(500, 500, 65536)
    try {
      const entered = await t.enter([prompt()])
      expect(entered.map(m => m.source.kind)).toEqual(['user', 'agent-instructions'])
      expect(t.warn).not.toHaveBeenCalled()
    } finally {
      await t.cleanup()
    }
  })

  it('describes a truncated file and uses singular wording', () => {
    const only = file('AGENTS.md', 5000)
    const rendered = renderWorkspaceContext([only], { maxBytes: 2000 })
    const overflow = describeBudgetOverflow(rendered, [only], 2000)!
    expect(overflow.logLine).toContain('truncated AGENTS.md (5000 bytes, kept')
    expect(overflow.notice.source).toMatchObject({ summary: 'Instruction budget exceeded: 1 file dropped or truncated' })
    expect(describeBudgetOverflow(renderWorkspaceContext([only], { maxBytes: 131072 }), [only], 131072)).toBeUndefined()
  })

  it('pins the exact notice source shape the transcript-only dispatch filter keys on', () => {
    const only = file('AGENTS.md', 5000)
    const overflow = describeBudgetOverflow(renderWorkspaceContext([only], { maxBytes: 2000 }), [only], 2000)!
    expect(overflow.notice.source).toEqual({
      kind: 'plugin',
      plugin: 'agent-instructions',
      form: 'notice',
      summary: 'Instruction budget exceeded: 1 file dropped or truncated',
    })
  })

  it('reports a size of 0 for an omitted file that was not observed', () => {
    const rendered = renderWorkspaceContext([file('a.md', 4000), file('b.md', 4000)], { maxBytes: 1500 })
    const overflow = describeBudgetOverflow(rendered, [], 1500)!
    expect(overflow.logLine).toContain('omitted a.md (0 bytes)')
    expect(overflow.notice.source).toMatchObject({ summary: 'Instruction budget exceeded: 2 files dropped or truncated' })
    expect(overflow.logLine).toContain('truncated b.md')
  })
})
