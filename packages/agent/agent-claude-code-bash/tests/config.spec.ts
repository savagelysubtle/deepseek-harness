import { describe, expect, it } from 'vitest'
import { baseSpec, BashConfigError, BWRAP_CANDIDATES, Config, realResolveEnv, resolveConfig } from '../src/config.ts'
import type { ResolveEnv } from '../src/config.ts'
import { BWRAP, GIB, makeConfig } from './helpers.ts'

function host(over: Partial<ResolveEnv> = {}): ResolveEnv {
  return {
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    execPath: '/opt/node-24/bin/node',
    homeDir: '/home/op',
    tmpDir: '/tmp',
    exists: path => path === '/usr/bin/bwrap',
    realpath: path => path,
    ...over,
  }
}

function resolved(config: Parameters<typeof resolveConfig>[0], env: ResolveEnv = host()): ReturnType<typeof makeConfig> {
  const result = resolveConfig(config, env)
  if (!result.ok) throw new Error(result.reason)
  return result.config
}

describe('Config schema', () => {
  it('fills the documented defaults', () => {
    const parsed = Config({})
    expect(parsed.enabled).toBe(true)
    expect(parsed.deadlineS).toBe(120)
    expect(parsed.maxDeadlineS).toBe(600)
    expect(parsed.roPaths).toEqual([])
    expect(parsed.pathDirs).toEqual([])
    expect(parsed.deniedPaths).toEqual([])
    expect(parsed.bwrapPath).toBeUndefined()
  })

  it('rejects wrong types', () => {
    expect(() => Config({ deadlineS: 'x' } as never)).toThrow()
    expect(() => Config({ enabled: 1 } as never)).toThrow()
  })
})

describe('resolveConfig', () => {
  it('detects bwrap, the node installation, the home and the temp directory from the host', () => {
    const config = resolved({})
    expect(config).toMatchObject({
      deadlineS: 120, maxDeadlineS: 600, limits: {}, minFreeBytes: GIB, home: '/home/op', nodeDir: '/opt/node-24',
      bwrapPath: '/usr/bin/bwrap', scratchDir: '/tmp', xdgRuntimeDir: '/run/user/1000', roPaths: [], pathDirs: [], deniedPaths: [],
    })
    expect(config.nodeBinDir).toBeUndefined()
    expect(config.corepackHome).toBeUndefined()
  })

  it('follows symlinks for the home and the node binary', () => {
    const config = resolved({}, host({ realpath: path => (path === '/home/op' ? '/mnt/home/op' : path === '/opt/node-24/bin/node' ? '/real/node/bin/node' : path) }))
    expect(config.home).toBe('/mnt/home/op')
    expect(config.nodeDir).toBe('/real/node')
  })

  it('takes every override', () => {
    const config = resolved({
      deadlineS: 30, maxDeadlineS: 300, memoryMaxBytes: 2 * GIB, tasksMax: 256, minFreeBytes: 2 * GIB, bwrapPath: '/opt/bwrap', nodeDir: '/n', nodeBinDir: '/n/bin',
      corepackHome: '/cp', roPaths: ['/a'], pathDirs: ['/p'], deniedPaths: ['/d'], home: '/h', scratchDir: '/s',
    })
    expect(config).toMatchObject({
      deadlineS: 30, maxDeadlineS: 300, limits: { memoryMaxBytes: 2 * GIB, tasksMax: 256, minFreeBytes: 2 * GIB }, minFreeBytes: 2 * GIB,
      bwrapPath: '/opt/bwrap', nodeDir: '/n', nodeBinDir: '/n/bin', corepackHome: '/cp', roPaths: ['/a'], pathDirs: ['/p'], deniedPaths: ['/d'], home: '/h', scratchDir: '/s',
    })
  })

  it('reports a host without bwrap as a reason, not an error', () => {
    const result = resolveConfig({}, host({ exists: () => false }))
    expect(result).toEqual({ ok: false, reason: `bwrap was not found (looked in ${BWRAP_CANDIDATES.join(', ')})` })
  })

  it('reports a missing XDG_RUNTIME_DIR as undefined (the preflight refuses it)', () => {
    expect(resolved({}, host({ env: {} })).xdgRuntimeDir).toBeUndefined()
  })

  it('throws BashConfigError for deadlines out of range', () => {
    const badRanges = [
      { maxDeadlineS: 601 }, { maxDeadlineS: 0 }, { maxDeadlineS: 1.5 }, { deadlineS: 0 }, { deadlineS: 601 },
      { deadlineS: 200, maxDeadlineS: 100 }, { deadlineS: 2.5 },
    ]
    for (const bad of badRanges) {
      expect(() => resolveConfig(bad, host()), JSON.stringify(bad)).toThrow(BashConfigError)
    }
  })

  it('throws BashConfigError for paths that are not absolute and normalised', () => {
    for (const bad of [{ bwrapPath: 'bwrap' }, { nodeDir: 'rel' }, { nodeBinDir: '/a/../b' }, { corepackHome: 'x' }, { roPaths: ['/ok', 'no'] }, { pathDirs: ['/p/'] }, { deniedPaths: ['d'] }, { home: 'h' }, { scratchDir: 't' }]) {
      expect(() => resolveConfig(bad, host()), JSON.stringify(bad)).toThrow(BashConfigError)
    }
  })

  it('realResolveEnv reads the real host', () => {
    const real = realResolveEnv()
    expect(real.execPath).toBe(process.execPath)
    expect(real.exists('/usr')).toBe(true)
    expect(real.realpath('/usr')).toBe('/usr')
    expect(real.env).toBe(process.env)
    expect(real.tmpDir.startsWith('/')).toBe(true)
    expect(real.homeDir.startsWith('/')).toBe(true)
  })
})

describe('baseSpec', () => {
  it('carries only host values, and leaves the optional ones out when unset', () => {
    const spec = baseSpec(makeConfig(), BWRAP)
    expect(spec).toEqual({
      home: '/home/op', nodeDir: '/opt/node', roPaths: [], pathDirs: [], deniedPaths: [], limits: {}, xdgRuntimeDir: '/run/user/1000', bwrap: BWRAP,
    })
    expect(Object.keys(spec)).not.toContain('nodeBinDir')
    expect(Object.keys(spec)).not.toContain('corepackHome')
  })

  it('passes node bin and corepack home when set', () => {
    const spec = baseSpec(makeConfig({ nodeBinDir: '/n/bin', corepackHome: '/cp' }), BWRAP)
    expect(spec).toMatchObject({ nodeBinDir: '/n/bin', corepackHome: '/cp' })
  })
})
