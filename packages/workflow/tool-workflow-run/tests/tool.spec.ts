import { afterEach, describe, expect, it } from 'vitest'
import { COMPLETED, DEMO, setup, startTrusted } from './harness.ts'
import type { Harness } from './harness.ts'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text
}

describe('workflow_run tool', () => {
  it('dryRun returns the graph, gates and commands and spawns nothing', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const result = await h.execute({ name: 'demo', dryRun: true })
    expect(result.isError).toBeFalsy()
    const body = text(result)
    expect(body).toContain('Nothing was started')
    expect(body).toContain('build [bash]')
    expect(body).toContain('echo building')
    expect(h.shell.runCalls).toHaveLength(0)
    expect(h.engine.runs).toHaveLength(0)
  })

  it('compile errors come back as located diagnostics, not a stack', async () => {
    h = await setup()
    await h.writeWorkflow('bad', 'version: 1\nname: bad\nnodes:\n  - id: a\n    kind: bash\n    depends_on: [missing]\n    bash: echo hi\n')
    const result = await h.execute({ name: 'bad' })
    expect(result.isError).toBe(true)
    const body = text(result)
    expect(body).not.toMatch(/\n\s+at .*\.(ts|js):\d+/)
    expect(body).toMatch(/missing|bash/)
    expect(h.engine.runs).toHaveLength(0)
  })

  it('requires exactly one of name, path, resume or cancel', async () => {
    h = await setup()
    expect((await h.execute({})).isError).toBe(true)
    expect((await h.execute({ name: 'a', path: 'b' })).isError).toBe(true)
  })

  it('cancels a run owned by this process and rejects an unknown run id', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    const started = await startTrusted(h)
    const pending = h.execute({ cancel: started.runId })
    const cancelled = await pending
    expect(h.engine.runs[0]!.cancels).toHaveLength(1)
    expect(text(cancelled)).toContain('cancelled')
    await started.done
    const unknown = await h.execute({ cancel: 'nope' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('not running in this process')
  })

  it('a completed run returns the report as data', async () => {
    h = await setup()
    await h.writeWorkflow('demo', DEMO)
    await startTrusted(h)
    h.engine.runs[0]!.settle(COMPLETED)
    const again = h.execute({ name: 'demo' })
    await expect.poll(() => h!.engine.runs.length).toBe(2)
    h.engine.runs[1]!.settle(COMPLETED)
    const result = await again
    expect(result.isError).toBeFalsy()
  })
})
