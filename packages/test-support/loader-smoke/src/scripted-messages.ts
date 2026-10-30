/**
 * Message-list helpers for scripted test adapters that key their next
 * response off "was there already a tool result in this request."
 * @module @deepseek-ai/dsh-loader-smoke/scripted-messages
 */

import type { Message } from '@deepseek-ai/dsh-llm'

/**
 * Search backward through a request's message list for the most recent
 * tool-result content and return it joined as plain text.
 *
 * A scripted adapter must not assume the tool result sits at a fixed offset
 * from the end: a request may carry later steering or harness notices after
 * the tool result, so `messages.at(-1)` is not guaranteed to be it, and a
 * fixed offset only holds until another message is added. Scanning from the
 * end keeps working regardless of what trails the tool result.
 * @param messages - the full message list from a `GenerateOptions` stream call.
 * @returns the joined text of the last tool-result block found, or `''` when none exists.
 */
export function findLastToolResult(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const toolResultText = messages[index]?.content
      .filter(block => block.type === 'tool-result')
      .flatMap(block => block.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (toolResultText) return toolResultText
  }
  return ''
}
