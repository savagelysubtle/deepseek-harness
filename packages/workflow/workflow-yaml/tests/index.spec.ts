import { describe, expect, it } from 'vitest'
import { WORKFLOW_YAML_SCHEMA_VERSION } from '../src/index.ts'

describe('workflow-yaml scaffold', () => {
  it('declares schema version 1', () => {
    expect(WORKFLOW_YAML_SCHEMA_VERSION).toBe(1)
  })
})
