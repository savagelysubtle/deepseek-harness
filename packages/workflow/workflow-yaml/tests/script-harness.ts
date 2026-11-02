/** A minimal stand-in for the worker-thread engine: runs a compiled script in a vm with fake hooks. */
import * as vm from 'node:vm'
import type { CompiledWorkflow } from '../src/index.ts'

interface BashCall { nodeId: string; command: string; opts: Record<string, unknown> }
export interface Harness {
  agentCalls: { prompt: string; opts: Record<string, unknown> }[]
  bashCalls: BashCall[]
  approvals: Record<string, unknown>[]
  events: string[]
  nodeErrors: Record<string, string>
  cancelled: string[]
}
export interface Hooks {
  agent?: (prompt: string, opts: Record<string, unknown>) => unknown
  bash?: (command: string, opts: Record<string, unknown>) => unknown
  approve?: (request: Record<string, unknown>) => unknown
}

export async function runScript(
  compiled: CompiledWorkflow, hooks: Hooks, args: unknown = {},
): Promise<{ value: unknown; harness: Harness }> {
  const harness: Harness = { agentCalls: [], bashCalls: [], approvals: [], events: [], nodeErrors: {}, cancelled: [] }
  const context = vm.createContext({
    args,
    agent: async (prompt: string, opts: Record<string, unknown>) => {
      harness.agentCalls.push({ prompt, opts })
      return hooks.agent === undefined ? 'agent text' : hooks.agent(prompt, opts)
    },
    bash: async (command: string, opts: Record<string, unknown>) => {
      harness.bashCalls.push({ nodeId: String(opts.nodeId), command, opts })
      return hooks.bash === undefined ? { exitCode: 0, stdout: 'ok\n', stderr: '' } : hooks.bash(command, opts)
    },
    approve: async (request: Record<string, unknown>) => {
      harness.approvals.push(request)
      return hooks.approve === undefined ? 'allowed-once' : hooks.approve(request)
    },
    cancel: (reason: string) => { harness.cancelled.push(reason); throw new Error(`CANCELLED: ${reason}`) },
    nodeStart: (id: string, kind: string) => { harness.events.push(`start ${id} ${kind}`) },
    nodeEnd: (id: string, info: { status: string; error?: string }) => {
      harness.events.push(`end ${id} ${info.status}`)
      if (info.error !== undefined) harness.nodeErrors[id] = info.error
    },
    gate: (id: string, kind: string, outcome: string) => { harness.events.push(`gate ${id} ${kind} ${outcome}`) },
    log: () => {},
    parallel: (thunks: (() => unknown)[]) => Promise.all(thunks.map(async (t) => {
      try {
        return await t()
      } catch (e) {
        if (String(e).includes('CANCELLED')) throw e
        return null
      }
    })),
  })
  const script = new vm.Script(`(async () => {\n${compiled.script}\n})()`, { filename: 'workflow:test' })
  const value = await (script.runInContext(context) as Promise<unknown>)
  return { value: JSON.parse(JSON.stringify(value)), harness }
}
