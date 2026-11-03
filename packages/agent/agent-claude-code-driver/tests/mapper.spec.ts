import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { MAX_ASSISTANT_TEXT_CHARS, StreamMapper } from '../src/mapper.ts'
import type { MapperSink } from '../src/mapper.ts'

interface Seen {
  records: Array<{ type: string; data: unknown }>
  texts: string[]
  inits: Array<{ sdkSessionId: string; model: string }>
  tools: string[]
}

function rig(key: Uint8Array = new Uint8Array(32).fill(7)): { mapper: StreamMapper; seen: Seen; clock: { now: number } } {
  const seen: Seen = { records: [], texts: [], inits: [], tools: [] }
  const clock = { now: 1000 }
  const sink: MapperSink = {
    record: (type: string, data: unknown) => { seen.records.push({ type, data }) },
    assistantText: (text) => { seen.texts.push(text) },
    sessionInit: (init) => { seen.inits.push(init) },
    toolStarted: (name) => { seen.tools.push(name) },
  }
  return { mapper: new StreamMapper(sink, () => clock.now, key), seen, clock }
}

const msg = (value: unknown): SDKMessage => value as SDKMessage

const assistant = (...content: unknown[]): SDKMessage => msg({ type: 'assistant', message: { content } })

describe('system messages', () => {
  it('reports init with the session id and model, and ignores one without an id', () => {
    const { mapper, seen } = rig()
    mapper.map(msg({ type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-sonnet-x', tools: ['Read'], cwd: '/secret/path' }))
    mapper.map(msg({ type: 'system', subtype: 'init', session_id: 'sdk-2' }))
    mapper.map(msg({ type: 'system', subtype: 'init', model: 'x' }))
    expect(seen.inits).toEqual([{ sdkSessionId: 'sdk-1', model: 'claude-sonnet-x' }, { sdkSessionId: 'sdk-2', model: '' }])
    expect(seen.records).toEqual([])
  })

  it('maps compact_boundary with and without post_tokens, from named fields only', () => {
    const { mapper, seen } = rig()
    mapper.map(msg({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000, preserved_segment: { secret: 'x' } },
    }))
    mapper.map(msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: -5 } }))
    expect(seen.records).toEqual([
      { type: 'claude-code/compact', data: { trigger: 'auto', preTokens: 150000, postTokens: 20000, at: 1000 } },
      { type: 'claude-code/compact', data: { trigger: 'manual', preTokens: 0, at: 1000 } },
    ])
  })

  it('records a compact_boundary with an unknown trigger and any other system subtype as unmapped, once each', () => {
    const { mapper, seen } = rig()
    mapper.map(msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'odd', pre_tokens: 1 } }))
    mapper.map(msg({ type: 'system', subtype: 'compact_boundary' }))
    mapper.map(msg({ type: 'system', subtype: 'hook_started' }))
    mapper.map(msg({ type: 'system', subtype: 'hook_started' }))
    mapper.map(msg({ type: 'system' }))
    expect(seen.records.map(entry => (entry.data as { type: string }).type)).toEqual([
      'system/compact_boundary', 'system/hook_started', 'system/unknown',
    ])
  })
})

