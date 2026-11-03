import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze, DEFAULT_MAX_BYTES, sha256Hex } from '../src/index.ts'
import { DIAG_CASES } from './diag-cases.ts'
import { FEATURE_LOOP, MAIL_TRIAGE } from './fixtures.ts'

const BASE = 'version: 1\nname: demo\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n'

describe('analyze: examples', () => {
  it.each([['feature-loop', FEATURE_LOOP], ['mail-triage', MAIL_TRIAGE]])('accepts %s with no diagnostics', (name, text) => {
    const result = analyze(text, { expectedName: name })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.doc?.name).toBe(name)
    expect(result.graph?.nodes.length).toBeGreaterThan(0)
    expect(result.manifest).toEqual(result.graph?.manifest)
    expect(Object.keys(result.locations ?? {})).toEqual(result.doc?.nodes.map(n => n.id))
    if (name === 'feature-loop') expect(result.locations?.implement).toEqual({ line: 23, column: 9 })
  })

  it('hashes the exact bytes with sha256', () => {
    expect(analyze('').hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const long = 'a'.repeat(1000)
    expect(sha256Hex(long)).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
    const a = analyze(BASE)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(analyze(`${BASE}\n`).hash).not.toBe(a.hash)
  })

  it('reports a name that does not match the file name', () => {
    const result = analyze(BASE, { expectedName: 'other' })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'name-mismatch', line: 2, column: 7 })
  })
})

describe('analyze: diagnostic table (exact line:column)', () => {
  it.each(DIAG_CASES)('$title', (c) => {
    const result = analyze(c.text)
    const hit = result.diagnostics.find(d => d.code === c.code)
    expect(hit, JSON.stringify(result.diagnostics)).toBeDefined()
    expect(`${hit!.line}:${hit!.column}`).toBe(`${c.line}:${c.column}`)
    if (c.end !== undefined) expect([hit!.endLine, hit!.endColumn]).toEqual([c.end.line, c.end.column])
    expect(hit!.message).toContain(c.message)
    expect(hit!.severity).toBe(c.severity ?? 'error')
    expect(hit!.path).toBeInstanceOf(Array)
    expect(result.ok).toBe(c.severity === 'warning')
  })

  it('covers every diagnostic code the source can raise', () => {
    const source = ['validate.ts', 'analyze.ts'].map(f => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n')
    const raised = new Set<string>()
    const pattern = /(?:err|warn)\(\s*'([a-z-]+)'|code: '([a-z-]+)'|, '([a-z]+(?:-[a-z]+)+)'\)/g
    for (const m of source.matchAll(pattern)) raised.add(m[1] ?? m[2] ?? m[3] ?? '')
    for (const code of ['alias-not-allowed', 'anchor-not-allowed', 'tag-not-allowed', 'too-large', 'empty-document']) raised.add(code)
    const covered = new Set(DIAG_CASES.map(c => c.code))
    // These classes are asserted with exact positions in the dedicated tests below.
    const dedicated = new Set(['alias-not-allowed', 'anchor-not-allowed', 'tag-not-allowed', 'too-large', 'empty-document',
      'name-mismatch'])
    const missing = [...raised].filter(code => code !== '' && !covered.has(code) && !dedicated.has(code))
    expect(missing).toEqual([])
    expect(raised.size).toBeGreaterThan(25)
  })

  it('gives rejection messages that name the replacement', () => {
    const msg = (text: string): string => analyze(text).diagnostics.map(d => d.message).join('\n')
    expect(msg(`${BASE}    evidence: required\n`)).toContain("'evidence' is not supported in version 1")
    expect(msg(`${BASE}    retry:\n      on_error: all\n`)).toContain('only re-runs transient failures')
    expect(msg(`${BASE}    workflow: x\n`)).toContain('reserved and not yet supported')
    expect(msg('version: 1\nname: demo\ndescription: d\ninclude: [x]\nnodes:\n  - id: a\n'
        + '    kind: workflow\n')).toContain('workflow nodes are not supported in v1')
  })

  it('maps a when error inside a multi-line plain scalar to the scalar start', () => {
    const text = `${BASE}  - id: b\n    kind: bash\n    bash: echo\n    depends_on: [a]\n    when: $a.status ==\n      'x' &&\n`
    const hit = analyze(text).diagnostics.find(d => d.code === 'when-syntax')
    expect(hit).toMatchObject({ line: 12, column: 11 })
  })

  it('reports several problems in one pass, ordered by position', () => {
    const result = analyze('version: 3\nname: Bad\ndescription: d\nnodes:\n  - id: a\n    kind: bash\n')
    expect(result.diagnostics.map(d => `${d.line}:${d.column} ${d.code}`)).toEqual([
      '1:10 version-unsupported', '2:7 invalid-value', '5:5 missing-field',
    ])
    expect(result.doc).toBeUndefined()
  })
})

describe('analyze: YAML safety', () => {
  it('rejects anchors, aliases, and tags with located diagnostics', () => {
    const anchors = analyze('version: 1\nname: demo\ndescription: &d Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: *d\n')
    expect(anchors.ok).toBe(false)
    expect(anchors.diagnostics.map(d => `${d.code} ${d.line}:${d.column}`)).toEqual(['anchor-not-allowed 3:14', 'alias-not-allowed 7:11'])
    const tags = analyze('version: 1\nname: demo\ndescription: !!str Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: !!js/function x\n')
    expect(tags.diagnostics.map(d => `${d.code} ${d.line}:${d.column}`)).toEqual(['tag-not-allowed 3:14', 'tag-not-allowed 7:11'])
    expect(tags.diagnostics[0]!.message).toContain('!!str')
  })

  it('is not exploded by an alias bomb', () => {
    const bomb = 'a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\n'
        + 'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\n'
        + 'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]\n'
        + 'e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]\n'
    const result = analyze(bomb)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(d => d.code === 'alias-not-allowed')).toBe(true)
  })

  it('rejects duplicate keys, multiple documents, empty and non-mapping files', () => {
    expect(analyze('version: 1\nversion: 1\n').diagnostics[0]).toMatchObject({ code: 'parse-error', line: 2, column: 1 })
    expect(analyze(`${BASE}---\nversion: 1\n`).diagnostics.some(d => d.code === 'parse-error')).toBe(true)
    expect(analyze('').diagnostics).toEqual([expect.objectContaining({ code: 'empty-document', line: 1, column: 1 })])
    expect(analyze('- a\n- b\n').diagnostics[0]).toMatchObject({ code: 'type-error', line: 1, column: 1 })
  })

  it('enforces the size cap with a diagnostic, not a crash', () => {
    const big = `${BASE}# ${'x'.repeat(DEFAULT_MAX_BYTES)}\n`
    const result = analyze(big)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ code: 'too-large', line: 1, column: 1 })
    expect(result.hash).toBeUndefined()
    expect(analyze(BASE, { maxBytes: 10 }).diagnostics[0]!.code).toBe('too-large')
    expect(analyze('é'.repeat(200_000)).diagnostics[0]!.code).toBe('too-large')
    expect(analyze(BASE, { maxBytes: 1000 }).ok).toBe(true)
  })

  it('never throws on arbitrary garbage', () => {
    for (const text of ['\u0000', '{{{{', '!!!', '"unterminated', 'a: [', ': :', '\t\tx', '- - - -']) {
      expect(() => analyze(text)).not.toThrow()
      expect(analyze(text).ok).toBe(false)
    }
  })
})

