/**
 * Operator-visible description of a baseline that exceeded the byte budget.
 *
 * @module @deepseek-ai/dsh-agent-instructions/overflow
 */

import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { LoadedInstructionFile } from './files.ts'
import type { RenderedWorkspaceContext } from './render.ts'

/** Host-log line plus session notice for one over-budget baseline. */
export interface BudgetOverflow {
  /** Stable text for host-log warnings and deduplication. */
  logLine: string
  /** Durable, UI-visible `notice` message for the session transcript. */
  notice: UserMessage
}

const encoder = new TextEncoder()

function sizeOf(text: string): number {
  return encoder.encode(text).byteLength
}

/**
 * Describe dropped or truncated instruction files.
 * @param rendered - bounded baseline rendering and its omission records.
 * @param observed - files read before budgeting, used for original byte sizes.
 * @param maxBytes - configured byte budget.
 * @returns the log line and session notice, or undefined when nothing was dropped or truncated.
 */
export function describeBudgetOverflow(
  rendered: RenderedWorkspaceContext,
  observed: readonly LoadedInstructionFile[],
  maxBytes: number,
): BudgetOverflow | undefined {
  if (rendered.omitted.length === 0 && rendered.truncated.length === 0) return undefined
  const sizes = new Map(observed.map(file => [file.absolutePath, sizeOf(file.content)]))
  const parts = [
    ...rendered.omitted.map(file => `omitted ${file.displayPath} (${sizes.get(file.absolutePath) ?? 0} bytes)`),
    ...rendered.truncated.map(item => `truncated ${item.displayPath} (${item.originalBytes} bytes, kept ${item.includedBytes})`),
  ]
  const renderedBytes = sizeOf(rendered.text)
  const logLine = `workspace instruction budget ${maxBytes} bytes exceeded; rendered ${renderedBytes} bytes; ${parts.join('; ')}`
  const text = `Workspace instruction budget of ${maxBytes} bytes was exceeded (rendered ${renderedBytes} bytes): `
    + `${parts.join('; ')}. Raise agent-instructions maxBytes or shrink the files.`
  const dropped = rendered.omitted.length + rendered.truncated.length
  const notice = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'agent-instructions',
      form: 'notice',
      summary: boundContextSummary(`Instruction budget exceeded: ${dropped} file${dropped === 1 ? '' : 's'} dropped or truncated`),
    },
  })
  return { logLine, notice }
}
