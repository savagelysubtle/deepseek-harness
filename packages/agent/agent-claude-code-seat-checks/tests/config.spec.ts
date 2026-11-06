import { describe, expect, it } from 'vitest'
import { Config, MAX_CANARY_TIMEOUT_MS, resolveSeatChecksConfig, SeatChecksConfigError } from '../src/config.ts'

describe('config schema', () => {
  it('fills the defaults and leaves gitPath unset', () => {
    const config = Config({})
    expect(config.enabled).toBe(true)
    expect(config.canaryTimeoutMs).toBe(20_000)
    expect(config.gitPath).toBeUndefined()
  })

  it('takes explicit values', () => {
    expect(Config({ enabled: false, gitPath: '/usr/bin/git', canaryTimeoutMs: 5 })).toMatchObject({ enabled: false, gitPath: '/usr/bin/git', canaryTimeoutMs: 5 })
  })
})

describe('resolveSeatChecksConfig', () => {
  it('picks the first existing candidate', () => {
    expect(resolveSeatChecksConfig({}, path => path === '/usr/local/bin/git')).toEqual({ gitPath: '/usr/local/bin/git', canaryTimeoutMs: 20_000 })
    expect(resolveSeatChecksConfig({}, () => true).gitPath).toBe('/usr/bin/git')
  })

  it('reports no git as undefined', () => {
    expect(resolveSeatChecksConfig({}, () => false).gitPath).toBeUndefined()
  })

  it('uses the real filesystem by default', () => {
    expect(typeof resolveSeatChecksConfig({}).canaryTimeoutMs).toBe('number')
  })

  it('takes an explicit absolute gitPath without checking it exists', () => {
    expect(resolveSeatChecksConfig({ gitPath: '/opt/git/bin/git', canaryTimeoutMs: 100 }, () => false)).toEqual({ gitPath: '/opt/git/bin/git', canaryTimeoutMs: 100 })
  })

  it.each(['git', './git', '/usr/bin/../bin/git', '/usr//bin/git'])('throws for gitPath %j', (gitPath) => {
    expect(() => resolveSeatChecksConfig({ gitPath })).toThrow(SeatChecksConfigError)
  })

  it.each([0, -1, 1.5, MAX_CANARY_TIMEOUT_MS + 1])('throws for canaryTimeoutMs %j', (canaryTimeoutMs) => {
    expect(() => resolveSeatChecksConfig({ canaryTimeoutMs })).toThrow('canaryTimeoutMs')
  })
})
