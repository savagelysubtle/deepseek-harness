/**
 * Behavioral coverage for loop-guard: proves the drift detector catches the
 * real digit-drifting reasoning-loop incident early, never trips on
 * realistic non-degenerate code, survives adversarial chunk splits, and that
 * the tool-repeat detector's exact-repeat/polling boundary sits where
 * specified.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ReasoningDriftDetector, ToolRepeatDetector, toolCallSignature } from '../src/loop-guard.ts'

/** Deterministic PRNG (mulberry32) so generated fixtures are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Split `text` into deterministic, deliberately awkward chunks that routinely split mid-word. */
function chunkAwkwardly(text: string, seed: number): string[] {
  const rng = mulberry32(seed)
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    const len = 2 + Math.floor(rng() * 6)
    chunks.push(text.slice(i, i + len))
    i += len
  }
  return chunks
}

/**
 * Build the real-incident fixture: a short phrase repeated `repeats` times
 * where an embedded counter increments forever (never resets per repeat).
 * Because the digits differ on every single occurrence, no substring of
 * this text repeats byte-for-byte — only the digit-normalized structure
 * does. Mirrors the observed "1 bird, 2 bird, 3 bird" drift.
 */
function buildDriftingIncidentText(repeats: number): string {
  let text = ''
  for (let k = 0; k < repeats; k++) {
    const n1 = 3 * k + 1
    const n2 = 3 * k + 2
    const n3 = 3 * k + 3
    text += `Recount now: ${n1} bird, ${n2} bird, ${n3} bird. `
  }
  return text
}

/** Vocabulary pools for the synthetic-but-realistic source generator below. */
const NOUNS = [
  'session', 'request', 'tool', 'agent', 'stream', 'context', 'result', 'payload',
  'handler', 'registry', 'cursor', 'buffer', 'socket', 'worker', 'record', 'event',
  'cache', 'token', 'scope', 'plugin',
]
const VERBS = [
  'create', 'resolve', 'dispatch', 'normalize', 'validate', 'enqueue', 'flush',
  'cancel', 'persist', 'materialize', 'derive', 'register', 'attach', 'detach', 'serialize',
]
const TYPES = [
  'string', 'number', 'boolean', 'Session', 'Request', 'ToolResult', 'AgentHandle',
  'Context', 'Buffer', 'RecordType',
]

/**
 * Deterministically generate `lineCount` lines of legitimate-looking
 * TypeScript-shaped source: heavy on `const`, `return`, `import`, `}` and
 * other structural keywords, but with enough lexical variety (drawn from
 * {@link NOUNS}/{@link VERBS}/{@link TYPES}) that no 4-word window repeats
 * on the scale the drift detector cares about. This stands in for "a long,
 * legitimate completion with heavy but non-degenerate repetition."
 */
function generateRealisticSource(seed: number, lineCount: number): string {
  const rng = mulberry32(seed)
  const pick = <T>(pool: readonly T[]): T => pool[Math.floor(rng() * pool.length)] as T
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    const n1 = pick(NOUNS)
    const v1 = pick(VERBS)
    const n2 = pick(NOUNS)
    const t1 = pick(TYPES)
    const kind = Math.floor(rng() * 6)
    if (kind === 0) lines.push(`function ${v1}${n1[0]!.toUpperCase()}${n1.slice(1)}(${n2}: ${t1}): ${pick(TYPES)} {`)
    else if (kind === 1) lines.push(`  const ${n1}${v1} = ${v1}(${n2}, ${pick(NOUNS)})`)
    else if (kind === 2) lines.push(`  return ${n1}.${v1}(${n2})`)
    else if (kind === 3) lines.push('}')
    else if (kind === 4) lines.push(`import { ${pick(NOUNS)} } from '@deepseek-ai/dsh-${pick(NOUNS)}'`)
    else lines.push(`  if (${n1}.${v1}(${n2})) { ${pick(NOUNS)}.${pick(VERBS)}(${pick(NOUNS)}) }`)
  }
  return lines.join('\n')
}

