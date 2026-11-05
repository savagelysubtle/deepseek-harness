/**
 * The deny-only decision: given the seat's policy and one tool call, return pass or a one-line deny
 * reason. There is no allow decision anywhere in this module; a pass only means "this layer has no
 * objection", and the caller prints nothing for it. Guard-reachable: erasable TypeScript only.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/decide
 */

import type { PolicyFileV1 } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { checkGlob, checkPath } from './path-guard.ts'
import type { Verdict } from './path-guard.ts'

/** Every native file tool a seat could hold. */
export const FILE_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob']

/** Tool-input keys that carry a filesystem path. */
const PATH_KEYS: readonly string[] = ['file_path', 'path', 'notebook_path']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Judge one tool call against the seat's policy.
 * An `mcp__` tool must be named in the policy tool list. Any other tool must be in the list too, and
 * every path-valued input (`file_path`, `path`, `notebook_path`; the Glob `pattern`; the Grep `glob`)
 * must stay inside the policy's roots and out of its protected prefixes.
 * @param policy - the validated policy file.
 * @param toolName - the `tool_name` from the hook input.
 * @param toolInput - the `tool_input` from the hook input.
 * @returns pass, or a deny with a one-line reason.
 */
export function decide(policy: PolicyFileV1, toolName: unknown, toolInput: unknown): Verdict {
  if (typeof toolName !== 'string' || toolName === '') return { ok: false, reason: 'tool_name is missing' }
  if (!policy.tools.includes(toolName)) return { ok: false, reason: `tool ${toolName} is not granted to this seat` }
  if (toolName.startsWith('mcp__')) return { ok: true }
  if (!isRecord(toolInput)) return { ok: false, reason: `tool_input of ${toolName} is not an object` }
  for (const key of PATH_KEYS) {
    const value = toolInput[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return { ok: false, reason: `${key} of ${toolName} is not a string` }
    const verdict = checkPath(policy, value)
    if (!verdict.ok) return { ok: false, reason: `${key}: ${verdict.reason}` }
  }
  const globKey = toolName === 'Glob' ? 'pattern' : toolName === 'Grep' ? 'glob' : undefined
  const glob = globKey === undefined ? undefined : toolInput[globKey]
  if (globKey !== undefined && glob !== undefined) {
    if (typeof glob !== 'string') return { ok: false, reason: `${globKey} of ${toolName} is not a string` }
    const verdict = checkGlob(policy, glob)
    if (!verdict.ok) return { ok: false, reason: `${globKey}: ${verdict.reason}` }
  }
  return { ok: true }
}
