import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAX_RESULT_LENGTH, REDACTED_PATH, scrubText } from '../../src/mcp/scrub.ts'

const roots = ['/home/op', '/work/seat-one']
const scrub = (text: string, maxLength?: number): string => scrubText(text, { roots, ...maxLength === undefined ? {} : { maxLength } })

describe('scrubText (table)', () => {
  it.each([
    ['plain text stays', 'hello world', 'hello world'],
    ['newline and tab stay', 'a\nb\tc', 'a\nb\tc'],
    ['NUL, ESC, CR, DEL and C1 controls go', 'a\u0000b\u001Bc\rd\u007Fe\u0085f', 'abcdef'],
    ['a home path goes whole', 'see /home/op/.ssh/id_ed25519 now', `see ${REDACTED_PATH} now`],
    ['the bare home goes', 'in /home/op.', `in ${REDACTED_PATH}.`],
    ['a trailing slash on a root is tolerated', 'x /work/seat-one/src/a.ts', `x ${REDACTED_PATH}`],
    ['quoted path stops at the quote', 'open "/home/op/a b" ok', `open "${REDACTED_PATH} b" ok`],
    ['a sibling directory with the same prefix stays', '/home/operator/x', '/home/operator/x'],
    ['a path outside the roots stays', '/etc/hosts', '/etc/hosts'],
  ])('%s', (_label, input, expected) => {
    expect(scrub(input)).toBe(expected)
  })

  it('ignores a root of "/" (it would erase every path)', () => {
    expect(scrubText('/etc/hosts', { roots: ['/'] })).toBe('/etc/hosts')
  })

  it('caps the length and marks the cut', () => {
    const out = scrub('x'.repeat(MAX_RESULT_LENGTH + 500))
    expect(out).toHaveLength(MAX_RESULT_LENGTH)
    expect(out.endsWith('... [truncated]')).toBe(true)
    expect(scrub('abcdefghij', 20)).toBe('abcdefghij')
    expect(scrub('x'.repeat(40), 20)).toHaveLength(20)
    expect(scrub('x'.repeat(40), 5)).toBe('... [truncated]'.slice(0, 15))
  })
})

describe('scrubText (property)', () => {
  const noRootPath = (text: string): boolean => !/\/home\/op(?![\w.-])|\/work\/seat-one(?![\w.-])/.test(text)

  it('never keeps a control character other than newline and tab', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => {
      expect(scrub(text)).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
    }), { numRuns: 400 })
  })

  it('never echoes a path under a protected root', () => {
    const tail = fc.stringMatching(/^(\/[A-Za-z0-9._-]{1,12}){0,4}$/)
    const noise = fc.string({ maxLength: 20 })
    fc.assert(fc.property(fc.constantFrom(...roots), tail, noise, noise, (root, rest, before, after) => {
      expect(noRootPath(scrub(`${before} ${root}${rest} ${after}`))).toBe(true)
    }), { numRuns: 400 })
  })

  it('is idempotent and never longer than the cap', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 6000 }), (text) => {
      const once = scrub(text)
      expect(once.length).toBeLessThanOrEqual(MAX_RESULT_LENGTH)
      expect(scrub(once)).toBe(once)
    }), { numRuns: 200 })
  })
})
