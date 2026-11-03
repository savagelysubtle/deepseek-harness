import { describe, expect, it } from 'vitest'
import { WORKFLOW_RUN_RECORD_VERSION } from '../src/index.ts'

describe('workflow-run-store scaffold', () => {
  it('stamps record schema version 1', () => {
    expect(WORKFLOW_RUN_RECORD_VERSION).toBe(1)
  })
})