describe('analyze: model hook and normalised model data', () => {
  it('runs the resolved-model hook after the static check', () => {
    const text = `${BASE}  - id: b\n    kind: prompt\n    depends_on: [a]\n    model: my-alias\n`
        + '    prompt: hi\n    mutates_checkout: false\n'
    const calls: string[] = []
    const result = analyze(text, { checkModel: (model,
      ctx) => { calls.push(`${ctx.nodeId}:${model}`); return 'alias resolves to a denied model' } })
    expect(calls).toEqual(['b:my-alias'])
    expect(result.diagnostics[0]).toMatchObject({ code: 'model-denied', message: 'alias resolves to a denied model', nodeId: 'b' })
    expect(analyze(text, { checkModel: () => undefined }).ok).toBe(true)
  })

  it('normalises durations, defaults, and gate defaults', () => {
    const doc = analyze(FEATURE_LOOP).doc!
    const byId = Object.fromEntries(doc.nodes.map(n => [n.id, n]))
    expect(byId.approve).toMatchObject({ kind: 'approval', timeoutMs: 3_600_000, gate: true })
    expect(byId.plan).toMatchObject({ gate: false, mutatesCheckout: false, maxIterations: 3 })
    expect(byId['gate-tests']).toMatchObject({ timeoutMs: 300_000, gate: true, allowFailure: false })
    expect(byId.review).toMatchObject({ gate: true, tier: 'cheap' })
  })
})