describe('assistant and user messages', () => {
  it('redacts token shapes in assistant text and joins its text blocks', () => {
    const { mapper, seen } = rig()
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'
    mapper.map(assistant(
      { type: 'text', text: 'key sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx and ' },
      { type: 'text', text: `ghp_${'a'.repeat(30)} and ${jwt}` },
      { type: 'text', text: 7 },
      { type: 'image' },
    ))
    expect(seen.texts).toHaveLength(1)
    expect(seen.texts[0]).not.toMatch(/sk-ant|ghp_|eyJ/)
    expect(seen.texts[0]).toContain('[redacted]')
  })

  it('redacts more credential shapes in assistant text, whatever their case', () => {
    const { mapper, seen } = rig()
    const hex32 = '0123456789abcdef0123456789abcdef'
    const secrets = [
      'sk_live_AbCdEfGhIjKlMnOp1234', 'whsec_AbCdEfGhIjKlMnOp1234', `SK${hex32}`, `AC${hex32}`, 'ASIAIOSFODNN7EXAMPLE',
      `AIza${'A1b2C3d4E5'.repeat(4)}`, `glpat-${'abcDEF123456'.repeat(2)}`, `npm_${'aB3dE6gH9jK2mN5pQ8sT'.repeat(2)}`,
      'SK-ANT-OAT01-AbCdEfGhIjKlMnOpQrStUvWx',
    ]
    mapper.map(assistant({ type: 'text', text: `${secrets.join(' | ')}\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----` }))
    const text = seen.texts[0] as string
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).not.toMatch(/PRIVATE KEY|MIIEvQ/)
  })

  it('cuts a huge assistant text before redacting and marks the cut, and an adversarial run stays fast', () => {
    const { mapper, seen } = rig()
    const hostile = 'a-'.repeat(500_000)
    const started = performance.now()
    mapper.map(assistant({ type: 'text', text: hostile }))
    expect(performance.now() - started).toBeLessThan(100)
    const text = seen.texts[0] as string
    // The whole run is token-like, so the cut drops all of it rather than leave a prefix.
    expect(text).toBe(`\n[truncated ${hostile.length} characters]`)
    expect(text.length).toBeLessThan(MAX_ASSISTANT_TEXT_CHARS + 60)
  })

  it('drops the credential-like run the cut lands in, so no secret prefix survives', () => {
    const hex32 = '0123456789abcdef0123456789abcdef'
    for (const secret of [`AC${hex32}`, 'AKIAIOSFODNN7EXAMPLE', `ASIA${'A1B2C3D4E5'.repeat(2)}`, `ghp_${'a1B2c3D4e5'.repeat(3)}`, 'npm_aB3dE6gH9jK2mN5pQ8sT']) {
      const { mapper, seen } = rig()
      // The cut lands three characters before the end of the secret.
      const text = `${' '.repeat(MAX_ASSISTANT_TEXT_CHARS - (secret.length - 3))}${secret} tail words`
      mapper.map(assistant({ type: 'text', text }))
      const out = seen.texts[0] as string
      expect(out).not.toContain(secret.slice(0, 6))
      expect(out).toMatch(/\[truncated \d+ characters\]$/)
    }
  })

  it('keeps everything up to a cut that lands on whitespace, and counts only what was dropped', () => {
    const { mapper, seen } = rig()
    const text = 'word '.repeat(4000)
    mapper.map(assistant({ type: 'text', text }))
    const out = seen.texts[0] as string
    expect(out.startsWith('word '.repeat(3200))).toBe(true)
    expect(out.endsWith('\n[truncated 4000 characters]')).toBe(true)
  })

  it('keeps a text of exactly the cap whole, with no marker', () => {
    const { mapper, seen } = rig()
    mapper.map(assistant({ type: 'text', text: 'w'.repeat(MAX_ASSISTANT_TEXT_CHARS) }))
    expect(seen.texts[0]).toBe('w'.repeat(MAX_ASSISTANT_TEXT_CHARS))
  })

  it('writes nothing for an assistant error notice, non-array content, or empty text', () => {
    const { mapper, seen } = rig()
    mapper.map(msg({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'limit' }] } }))
    mapper.map(msg({ type: 'assistant', message: { content: 'plain' } }))
    mapper.map(msg({ type: 'assistant' }))
    mapper.map(assistant({ type: 'text', text: '' }))
    expect(seen.texts).toEqual([])
    expect(seen.records).toEqual([])
  })

  it('records thinking by length only, including redacted thinking', () => {
    const { mapper, seen } = rig()
    mapper.map(assistant(
      { type: 'thinking', thinking: 'a'.repeat(120), signature: 'sig' },
      { type: 'redacted_thinking', data: 'x'.repeat(40) },
      { type: 'thinking', thinking: 5 },
    ))
    expect(seen.records.map(entry => entry.data)).toEqual([
      { length: 120, at: 1000 }, { length: 40, at: 1000 }, { length: 0, at: 1000 },
    ])
    expect(JSON.stringify(seen.records)).not.toContain('sig')
  })

  it('pairs a tool_use with its tool_result and records name, ok, duration and a keyed digest, never bodies', () => {
    const { mapper, seen, clock } = rig()
    mapper.map(assistant({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/steve/secret.txt' } }))
    clock.now = 1250
    mapper.map(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOP SECRET BODY' }] } }))
    expect(seen.tools).toEqual(['Read'])
    expect(seen.records).toHaveLength(1)
    const data = seen.records[0]!.data as { name: string; ok: boolean; ms: number; argDigest: string }
    expect(data).toMatchObject({ name: 'Read', ok: true, ms: 250, at: 1250 })
    expect(data.argDigest).toMatch(/^hmac:[0-9a-f]{16}$/)
    expect(JSON.stringify(seen.records)).not.toMatch(/secret|SECRET|steve/)
  })

  it('flags an erroring result, tolerates an unmatched result and a tool_use without an id or name', () => {
    const { mapper, seen } = rig()
    mapper.map(assistant({ type: 'tool_use', id: 't2', name: 'Edit', input: {} }, { type: 'tool_use', input: {} }, { type: 'tool_use', id: '' }))
    mapper.map(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }, { type: 'tool_result' }, { type: 'text' }] } }))
    mapper.map(msg({ type: 'user', message: { content: 'echo' } }))
    mapper.map(msg({ type: 'user' }))
    expect(seen.tools).toEqual(['Edit', 'unknown', 'unknown'])
    expect(seen.records.map(entry => entry.data)).toMatchObject([
      { name: 'Edit', ok: false }, { name: 'unknown', ok: true, ms: 0, argDigest: 'len:0' },
    ])
  })

  it('keys the digest: the same input and key repeat, another key or input differs, odd inputs fall back to a size', () => {
    const digestOf = (key: Uint8Array, input: unknown): string => {
      const { mapper, seen } = rig(key)
      mapper.map(assistant({ type: 'tool_use', id: 't', name: 'X', input }))
      mapper.map(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }))
      return (seen.records[0]!.data as { argDigest: string }).argDigest
    }
    const keyA = new Uint8Array(32).fill(1)
    const keyB = new Uint8Array(32).fill(2)
    expect(digestOf(keyA, { a: 1 })).toBe(digestOf(keyA, { a: 1 }))
    expect(digestOf(keyA, { a: 1 })).not.toBe(digestOf(keyB, { a: 1 }))
    expect(digestOf(keyA, { a: 1 })).not.toBe(digestOf(keyA, { a: 2 }))
    expect(digestOf(keyA, 'z'.repeat(1_000_001))).toBe('len:1000003')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(digestOf(keyA, circular)).toBe('len:0')
    expect(digestOf(keyA, undefined)).toBe('len:0')
  })
})

describe('everything else', () => {
  it('leaves result and rate_limit_event to the agent and records any other type as unmapped once per turn', () => {
    const { mapper, seen } = rig()
    mapper.map(msg({ type: 'result', subtype: 'success' }))
    mapper.map(msg({ type: 'rate_limit_event' }))
    mapper.map(msg({ type: 'stream_event', event: { payload: 'x' } }))
    mapper.map(msg({ type: 'stream_event' }))
    mapper.map(msg({ type: 5 }))
    mapper.map(msg(null))
    expect(seen.records.map(entry => entry.data)).toEqual([
      { type: 'stream_event', at: 1000 }, { type: 'unknown', at: 1000 },
    ])
  })

  it('survives getters that throw', () => {
    const { mapper, seen } = rig()
    const hostile = {
      get type(): never { throw new Error('boom') },
    }
    mapper.map(hostile as unknown as SDKMessage)
    expect(seen.records).toHaveLength(1)
  })
})
