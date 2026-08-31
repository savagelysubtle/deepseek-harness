/** The DEEPSEEK_API_KEY presence check that gates work sessions. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEnvPresence, WORK_ENV_VAR } from '../src/env.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkEnvPresence', () => {
  it('accepts an environment carrying the key', () => {
    expect(checkEnvPresence({ [WORK_ENV_VAR]: 'sk-test' })).toEqual({ present: true })
  })

  it('rejects an environment missing the key and names it', () => {
    const outcome = checkEnvPresence({})
    expect(outcome).toEqual({ present: false, missing: [WORK_ENV_VAR] })
  })

  it('treats blank and whitespace-only values as missing', () => {
    for (const value of ['', '   ', '\t\n']) {
      expect(checkEnvPresence({ [WORK_ENV_VAR]: value })).toEqual({ present: false, missing: [WORK_ENV_VAR] })
    }
  })

  it('reads process.env by default', () => {
    vi.stubEnv(WORK_ENV_VAR, 'sk-live')
    expect(checkEnvPresence()).toEqual({ present: true })
    vi.stubEnv(WORK_ENV_VAR, undefined)
    expect(checkEnvPresence()).toEqual({ present: false, missing: [WORK_ENV_VAR] })
  })
})
