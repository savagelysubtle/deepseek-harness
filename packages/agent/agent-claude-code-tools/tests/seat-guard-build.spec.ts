import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ensureBuiltGuard } from './helpers.ts'

describe('the built guard script', () => {
  it('is not group- or world-writable, whatever umask built it (the host refuses to attest one that is)', () => {
    const mode = statSync(ensureBuiltGuard()).mode & 0o777
    expect(mode & 0o022).toBe(0)
    expect(mode).toBe(0o644)
  })
})
