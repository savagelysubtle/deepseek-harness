import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assertConvertible, DIRECTORY_SCHEMA, MAX_BODY_BYTES, SEND_SCHEMA } from '../../src/mcp/schema.ts'

const ok = { to: 'ops-lead', body: 'hello' }

describe('SEND_SCHEMA', () => {
  it('accepts the four documented fields', () => {
    expect(SEND_SCHEMA.safeParse({ ...ok, replyToTraceId: 'abc-1', blocking: true }).success).toBe(true)
    expect(SEND_SCHEMA.safeParse(ok).success).toBe(true)
  })

  it.each(['from', 'seat', 'tainted', 'chain', 'sender', 'anything'])('rejects the key %s instead of stripping it', (key) => {
    const result = SEND_SCHEMA.safeParse({ ...ok, [key]: 'x' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain(key)
  })

  it('rejects a bad destination grammar, an empty body and a bad trace id', () => {
    for (const bad of [{ to: '../x' }, { to: '' }, { to: 'a b' }, { body: '' }, { replyToTraceId: 'a b' }, { replyToTraceId: '-x' }, { blocking: 'yes' }]) {
      expect(SEND_SCHEMA.safeParse({ ...ok, ...bad }).success).toBe(false)
    }
  })

  it('caps the body at 64 KiB of UTF-8 bytes, not characters', () => {
    expect(SEND_SCHEMA.safeParse({ ...ok, body: 'a'.repeat(MAX_BODY_BYTES) }).success).toBe(true)
    expect(SEND_SCHEMA.safeParse({ ...ok, body: 'a'.repeat(MAX_BODY_BYTES + 1) }).success).toBe(false)
    // 3 bytes per character: under the character cap, over the byte cap.
    expect(SEND_SCHEMA.safeParse({ ...ok, body: '€'.repeat(Math.floor(MAX_BODY_BYTES / 3) + 1) }).success).toBe(false)
  })
})

describe('DIRECTORY_SCHEMA', () => {
  it('takes nothing and rejects any key', () => {
    expect(DIRECTORY_SCHEMA.safeParse({}).success).toBe(true)
    expect(DIRECTORY_SCHEMA.safeParse({ seat: 'x' }).success).toBe(false)
  })
})

describe('assertConvertible (fails closed)', () => {
  it('returns a closed JSON Schema object for the real schemas', () => {
    for (const schema of [SEND_SCHEMA, DIRECTORY_SCHEMA]) {
      const json = assertConvertible('t', schema)
      expect(json['type']).toBe('object')
      expect(json['additionalProperties']).toBe(false)
    }
    expect(Object.keys((assertConvertible('t', SEND_SCHEMA)['properties']) as object)).toEqual(['to', 'body', 'replyToTraceId', 'blocking'])
  })

  it('throws, naming the tool, for a schema zod cannot represent', () => {
    expect(() => assertConvertible('odd', z.strictObject({ when: z.date() }))).toThrow(/tool odd cannot be converted/)
  })

  it('throws for an open object and for a non-object', () => {
    expect(() => assertConvertible('open', z.looseObject({ a: z.string() }))).toThrow(/closed object/)
    expect(() => assertConvertible('str', z.string())).toThrow(/closed object/)
  })
})
