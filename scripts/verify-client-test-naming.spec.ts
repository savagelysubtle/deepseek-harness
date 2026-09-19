import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectClientTestNaming } from './verify-client-test-naming.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeTestFile(root: string, file: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'client-test-naming-'))
  roots.push(root)
  return root
}

describe('packages/client test naming gate', () => {
  it('accepts .client. and .host.spec.ts names, ignoring other packages', () => {
    const root = createWorkspace()
    writeTestFile(root, 'packages/client/ui-org-board/tests/board.client.spec.ts')
    writeTestFile(root, 'packages/client/ui-org-board/tests/panel.client.tsx')
    writeTestFile(root, 'packages/client/connection/tests/http-bridge.host.spec.ts')
    writeTestFile(root, 'packages/core/agent/tests/loop.spec.ts')

    expect(inspectClientTestNaming(root)).toEqual({ checkedCount: 3, failures: [] })
  })

  it('rejects a test file carrying neither marker and names it', () => {
    const root = createWorkspace()
    writeTestFile(root, 'packages/client/ui-org-board/tests/board.spec.ts')

    const report = inspectClientTestNaming(root)
    expect(report.checkedCount).toBe(1)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toContain('packages/client/ui-org-board/tests/board.spec.ts')
    expect(report.failures[0]).toContain('.client.')
    expect(report.failures[0]).toContain('.host.spec.ts')
  })

  it('rejects a .host. name that is missing the required .spec.ts suffix', () => {
    const root = createWorkspace()
    writeTestFile(root, 'packages/client/connection/tests/api-request-trust.host.ts')

    expect(inspectClientTestNaming(root).failures).toHaveLength(1)
  })
})
