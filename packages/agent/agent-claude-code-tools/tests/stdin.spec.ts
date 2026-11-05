import { closeSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readStdinCapped } from '../src/stdin.ts'
import { makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => {
  box.cleanup()
})

function read(content: string, max: number): string {
  const file = join(box.root, 'in.txt')
  writeFileSync(file, content)
  const fd = openSync(file, 'r')
  try {
    return readStdinCapped(fd, max)
  } finally {
    closeSync(fd)
  }
}

describe('readStdinCapped', () => {
  it('reads everything up to the cap, across several chunks', () => {
    expect(read('hello', 10)).toBe('hello')
    expect(read('', 10)).toBe('')
    const big = 'a'.repeat(200 * 1024)
    expect(read(big, 1024 * 1024)).toBe(big)
  })

  it('stops one byte past the cap', () => {
    expect(read('x'.repeat(50), 10)).toHaveLength(11)
    expect(read('x'.repeat(150 * 1024), 100 * 1024)).toHaveLength(100 * 1024 + 1)
  })

  it('returns what it has when the descriptor cannot be read', () => {
    expect(readStdinCapped(987654, 10)).toBe('')
  })
})
