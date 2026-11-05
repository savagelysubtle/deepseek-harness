import type { MailboxPublishInput } from '@deepseek-ai/dsh-mailbox'
import { scrubText } from '../../src/mcp/scrub.ts'
import type { SeatToolContext } from '../../src/mcp/types.ts'

/** A seat closure that records what it publishes and which taint marks it receives; override any field. */
export function makeContext(
  overrides: Partial<SeatToolContext> = {},
): SeatToolContext & { published: MailboxPublishInput[]; marks: string[]; warnings: string[] } {
  const published: MailboxPublishInput[] = []
  const marks: string[] = []
  const warnings: string[] = []
  const context: SeatToolContext = {
    seat: 'lead-one',
    sendTo: ['ops-lead', 'sam'],
    allowBlocking: false,
    isTainted: () => false,
    markTainted: (reason) => { marks.push(reason) },
    deliveredTraceIds: () => new Set(['trace-1']),
    publish: (input) => {
      published.push(input)
      return Promise.resolve('id-1')
    },
    newTraceId: () => 'fresh-trace',
    warn: (message) => { warnings.push(message) },
    scrub: text => scrubText(text, { roots: ['/home/op'] }),
    ...overrides,
  }
  return Object.assign(context, { published, marks, warnings })
}

/** The text of a tool result. */
export function textOf(result: { content: { text: string }[] }): string {
  return result.content.map(block => block.text).join('\n')
}

type Handler = (request: unknown, extra: unknown) => Promise<unknown>

interface Handlers {
  get(method: string): Handler | undefined
}

function handlerFor(instance: unknown, method: string): Handler {
  const handler = (instance as { server: { _requestHandlers: Handlers } }).server._requestHandlers.get(method)
  if (handler === undefined) throw new Error(`no ${method} handler`)
  return handler
}

/**
 * Call a tool through the SDK server's own MCP request handler, so the SDK's input validation runs
 * exactly as it does for the CLI.
 */
export async function callThroughServer(
  instance: unknown,
  name: string,
  args: unknown,
): Promise<{ content: { text: string }[]; isError?: boolean }> {
  const result = await handlerFor(instance, 'tools/call')({ method: 'tools/call', params: { name, arguments: args } }, { signal: new AbortController().signal })
  return result as { content: { text: string }[]; isError?: boolean }
}

/** List the tools the SDK server advertises. */
export async function listThroughServer(instance: unknown): Promise<{ name: string; inputSchema: Record<string, unknown> }[]> {
  const result = await handlerFor(instance, 'tools/list')({ method: 'tools/list', params: {} }, {})
  return (result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools
}
