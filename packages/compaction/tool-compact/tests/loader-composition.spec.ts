import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as toolCompact from '@deepseek-ai/dsh-tool-compact'

const COMPACTION_ID = CompactionId('loader-tool-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'loader summary' }],
  shadowedRange: { start: 3, end: 8 },
  shadowedSeqs: [3, 5, 8],
  shadowedTokenCount: 99,
}

class LoaderCompactionEngine extends CompactionEngine {
  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.resolve(RESULT)
  }

  override compactNow(agent: ManualCompactAgentContext): Promise<CompactionResult | null> {
    try {
      return agent.runMaintenance(async () => {
        agent.session.append('compaction/start', { compactionId: RESULT.compactionId, turn: null })
        agent.session.append('compaction/summary', {
          compactionId: RESULT.compactionId,
          summary: RESULT.summary,
          shadowedRange: RESULT.shadowedRange,
          shadowedSeqs: RESULT.shadowedSeqs,
          shadowedTokenCount: RESULT.shadowedTokenCount,
          provider: 'loader-test',
          model: 'loader-test',
        })
        agent.session.append('compaction/end', { compactionId: RESULT.compactionId, turn: null })
        return RESULT
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-compact real Loader composition through cordis.yml', () => {
  it('discovers compact, schedules it through the tool plane, and runs at idle', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-compact-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@test/compact-backend'",
      "- name: '@deepseek-ai/dsh-tool-compact'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', (await import('@deepseek-ai/dsh-system-prompt')).default],
      ['@deepseek-ai/dsh-tools', (await import('@deepseek-ai/dsh-tools')).default],
      ['@test/compact-backend', LoaderCompactionEngine],
      ['@deepseek-ai/dsh-tool-compact', toolCompact],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    expect(ctx.tools.schemas().some(entry => entry.name === 'compact')).toBe(true)

    const session = Session.create(SessionId('loader-tool-compact'))
    const agent = {
      id: SessionId('loader-tool-compact'),
      options: {},
      session,
      runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) =>
        task(new AbortController().signal),
    } as unknown as Agent

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-compact'),
      name: 'compact',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(false)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)

    ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(session.events.map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
  }, 30_000)
})
