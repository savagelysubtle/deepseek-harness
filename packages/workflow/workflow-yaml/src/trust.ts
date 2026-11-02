/**
 * Compiler-derived facts for the trust prompt: what a workflow will run, derived from the
 * validated document rather than any YAML-supplied label.
 * @module @deepseek-ai/dsh-workflow-yaml/trust
 */

import type { WorkflowDoc } from './types.ts'

/** Everything a human must see before trusting a workflow. */
export interface TrustFacts {
  name: string
  bashCommands: { nodeId: string; field: string; command: string; workdir?: string; envKeys: string[]; env: Record<string, string> }[]
  promptFiles: string[]
  agents: { nodeId: string; tier?: string; model?: string; provider?: string }[]
  approvalNodes: number
}

/** Derive the trust facts from a validated document. */
export function describeTrustFacts(doc: WorkflowDoc): TrustFacts {
  const facts: TrustFacts = { name: doc.name, bashCommands: [], promptFiles: [], agents: [], approvalNodes: 0 }
  for (const node of doc.nodes) {
    if (node.kind === 'bash') {
      facts.bashCommands.push({ nodeId: node.id, field: 'bash', command: node.bash,
        ...node.workdir === undefined ? {} : { workdir: node.workdir }, envKeys: Object.keys(node.env), env: { ...node.env } })
    } else if (node.kind === 'approval') facts.approvalNodes += 1
    else if (node.kind === 'prompt' || node.kind === 'loop') {
      if (node.promptFile !== undefined && !facts.promptFiles.includes(node.promptFile)) facts.promptFiles.push(node.promptFile)
      const tier = node.tier ?? doc.defaults.tier ?? 'standard'
      facts.agents.push({
        nodeId: node.id,
        ...node.model === undefined ? { tier } : { model: node.model },
        ...node.provider === undefined ? {} : { provider: node.provider },
      })
      if (node.kind === 'loop') {
        facts.bashCommands.push({ nodeId: node.id, field: 'until_bash', command: node.untilBash,
          ...node.workdir === undefined ? {} : { workdir: node.workdir }, envKeys: Object.keys(node.env), env: { ...node.env } })
      } else if (node.doneWhen !== undefined) {
        facts.bashCommands.push({ nodeId: node.id, field: 'done_when', command: node.doneWhen, envKeys: [], env: {} })
      }
    }
  }
  return facts
}
