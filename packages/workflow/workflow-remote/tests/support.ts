/** Test support: the real runner over the stub engine, with the Remote service mounted beside it. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import WorkflowRemoteService from '../src/index.ts'
import { setup as setupRunner } from '../../tool-workflow-run/tests/harness.ts'
import type { Harness } from '../../tool-workflow-run/tests/harness.ts'

export { COMPLETED, DEMO } from '../../tool-workflow-run/tests/harness.ts'

/** The runner harness plus a mounted service and a way to make callers in other workspaces. */
export interface Remote extends Harness {
  readonly service: WorkflowRemoteService
  /** A fake calling session whose workspace is `cwd` (default: the harness workspace; null for none). */
  agent(id?: string, cwd?: string | null): Agent
  /** A fresh empty directory, removed with the harness. */
  scratch(): Promise<string>
}

/**
 * Build the harness.
 * @param options - forwarded to the runner harness.
 * @returns the harness with a mounted Remote service.
 */
export async function setupRemote(options: Parameters<typeof setupRunner>[0] = {}): Promise<Remote> {
  const base = await setupRunner(options)
  const service = new WorkflowRemoteService(base.ctx)
  const scratches: string[] = []
  const baseCleanup = base.cleanup.bind(base)
  return Object.assign(base, {
    service,
    agent(id = 'parent', cwd: string | null = base.workspace) {
      const sid = SessionId(id)
      const session = Session.create(sid, [], { version: 0, id: sid, createdAt: 0, ...cwd === null ? {} : { cwd } })
      return { id: sid, options: { model: 'test-model' }, session } as unknown as Agent
    },
    async scratch() {
      const dir = await mkdtemp(join(tmpdir(), 'wfremote-'))
      scratches.push(dir)
      return dir
    },
    async cleanup() {
      await baseCleanup()
      for (const dir of scratches) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
    },
  })
}
