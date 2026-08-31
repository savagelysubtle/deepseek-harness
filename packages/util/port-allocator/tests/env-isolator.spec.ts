import { describe, expect, it } from 'vitest'
import { EnvIsolator, resolveEnvIsolatorConfig } from '@deepseek-ai/dsh-port-allocator'

describe('resolveEnvIsolatorConfig', () => {
  it('round-trips a fully specified configuration', () => {
    const config = resolveEnvIsolatorConfig({
      portVar: 'PORT',
      sessionVar: 'DSH_SESSION_ID',
      suffixVars: ['TMPDIR', 'XDG_CACHE_HOME'],
      suffixSeparator: '-',
    })
    expect(config).toEqual({
      portVar: 'PORT',
      sessionVar: 'DSH_SESSION_ID',
      suffixVars: new Set(['TMPDIR', 'XDG_CACHE_HOME']),
      suffixSeparator: '-',
    })
  })

  it('keeps sessionVar undefined when the consumer stamps no session id', () => {
    const config = resolveEnvIsolatorConfig({ portVar: 'PORT' })
    expect(config.sessionVar).toBeUndefined()
    expect(config.suffixVars.size).toBe(0)
  })

  it('drops the separator when there is nothing to suffix', () => {
    const config = resolveEnvIsolatorConfig({ portVar: 'PORT', suffixSeparator: '-' })
    expect(config.suffixSeparator).toBeUndefined()
  })

  it('rejects an empty portVar', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: '' }))
      .toThrow(/env isolator: portVar must be a POSIX environment-variable name/)
  })

  it('rejects a portVar starting with a digit', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: '1PORT' }))
      .toThrow(/env isolator: portVar must be a POSIX environment-variable name .* received "1PORT"/)
  })

  it('rejects a sessionVar with characters outside the POSIX name set', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: 'PORT', sessionVar: 'SESSION-ID' }))
      .toThrow(/env isolator: sessionVar must be a POSIX environment-variable name .* received "SESSION-ID"/)
  })

  it('rejects an invalid suffixVars entry', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: 'PORT', suffixVars: ['TMP DIR'], suffixSeparator: '-' }))
      .toThrow(/env isolator: suffixVars entry must be a POSIX environment-variable name .* received "TMP DIR"/)
  })

  it('rejects a duplicated suffixVars entry', () => {
    expect(() => resolveEnvIsolatorConfig({
      portVar: 'PORT',
      suffixVars: ['TMPDIR', 'TMPDIR'],
      suffixSeparator: '-',
    })).toThrow('env isolator: suffixVars entry "TMPDIR" is duplicated')
  })

  it('rejects an empty suffixSeparator', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: 'PORT', suffixVars: ['TMPDIR'], suffixSeparator: '' }))
      .toThrow('env isolator: suffixSeparator must be a non-empty string when present')
  })

  it('requires a separator when suffix variables are configured', () => {
    expect(() => resolveEnvIsolatorConfig({ portVar: 'PORT', suffixVars: ['TMPDIR'] }))
      .toThrow('env isolator: suffixSeparator is required when suffixVars is non-empty')
  })
})

describe('EnvIsolator — session env', () => {
  it('stamps the port and copies the base env without touching baseEnv or process.env', () => {
    const beforeEnv = { ...process.env }
    const baseEnv: Record<string, string> = { HOME: '/home/u', LANG: 'C' }
    const isolator = new EnvIsolator({ portVar: 'PORT' })

    const env = isolator.sessionEnv({ baseEnv, port: 3100 })

    expect(env).toEqual({ HOME: '/home/u', LANG: 'C', PORT: '3100' })
    expect(env).not.toBe(baseEnv)
    expect(baseEnv).toEqual({ HOME: '/home/u', LANG: 'C' })
    expect(process.env).toEqual(beforeEnv)
  })

  it('stamps the session id into the configured sessionVar', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT', sessionVar: 'DSH_SESSION_ID' })
    const env = isolator.sessionEnv({ baseEnv: {}, port: 3100, sessionId: 'session-7' })
    expect(env).toEqual({ PORT: '3100', DSH_SESSION_ID: 'session-7' })
  })

  it('suffixes present base values with the session id and leaves absent ones absent', () => {
    const isolator = new EnvIsolator({
      portVar: 'PORT',
      sessionVar: 'DSH_SESSION_ID',
      suffixVars: ['TMPDIR', 'XDG_CACHE_HOME'],
      suffixSeparator: '-',
    })
    const env = isolator.sessionEnv({
      baseEnv: { TMPDIR: '/tmp/dsh', PATH: '/bin' },
      port: 3101,
      sessionId: 's1',
    })
    expect(env.TMPDIR).toBe('/tmp/dsh-s1')
    expect(env.PATH).toBe('/bin')
    expect(env).not.toHaveProperty('XDG_CACHE_HOME')
    expect(env.DSH_SESSION_ID).toBe('s1')
  })

  it('rejects a sessionId when sessionVar was not configured', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT' })
    expect(() => isolator.sessionEnv({ baseEnv: {}, port: 3100, sessionId: 's1' }))
      .toThrow('env isolator: sessionVar must be configured to stamp a sessionId')
  })

  it('rejects a missing sessionId when suffix variables are configured', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT', suffixVars: ['TMPDIR'], suffixSeparator: '-' })
    expect(() => isolator.sessionEnv({ baseEnv: { TMPDIR: '/tmp/dsh' }, port: 3100 }))
      .toThrow('env isolator: sessionId is required because suffixVars is configured')
  })

  it('rejects a port outside the legal TCP range', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT' })
    expect(() => isolator.sessionEnv({ baseEnv: {}, port: 0 }))
      .toThrow(/env isolator: port must be an integer between 1 and 65535, received 0/)
    expect(() => isolator.sessionEnv({ baseEnv: {}, port: 65_536 }))
      .toThrow(/env isolator: port must be an integer between 1 and 65535, received 65536/)
  })

  it('rejects an empty sessionId', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT', sessionVar: 'DSH_SESSION_ID' })
    expect(() => isolator.sessionEnv({ baseEnv: {}, port: 3100, sessionId: '' }))
      .toThrow('env isolator: sessionId must be a non-empty string without NUL characters when present')
  })

  it('rejects a sessionId containing a NUL character', () => {
    const isolator = new EnvIsolator({ portVar: 'PORT', sessionVar: 'DSH_SESSION_ID' })
    expect(() => isolator.sessionEnv({ baseEnv: {}, port: 3100, sessionId: 's\0x' }))
      .toThrow('env isolator: sessionId must be a non-empty string without NUL characters when present')
  })
})
