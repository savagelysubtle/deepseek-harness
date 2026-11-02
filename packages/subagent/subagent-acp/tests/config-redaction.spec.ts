import { resolveConfig, ValidationError } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

// OP-205: a credential placed in a wrongly typed config field must never reach
// the ValidationError that cordis logs at mount/reload. These run through the
// real vendored Schemastery, so a wording change fails the canary loudly
// instead of silently turning the guard into a no-op.
const SECRET = 'sk-FAKE-0123456789abcdef'

/** Resolve exactly as cordis `_reload` does and return the thrown ValidationError. */
function failure(config: unknown): ValidationError {
  try {
    resolveConfig({ Config } as never, config)
  } catch (error) {
    if (error instanceof ValidationError) return error
    throw error
  }
  throw new Error('expected the config to fail validation')
}

describe('Config validation errors withhold the received value', () => {
  it('canary: unguarded Schemastery still echoes the received value', () => {
    const raw = z.dict(z.string())['~standard'].validate(`API_KEY=${SECRET}`) as { issues?: { message: string }[] }
    expect(raw.issues?.[0]?.message).toContain(SECRET)
    expect(raw.issues?.[0]?.message).toMatch(/ but got /)
  })

  it.each<[string, unknown]>([
    ['env as a string', { command: 'echo', env: `API_KEY=${SECRET}` }],
    ['env value as an array', { command: 'echo', env: { API_KEY: [SECRET, 'x'] } }],
  ])('%s', (_name, config) => {
    const error = failure(config)
    expect(error.message).toMatch(/expected \w+ \(received value withheld\)/)
    expect(error.message).not.toContain(SECRET)
    expect(JSON.stringify(error)).not.toContain(SECRET)
    expect(String(error.stack)).not.toContain(SECRET)
  })
})
