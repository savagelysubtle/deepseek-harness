/**
 * Maps the SDK message stream to dsh session records from NAMED fields only.
 * No SDK object is ever spread or stored: every output is rebuilt field by
 * field, and tool arguments and results never leave this module except as a
 * keyed digest and a success flag.
 *
 * | SDK message | dsh record |
 * |---|---|
 * | `system` / `init` | `claude-code/session-bound` when Claude reports a different session id |
 * | `assistant` text block | `assistant/message`, cut to a bounded length and token-redacted |
 * | `assistant` tool_use + `user` tool_result | `claude-code/tool-call {name, ok, ms, argDigest}` |
 * | `assistant` thinking block | `claude-code/thinking {length}` |
 * | `system` / `compact_boundary` | `claude-code/compact {trigger, preTokens, postTokens?}` |
 * | `result` | `claude-code/turn-completed` (written by the agent) |
 * | anything else | `claude-code/unmapped {type}`, once per type per turn |
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/mapper
 */

import { createHmac } from 'node:crypto'
import { redactTokens } from '@deepseek-ai/dsh-agent-claude-code'
import type { ClaudeCodeEventInputMap } from '@deepseek-ai/dsh-agent-claude-code'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** The event types the mapper writes itself. */
export type MapperEventType =
  | 'claude-code/tool-call'
  | 'claude-code/thinking'
  | 'claude-code/unmapped'
  | 'claude-code/compact'

/** Where the mapper sends what it understood. */
export interface MapperSink {
  /** Record one driver event. */
  readonly record: <Type extends MapperEventType>(type: Type, data: ClaudeCodeEventInputMap[Type]) => void
  /** One assistant text, already token-redacted. */
  readonly assistantText: (text: string) => void
  /** Claude reported the session id it is really running under. */
  readonly sessionInit: (init: { readonly sdkSessionId: string; readonly model: string }) => void
  /** A tool call started; lets the agent track taint (file reads and fetches). */
  readonly toolStarted: (name: string) => void
}

/** Digest length in hexadecimal characters: enough to correlate repeated calls, and keyed so it cannot be brute-forced offline. */
const DIGEST_HEX_CHARS = 16

/** Largest tool-input JSON the mapper will digest; past this only the size is kept. */
const MAX_DIGEST_INPUT_CHARS = 1_000_000

/**
 * Most characters of one assistant text that are redacted and logged. The redaction patterns are not linear on
 * adversarial input (a long run of `a-a-a-...` re-anchors a pattern at every word boundary), so the text is cut
 * BEFORE redaction; the cut is marked in the log.
 */
export const MAX_ASSISTANT_TEXT_CHARS = 16_000

/** Characters a credential can be made of; a cut that lands inside such a run could leave a recognisable prefix. */
const TOKEN_CHAR = /[\w.-]/

/**
 * Cut a text to {@link MAX_ASSISTANT_TEXT_CHARS} before any pattern touches it, drop the trailing token-like run
 * the cut landed in (a half-cut credential keeps a prefix no pattern would still recognise), and note how much
 * was dropped.
 */
function boundedAssistantText(text: string): string {
  if (text.length <= MAX_ASSISTANT_TEXT_CHARS) return redactTokens(text)
  let end = MAX_ASSISTANT_TEXT_CHARS
  while (end > 0 && TOKEN_CHAR.test(text.charAt(end - 1))) end -= 1
  return `${redactTokens(text.slice(0, end))}\n[truncated ${text.length - end} characters]`
}

