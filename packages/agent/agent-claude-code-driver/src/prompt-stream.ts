/**
 * The open prompt iterable of one streaming-input turn. The SDK keeps the
 * query alive while this iterable is open, so pushing a message into it is
 * how mail steers a turn that is already running.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/prompt-stream
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** A single-consumer async queue of SDK user messages with an explicit end. */
export class PromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private waiter: PromiseWithResolvers<IteratorResult<SDKUserMessage>> | undefined
  private ended = false

  /** Whether {@link end} has been called; a closed stream rejects pushes. */
  get closed(): boolean {
    return this.ended
  }

  /**
   * Hand one message to the consumer.
   * @param message - the user message to deliver.
   * @throws when the stream is already closed.
   */
  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('agent-claude-code-driver: prompt stream is closed')
    const waiter = this.waiter
    if (waiter === undefined) {
      this.queue.push(message)
      return
    }
    this.waiter = undefined
    waiter.resolve({ value: message, done: false })
  }

  /** End the stream; queued messages are still delivered, then the consumer sees completion. */
  end(): void {
    if (this.ended) return
    this.ended = true
    const waiter = this.waiter
    if (waiter === undefined) return
    this.waiter = undefined
    waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.queue.shift()
        if (next !== undefined) return Promise.resolve({ value: next, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        this.waiter = Promise.withResolvers()
        return this.waiter.promise
      },
      return: () => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
