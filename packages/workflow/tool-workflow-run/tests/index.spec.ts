import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as ToolWorkflowRun from '../src/index.ts'
import { setup } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

describe('tool-workflow-run plugin', () => {
  it('declares its plugin identity and required services', () => {
    expect(ToolWorkflowRun.name).toBe('tool-workflow-run')
    // The engine is optional: a composition without it (the web preset) must still settle.
    expect(ToolWorkflowRun.inject).toEqual(['tools'])
  })

  it('does not start without the tools service', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ToolWorkflowRun)).resolves.toBeDefined()
    expect((ctx as unknown as { workflowRuns?: unknown }).workflowRuns).toBeUndefined()
  })

  it('mounts the host runner and registers the tool', async () => {
    h = await setup()
    expect(h.ctx.workflowRuns).toBeDefined()
    const result = await h.execute({})
    expect((result.content[0] as { text: string }).text).toContain('exactly one of name')
  })
})
