import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import {
  explainWorkflowRefusal,
  WORKFLOW_LIST_ENDPOINT,
  WORKFLOW_LOOPBACK_ONLY_MESSAGE,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PRIVILEGED_ENDPOINTS,
  WORKFLOW_PRIVILEGED_METHODS,
  WORKFLOW_READ_METHODS,
} from '../src/index.ts'
import { setupRemote } from './support.ts'

describe('workflow-remote wire contract', () => {
  it('publishes the workflow namespace and the list endpoint', () => {
    expect(WORKFLOW_NAMESPACE).toBe('workflow')
    expect(WORKFLOW_LIST_ENDPOINT).toBe('workflow/list')
  })

  it('every @Remote method is exactly one of a read or a privileged method', async () => {
    const h = await setupRemote()
    const published = remoteMethods(h.service).map(marker => marker.method).sort()
    expect(published).toEqual([...WORKFLOW_READ_METHODS, ...WORKFLOW_PRIVILEGED_METHODS].sort())
    expect(new Set(published).size).toBe(published.length)
    await h.cleanup()
  })

  it('the privileged endpoint set equals the workflow entries of the connection layer PRIVILEGED_METHODS', () => {
    const source = readFileSync(join(import.meta.dirname, '../../../client/connection/src/index.ts'), 'utf8')
    const block = source.slice(source.indexOf('const PRIVILEGED_METHODS'), source.indexOf(']', source.indexOf("'workflow/save'")))
    const pinned = [...block.matchAll(/'(workflow\/[A-Za-z]+)'/g)].map(m => m[1]!).sort()
    expect(pinned).toEqual([...WORKFLOW_PRIVILEGED_ENDPOINTS].sort())
    for (const read of WORKFLOW_READ_METHODS) expect(pinned).not.toContain(`workflow/${read}`)
  })

  it('explains a loopback refusal of a privileged call, and nothing else', () => {
    for (const endpoint of WORKFLOW_PRIVILEGED_ENDPOINTS) {
      expect(explainWorkflowRefusal(endpoint, 403)).toBe(WORKFLOW_LOOPBACK_ONLY_MESSAGE)
      expect(explainWorkflowRefusal(endpoint, 500)).toBeUndefined()
    }
    expect(explainWorkflowRefusal('workflow/list', 403)).toBeUndefined()
    expect(WORKFLOW_LOOPBACK_ONLY_MESSAGE).toContain('loopback-only')
    expect(WORKFLOW_LOOPBACK_ONLY_MESSAGE).toContain('open dsh on the machine that hosts it')
  })
})
