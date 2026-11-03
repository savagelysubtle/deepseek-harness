import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { namesDeniedModel } from '../src/model-guard.ts'
import WorkerThreadWorkflowEngine from '../src/index.ts'

vi.setConfig({ testTimeout: 30_000 })

/** A catalog whose friendly name for an innocuous id names the denied family. */
class AliasCatalog extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === 'broken-catalog') return Promise.reject(new Error('catalog down'))
    return Promise.resolve({ provider, id: model, name: model === 'big-alias' ? 'Fable Large' : model })
  }
}

async function run(model: string | undefined, script: string, extra: Partial<WorkflowStartRequest> = {}, parentModel?: string) {
  const seen: SubagentStartRequest[] = []
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['catalog'], new AliasCatalog([]))
  await ctx.plugin(SubagentRuntime)
  const provider: SubagentProvider = {
    name: 'stub',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    inheritsParentContext: false,
    start: (request) => {
      seen.push(request)
      const result: SubagentResult = { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
      return Promise.resolve({ id: SessionId('c'), localAgent: undefined, result: Promise.resolve(result),
        dispose: () => Promise.resolve() })
    },
  }
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'stub', disposeGraceMs: 500 })
  const parent = {
    id: SessionId('guard-parent'),
    options: { provider: 'catalog', ...parentModel === undefined ? {} : { model: parentModel } },
  } as unknown as Agent
  const handle = ctx.workflowEngine.start({ script, meta: { name: 'guard', description: 'model guard' }, parent, ...extra })
  try {
    return { result: await handle.result, seen }
  } finally {
    await handle.dispose()
  }
  void model
}

describe('namesDeniedModel', () => {
  it('folds case, width, invisible characters and separators', () => {
    for (const text of ['fable', 'Claude-FABLE-5', 'ＦＡＢＬＥ', 'fa​ble', 'f-a-b-l-e', 'anthropic/fable:2026']) {
      expect(namesDeniedModel(text)).toBe(true)
    }
    for (const text of ['haiku', 'sonnet', 'opus', 'gpt-5']) expect(namesDeniedModel(text)).toBe(false)
  })
})

describe('spawn-time model guard', () => {
  it('refuses a tier whose resolved model names the denied family', async () => {
    const { result, seen } = await run(undefined, "return await agent('p', { tier: 'premium' })",
      { tierModels: { premium: 'claude-FABLE-5' } })
    expect(result.error ?? JSON.stringify(result.value)).toContain('denied model family')
    expect(seen).toHaveLength(0)
  })

  it('refuses a model inherited from the parent agent', async () => {
    const { result, seen } = await run(undefined, "return await agent('p')", {}, 'fable-5')
    expect(result.error ?? JSON.stringify(result.value)).toContain('denied model family')
    expect(seen).toHaveLength(0)
  })

  it('refuses an alias whose catalog name resolves to the denied family', async () => {
    const { result, seen } = await run(undefined, "return await agent('p', { model: 'big-alias' })")
    expect(result.error ?? JSON.stringify(result.value)).toContain('denied model family')
    expect(seen).toHaveLength(0)
  })

  it('lets an allowed model through', async () => {
    const { result, seen } = await run(undefined, "return await agent('p', { model: 'sonnet' })")
    expect(result.stopReason).toBe('completed')
    expect(seen).toHaveLength(1)
  })

  it('refuses when the final model cannot be determined', async () => {
    const { result, seen } = await run(undefined, "return await agent('p')")
    expect(result.error ?? JSON.stringify(result.value)).toContain('cannot be determined')
    expect(seen).toHaveLength(0)
  })

  it('refuses when the catalog lookup fails instead of skipping the check', async () => {
    const { result, seen } = await run(undefined, "return await agent('p', { model: 'broken-catalog' })")
    expect(result.error ?? JSON.stringify(result.value)).toContain('could not be checked')
    expect(seen).toHaveLength(0)
  })

  it('skips the catalog check but keeps the denylist when no adapter is registered', async () => {
    const ok = await run(undefined, "return await agent('p', { provider: 'unregistered', model: 'sonnet' })")
    expect(ok.result.stopReason).toBe('completed')
    expect(ok.seen).toHaveLength(1)
    const denied = await run(undefined, "return await agent('p', { provider: 'unregistered', model: 'claude-fable-5' })")
    expect(denied.result.error ?? JSON.stringify(denied.result.value)).toContain('denied model family')
    expect(denied.seen).toHaveLength(0)
  })
})