describe('ReasoningDriftDetector', () => {
  it('trips early on the real digit-drifting reasoning-loop incident', () => {
    const text = buildDriftingIncidentText(2500)
    const chunks = chunkAwkwardly(text, 1)
    const detector = new ReasoningDriftDetector()
    let trippedAtChunk = -1
    let consumedChars = 0
    for (const [index, chunk] of chunks.entries()) {
      consumedChars += chunk.length
      if (detector.push(chunk)) { trippedAtChunk = index; break }
    }
    expect(trippedAtChunk).toBeGreaterThanOrEqual(0)
    // Early detection, not eventual: well under half the stream, in both
    // chunk-count and character terms.
    expect(trippedAtChunk).toBeLessThan(chunks.length / 2)
    expect(consumedChars).toBeLessThan(text.length / 2)
  })

  it('never trips on a long, legitimate, non-degenerate completion (false-positive guard)', () => {
    // Multiple independent seeds and a generous line count: this is the
    // single most important assertion in this suite. A false trip aborts a
    // healthy turn, which is worse than missing a real loop.
    for (const seed of [1, 2, 3, 42, 1337, 7, 99, 555]) {
      const source = generateRealisticSource(seed, 500)
      expect(source).toContain('const')
      expect(source).toContain('return')
      expect(source).toContain('import')
      expect(source).toContain('}')
      const detector = new ReasoningDriftDetector()
      let tripped = false
      for (const chunk of chunkAwkwardly(source, seed * 7 + 3)) {
        if (detector.push(chunk)) { tripped = true; break }
      }
      expect(tripped, `seed ${seed} tripped on legitimate source`).toBe(false)
    }
  })

  it('trips identically whether fed whole or split into chunks that break mid-word', () => {
    const text = buildDriftingIncidentText(400)

    const wholeDetector = new ReasoningDriftDetector()
    const trippedWhole = wholeDetector.push(text)
    expect(trippedWhole).toBe(true)

    const chunkedDetector = new ReasoningDriftDetector()
    let trippedChunked = false
    for (const chunk of chunkAwkwardly(text, 99)) {
      if (chunkedDetector.push(chunk)) { trippedChunked = true; break }
    }
    expect(trippedChunked).toBe(true)
  })

  it('reset() genuinely clears state so prior repetitions no longer count', () => {
    const detector = new ReasoningDriftDetector()
    // 19 repeats of a stable 4-word shingle: one short of the default
    // threshold of 20, so this must not trip yet.
    const nearTrip = 'wait let me recheck '.repeat(19)
    expect(detector.push(nearTrip)).toBe(false)

    detector.reset()

    // If reset had not cleared the count, this identical near-trip input
    // would immediately tip the (already-19) count over the threshold.
    // A genuine reset makes it safe again.
    expect(detector.push(nearTrip)).toBe(false)

    detector.reset()

    // And the detector still works after reset: a fresh full run trips it.
    expect(detector.push('wait let me recheck '.repeat(25))).toBe(true)
  })

  it('is constructor-overridable for shingle size, window size, and threshold', () => {
    const lenient = new ReasoningDriftDetector(4, 300, 1000)
    expect(lenient.push(buildDriftingIncidentText(400))).toBe(false)

    const strict = new ReasoningDriftDetector(4, 300, 3)
    expect(strict.push(buildDriftingIncidentText(10))).toBe(true)
  })
})

describe('ToolRepeatDetector', () => {
  const resultA: ContentBlock[] = [{ type: 'text', text: 'same result' }]
  const resultB: ContentBlock[] = [{ type: 'text', text: 'different result' }]

  it('trips on exactly the third consecutive identical signature, not the second or fourth', () => {
    const detector = new ToolRepeatDetector()
    const sig = toolCallSignature('read_file', { path: '/a.txt' }, resultA)

    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(true)
  })

  it('does not trip a polling tool that returns two identical results then a different one', () => {
    const detector = new ToolRepeatDetector()
    const args = { jobId: 'job-1' }

    expect(detector.record(toolCallSignature('poll_status', args, resultA))).toBe(false)
    expect(detector.record(toolCallSignature('poll_status', args, resultA))).toBe(false)
    expect(detector.record(toolCallSignature('poll_status', args, resultB))).toBe(false)
  })

  it('a differing signature resets the streak', () => {
    const detector = new ToolRepeatDetector()
    const sigA = toolCallSignature('read_file', { path: '/a.txt' }, resultA)
    const sigB = toolCallSignature('read_file', { path: '/b.txt' }, resultA)

    expect(detector.record(sigA)).toBe(false)
    expect(detector.record(sigA)).toBe(false)
    expect(detector.record(sigB)).toBe(false)
    // Back-to-back with A again: streak restarted at sigB, so this is only
    // the second consecutive A, not the fourth overall.
    expect(detector.record(sigA)).toBe(false)
  })

  it('reset() clears the streak so a prior near-trip does not carry over', () => {
    const detector = new ToolRepeatDetector()
    const sig = toolCallSignature('read_file', { path: '/a.txt' }, resultA)

    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(false)
    detector.reset()
    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(true)
  })

  it('threshold is constructor-overridable', () => {
    const detector = new ToolRepeatDetector(2)
    const sig = toolCallSignature('read_file', { path: '/a.txt' }, resultA)

    expect(detector.record(sig)).toBe(false)
    expect(detector.record(sig)).toBe(true)
  })
})

describe('toolCallSignature', () => {
  it('argument key order does not affect the signature', () => {
    const result: ContentBlock[] = [{ type: 'text', text: 'ok' }]
    const sigA = toolCallSignature('write_file', { path: '/a.txt', content: 'x', mode: 0o644 }, result)
    const sigB = toolCallSignature('write_file', { mode: 0o644, content: 'x', path: '/a.txt' }, result)

    expect(sigA.argsHash).toBe(sigB.argsHash)
    expect(sigA).toEqual(sigB)
  })

  it('nested object key order does not affect the signature', () => {
    const result: ContentBlock[] = [{ type: 'text', text: 'ok' }]
    const sigA = toolCallSignature('call', { outer: { a: 1, b: 2 }, list: [{ x: 1, y: 2 }] }, result)
    const sigB = toolCallSignature('call', { outer: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] }, result)

    expect(sigA.argsHash).toBe(sigB.argsHash)
  })

  it('a different result content changes resultHash but not argsHash', () => {
    const args = { path: '/a.txt' }
    const sigA = toolCallSignature('read_file', args, [{ type: 'text', text: 'v1' }])
    const sigB = toolCallSignature('read_file', args, [{ type: 'text', text: 'v2' }])

    expect(sigA.argsHash).toBe(sigB.argsHash)
    expect(sigA.resultHash).not.toBe(sigB.resultHash)
  })

  it('a different tool name changes the signature even with identical args and result', () => {
    const args = { id: 1 }
    const result: ContentBlock[] = [{ type: 'text', text: 'same' }]
    const sigA = toolCallSignature('tool_one', args, result)
    const sigB = toolCallSignature('tool_two', args, result)

    expect(sigA).not.toEqual(sigB)
  })
})
