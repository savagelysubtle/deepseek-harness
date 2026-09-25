/**
 * Direct tests for the function-plugin face of the local memory provider:
 * exported metadata shape, and that `apply` mounts {@link LocalMemoryProvider}
 * under the given config the same way a `cordis.yml` row does.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { apply, Config, inject, name } from '../src/local-plugin.ts'
import { LocalMemoryProvider } from '../src/local.ts'

describe('local-plugin metadata', () => {
  it('exports the loader name, an empty inject list, and a root-only config schema', () => {
    expect(name).toBe('memory-local')
    expect(inject).toEqual([])
    expect(Config.type).toBe('object')
    expect(Object.keys(Config.dict ?? {})).toEqual(['root'])
    expect(Config.dict?.root?.type).toBe('string')
  })
})

describe('local-plugin apply', () => {
  it('mounts LocalMemoryProvider with the given config, publishing ctx.memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
    try {
      const ctx = new Context()
      await apply(ctx, { root })
      const service = ctx.get('memory')
      expect(service).toBeInstanceOf(LocalMemoryProvider)
      expect((service as LocalMemoryProvider).spec.root).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('mounts with an empty config when none is given, resolving the default storage root', async () => {
    const ctx = new Context()
    await apply(ctx)
    const service = ctx.get('memory')
    expect(service).toBeInstanceOf(LocalMemoryProvider)
    // No explicit root: resolveSpec() falls back to the harness home, never "".
    expect((service as LocalMemoryProvider).spec.root.length).toBeGreaterThan(0)
    expect((service as LocalMemoryProvider).config).toEqual({})
  })
})
