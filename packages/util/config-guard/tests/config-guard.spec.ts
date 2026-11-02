import { describe, expect, it } from 'vitest'
import { guardConfigSchema, RECEIVED_VALUE_WITHHELD, redactReceivedValue, redactThrown } from '@deepseek-ai/dsh-config-guard'

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

/** A callable schema like Schemastery's: a function carrying a `~standard` prototype accessor. */
function callableSchema(call: (data: unknown) => unknown): ((data: unknown) => unknown) & { uid: number } {
  const fn = Object.assign((data: unknown) => call(data), { uid: 7 })
  const proto = Object.create(Function.prototype) as object
  Object.defineProperty(proto, '~standard', {
    get() {
      return { version: 1, vendor: 'fake', validate: () => ({ value: 1 }) }
    },
  })
  Object.setPrototypeOf(fn, proto)
  return fn
}

describe('redactThrown', () => {
  it('rewrites the message and the stack header in place, keeping identity and extra fields', () => {
    const error = Object.assign(new TypeError('$.env expected object but got sk-FAKE-3\nsecond line'), { options: { path: ['env'] } })
    expect(error.stack).toContain('sk-FAKE-3')
    redactThrown(error)
    expect(error.message).toBe(`$.env expected object${RECEIVED_VALUE_WITHHELD}`)
    expect(error.stack).not.toContain('sk-FAKE-3')
    expect(error.stack).toContain(`$.env expected object${RECEIVED_VALUE_WITHHELD}`)
    expect(error.options.path).toEqual(['env'])
  })

  it('rebuilds a stack that no longer carries the message', () => {
    const error = new Error('expected string but got sk-FAKE-4')
    error.stack = 'unrelated stack text sk-FAKE-4'
    redactThrown(error)
    expect(error.stack).toBe(`Error: expected string${RECEIVED_VALUE_WITHHELD}`)
    const bare = new Error('expected string but got sk-FAKE-5')
    delete bare.stack
    redactThrown(bare)
    expect(bare.stack).toBe(`Error: expected string${RECEIVED_VALUE_WITHHELD}`)
  })

  it('leaves a clean message, a clean stack, and non-errors alone', () => {
    const error = new Error('missing required value')
    const stack = error.stack
    redactThrown(error)
    expect(error.stack).toBe(stack)
    expect(() => { redactThrown('sk-FAKE-6 but got x') }).not.toThrow()
    expect(() => { redactThrown(undefined) }).not.toThrow()
  })
})

describe('guardConfigSchema on a callable schema (direct-call path)', () => {
  const nested = 'models.0.apiKey expected string but got {"k":"sk-FAKE-7"}'

  it('redacts a thrown error (union, nested, dict path) and rethrows the same object', () => {
    const thrown = Object.assign(new TypeError(nested), { options: { path: ['models', 0, 'apiKey'] } })
    const schema = guardConfigSchema(callableSchema(() => { throw thrown }))
    let caught: unknown
    try { schema({}) } catch (error) { caught = error }
    expect(caught).toBe(thrown)
    expect(thrown.message).toBe(`models.0.apiKey expected string${RECEIVED_VALUE_WITHHELD}`)
    expect(String(thrown.stack)).not.toContain('sk-FAKE-7')
    expect(thrown.options.path).toEqual(['models', 0, 'apiKey'])
  })

  it('passes a returned value, property reads, and the Standard Schema path through', () => {
    const schema = guardConfigSchema(callableSchema(data => ({ ok: data })))
    expect(schema(5)).toEqual({ ok: 5 })
    expect(schema.uid).toBe(7)
    expect(typeof schema).toBe('function')
    expect(standardOf(schema).validate(1)).toEqual({ value: 1 })
    expect(Object.keys(schema)).toEqual(['uid'])
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

  it('returns the same instance for a non-callable schema and keeps the override out of enumeration', () => {
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
