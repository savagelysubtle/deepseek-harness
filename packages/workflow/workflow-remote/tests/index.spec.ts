import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import WorkflowRemoteService, {
  WORKFLOW_LIST_ENDPOINT,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PRIVILEGED_ENDPOINTS,
} from '../src/index.ts'

describe('workflow-remote scaffold', () => {
  it('publishes the workflow namespace and the list endpoint', () => {
    expect(WORKFLOW_NAMESPACE).toBe('workflow')
    expect(WORKFLOW_LIST_ENDPOINT).toBe('workflow/list')
    expect(WORKFLOW_PRIVILEGED_ENDPOINTS.size).toBe(0)
  })

  it('answers an empty roster from list', async () => {
    const ctx = new Context()
    const service = new WorkflowRemoteService(ctx)
    await expect(service.list()).resolves.toEqual([])
    await ctx.fiber.dispose()
  })
})