/** Plain object read that survives getters that throw. */
function read(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** A non-negative finite number, else undefined. */
function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

interface PendingCall {
  readonly name: string
  readonly argDigest: string
  readonly startedAt: number
}

/** Stateful mapper for one turn's stream. */
export class StreamMapper {
  private readonly pending = new Map<string, PendingCall>()
  private readonly unmappedSeen = new Set<string>()

  /**
   * @param sink - receives everything the mapper understood.
   * @param now - wall clock in epoch milliseconds.
   * @param key - per-process secret that keys the argument digest; never written anywhere.
   */
  constructor(
    private readonly sink: MapperSink,
    private readonly now: () => number,
    private readonly key: Uint8Array,
  ) {}

  /** Size or keyed digest of a tool input; never a plain hash, never the input itself. */
  private digest(input: unknown): string {
    let json: string | undefined
    try {
      json = JSON.stringify(input)
    } catch {
      json = undefined
    }
    if (json === undefined) return 'len:0'
    if (json.length > MAX_DIGEST_INPUT_CHARS) return `len:${json.length}`
    return `hmac:${createHmac('sha256', this.key).update(json).digest('hex').slice(0, DIGEST_HEX_CHARS)}`
  }

  /**
   * Map one SDK message.
   * @param message - the next message of the query stream.
   */
  map(message: SDKMessage): void {
    const type: unknown = read(message, 'type')
    switch (type) {
      case 'system':
        this.mapSystem(message)
        return
      case 'assistant':
        this.mapAssistant(message)
        return
      case 'user':
        this.mapUser(message)
        return
      case 'result':
      case 'rate_limit_event':
        // Written (or acted on) by the agent itself: the turn-completed record and the pause logic.
        return
      default:
        this.unmapped(typeof type === 'string' ? type : 'unknown')
    }
  }

  private unmapped(type: string): void {
    if (this.unmappedSeen.has(type)) return
    this.unmappedSeen.add(type)
    this.sink.record('claude-code/unmapped', { type, at: this.now() })
  }

  private mapSystem(message: SDKMessage): void {
    const subtype: unknown = read(message, 'subtype')
    if (subtype === 'init') {
      const sdkSessionId: unknown = read(message, 'session_id')
      const model: unknown = read(message, 'model')
      if (typeof sdkSessionId === 'string' && sdkSessionId !== '') {
        this.sink.sessionInit({ sdkSessionId, model: typeof model === 'string' ? model : '' })
      }
      return
    }
    if (subtype === 'compact_boundary') {
      const metadata = read(message, 'compact_metadata')
      const trigger: unknown = read(metadata, 'trigger')
      const postTokens = amount(read(metadata, 'post_tokens'))
      if (trigger === 'manual' || trigger === 'auto') {
        this.sink.record('claude-code/compact', {
          trigger,
          preTokens: amount(read(metadata, 'pre_tokens')) ?? 0,
          ...postTokens === undefined ? {} : { postTokens },
          at: this.now(),
        })
        return
      }
    }
    this.unmapped(`system/${typeof subtype === 'string' ? subtype : 'unknown'}`)
  }

  private mapAssistant(message: SDKMessage): void {
    // An assistant message carrying an error is the CLI's error notice, not model output.
    if (read(message, 'error') !== undefined) return
    const content: unknown = read(read(message, 'message'), 'content')
    if (!Array.isArray(content)) return
    const texts: string[] = []
    for (const block of content as unknown[]) {
      const blockType: unknown = read(block, 'type')
      if (blockType === 'text') {
        const text: unknown = read(block, 'text')
        if (typeof text === 'string') texts.push(text)
      } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        const body: unknown = read(block, blockType === 'thinking' ? 'thinking' : 'data')
        this.sink.record('claude-code/thinking', { length: typeof body === 'string' ? body.length : 0, at: this.now() })
      } else if (blockType === 'tool_use') {
        const id: unknown = read(block, 'id')
        const name: unknown = read(block, 'name')
        const label = typeof name === 'string' && name !== '' ? name : 'unknown'
        this.sink.toolStarted(label)
        if (typeof id === 'string' && id !== '') {
          this.pending.set(id, { name: label, argDigest: this.digest(read(block, 'input')), startedAt: this.now() })
        }
      }
    }
    const text = texts.join('')
    if (text !== '') this.sink.assistantText(boundedAssistantText(text))
  }

  private mapUser(message: SDKMessage): void {
    const content: unknown = read(read(message, 'message'), 'content')
    if (!Array.isArray(content)) return
    for (const block of content as unknown[]) {
      if (read(block, 'type') !== 'tool_result') continue
      const id: unknown = read(block, 'tool_use_id')
      const call = typeof id === 'string' ? this.pending.get(id) : undefined
      if (typeof id === 'string') this.pending.delete(id)
      this.sink.record('claude-code/tool-call', {
        name: call?.name ?? 'unknown',
        ok: read(block, 'is_error') !== true,
        ms: call === undefined ? 0 : Math.max(0, this.now() - call.startedAt),
        argDigest: call?.argDigest ?? 'len:0',
        at: this.now(),
      })
    }
  }
}
