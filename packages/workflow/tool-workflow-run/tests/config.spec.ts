import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('config', () => {
  it('exposeTool true registers workflow_run and false mounts only the service', async () => {
    h = await setup()
    expect(h.ctx.tools.schemas().map(schema => schema.name)).toContain('workflow_run')
    await h.cleanup()
    h = await setup({ config: { exposeTool: false } })
    expect(h.ctx.tools.schemas().map(schema => schema.name)).not.toContain('workflow_run')
    expect(h.ctx.workflowRuns).toBeDefined()
    expect(await h.ctx.workflowRuns.listWorkflows(h.workspace)).toEqual([])
  })

  it('fills the documented defaults', () => {
    const resolved = Config({})
    expect(resolved).toMatchObject({
      toolName: 'workflow_run',
      exposeTool: true,
      workflowsDir: '.workflows',
      approvalWaitMs: 3_600_000,
      headless: false,
      trustPolicy: 'ask',
      retention: 200,
      maxResultChars: 50_000,
      tierModels: { cheap: 'haiku', standard: 'sonnet', premium: 'opus' },
    })
  })

  it('rejects an approval wait over 24 hours', () => {
    expect(() => Config({ approvalWaitMs: 25 * 60 * 60 * 1000 })).toThrow()
  })

  it('refuses to start with a denied model in the tier table', async () => {
    await expect(setup({ config: { tierModels: { premium: 'fable-5' } } })).rejects.toThrow(/tierModels rejected/)
  })

  it('refuses to start with a workflows directory outside the workspace', async () => {
    await expect(setup({ config: { workflowsDir: '../escape' } })).rejects.toThrow(/workflowsDir/)
    await expect(setup({ config: { workflowsDir: '/abs' } })).rejects.toThrow(/workflowsDir/)
  })
})
