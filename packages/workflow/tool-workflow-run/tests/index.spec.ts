// Type-only: the engine package the later drill tests run against.
import type {} from '@deepseek-ai/dsh-workflow-worker-thread'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as ToolWorkflowRun from '../src/index.ts'

describe('tool-workflow-run scaffold', () => {
  it('declares its plugin identity and required services', () => {
    expect(ToolWorkflowRun.name).toBe('tool-workflow-run')
    expect(ToolWorkflowRun.inject).toEqual(['tools', 'workflowEngine'])
  })

  it('applies as a no-op on a real Context', () => {
    const ctx = new Context()
    expect(() => { ToolWorkflowRun.apply(ctx) }).not.toThrow()
  })
})
