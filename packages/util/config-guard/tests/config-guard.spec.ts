import { describe, expect, it } from 'vitest'
import { guardConfigSchema, RECEIVED_VALUE_WITHHELD, redactReceivedValue } from '@deepseek-ai/dsh-config-guard'

interface FakeIssue {
  message: string
  path?: string[]
}

/** A Schemastery-shaped schema: `~standard` is a prototype accessor returning a fresh validator. */
function fakeSchema(validate: (value: unknown) => { value?: unknown; issues?: FakeIssue[] }): object {
  const proto = {}
  Object.defineProperty(proto, '~standard', {
    get() {
      return { version: 1, vendor: 'fake', validate }
    },
  })
  return Object.create(proto) as object
}

type Standard = { validate(value: unknown): { value?: unknown; issues?: FakeIssue[] }; version: number; vendor: string }
const standardOf = (schema: object): Standard => (schema as { '~standard': Standard })['~standard']

describe('redactReceivedValue', () => {
  it('replaces the echoed value, multi-line values included', () => {
    expect(redactReceivedValue('expected object but got sk-FAKE-1')).toBe(`expected object${RECEIVED_VALUE_WITHHELD}`)
    expect(redactReceivedValue('expected string but got line1\nline2 but got x')).toBe(`expected string${RECEIVED_VALUE_WITHHELD}`)
  })

  it('leaves a message that never embeds the value alone', () => {
    expect(redactReceivedValue('missing required value')).toBe('missing required value')
  })
})

describe('guardConfigSchema', () => {
  it('redacts every issue message, keeping path, version, and vendor', () => {
    const schema = guardConfigSchema(fakeSchema(() => ({
      issues: [
        { message: '$.env expected object but got sk-FAKE-1', path: ['env'] },
        { message: 'missing required value' },
      ],
    })))
    const result = standardOf(schema).validate({})
    expect(result.issues).toEqual([
      { message: `$.env expected object${RECEIVED_VALUE_WITHHELD}`, path: ['env'] },
      { message: 'missing required value' },
    ])
    expect(standardOf(schema).version).toBe(1)
    expect(standardOf(schema).vendor).toBe('fake')
  })

  it('passes a successful result through untouched', () => {
    const schema = guardConfigSchema(fakeSchema(value => ({ value })))
    expect(standardOf(schema).validate({ ok: true })).toEqual({ value: { ok: true } })
  })

  it('returns the same instance and keeps the override out of enumeration', () => {
    const raw = fakeSchema(() => ({ value: 1 }))
    const guarded = guardConfigSchema(raw)
    expect(guarded).toBe(raw)
    expect(Object.keys(guarded)).toEqual([])
  })

  it('finds the accessor further up a multi-level prototype chain', () => {
    const base = fakeSchema(() => ({ issues: [{ message: 'expected string but got sk-FAKE-2' }] }))
    const derived = Object.create(Object.create(base) as object) as object
    const result = standardOf(guardConfigSchema(derived)).validate(1)
    expect(result.issues?.[0]?.message).toBe(`expected string${RECEIVED_VALUE_WITHHELD}`)
  })

  it('refuses a value with no "~standard" accessor', () => {
    expect(() => guardConfigSchema({})).toThrow(/no "~standard" accessor/)
    expect(() => guardConfigSchema(Object.create(null) as object)).toThrow(/no "~standard" accessor/)
  })
})
