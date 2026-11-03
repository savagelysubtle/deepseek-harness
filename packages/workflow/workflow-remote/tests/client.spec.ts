import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as client from '../src/client/index.ts'
import * as wire from '../src/wire.ts'

describe('client face', () => {
  it('re-exports the wire module and nothing else', () => {
    expect(Object.keys(client).sort()).toEqual(Object.keys(wire).sort())
    expect(client.WORKFLOW_ATTACH_RENEW_MS).toBe(15_000)
    expect(client.WORKFLOW_ATTACH_TTL_MS).toBe(45_000)
  })

  it('reaches no module that is not browser-safe: the wire file has no value imports', () => {
    for (const file of ['../src/wire.ts', '../src/client/index.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      const imports = text.split('\n').filter(line => /^\s*(import\b|export .* from )/.test(line))
      // The only allowed import is the erased `import type {}` that anchors the cordis augmentation.
      expect(imports.filter(line => !line.includes('../wire.ts') && line.trim() !== "import type {} from '@deepseek-ai/cordis'")).toEqual([])
    }
  })
})

describe('explainWorkflowRejection', () => {
  it('explains a 403 carrier failure, a rejection and plain text on a privileged endpoint', () => {
    const message = client.WORKFLOW_LOOPBACK_ONLY_MESSAGE
    expect(client.explainWorkflowRejection('workflow/save', { message: 'request failed: HTTP 403' })).toBe(message)
    expect(client.explainWorkflowRejection('workflow/nodeOutput', new Error('HTTP 403 forbidden'))).toBe(message)
    expect(client.explainWorkflowRejection('workflow/run', 'HTTP 403')).toBe(message)
  })

  it('stays silent for reads, other statuses and unrelated causes', () => {
    expect(client.explainWorkflowRejection('workflow/list', { message: 'HTTP 403' })).toBeUndefined()
    expect(client.explainWorkflowRejection('workflow/save', { message: 'HTTP 500' })).toBeUndefined()
    expect(client.explainWorkflowRejection('workflow/save', { message: 'network down' })).toBeUndefined()
    expect(client.explainWorkflowRejection('workflow/save', undefined)).toBeUndefined()
    expect(client.explainWorkflowRejection('workflow/save', 42)).toBeUndefined()
  })
})
