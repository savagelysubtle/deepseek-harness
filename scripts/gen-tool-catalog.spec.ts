/**
 * Coverage for the boot-manifest completeness guard's discovery rule
 * (`assertManifestComplete`): the guard must catch an on-disk tool package no
 * matter which of the two shapes it takes — a `tool-*` directory (the
 * original, back-compat glob) OR a package whose `exports` map declares a
 * subpath ending in `/tool` (how `@deepseek-ai/dsh-session-title/tool` and
 * `@deepseek-ai/dsh-memory/tool` are actually mounted — SWD-150). Each case
 * builds a throwaway fixture tree so it never depends on the real repo's
 * current package set.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertManifestComplete } from './gen-tool-catalog.ts'
import type { ToolPackage } from './gen-tool-catalog.ts'

/** A manifest entry with every field the guard needs, overridable per case. */
function toolPackage(over: Partial<ToolPackage> = {}): ToolPackage {
  return {
    pkg: '@deepseek-ai/dsh-tool-demo',
    dir: 'tool-demo',
    source: 'packages/demo/tool-demo/src/index.ts',
    requires: [],
    writes: [],
    async mount() {},
    ...over,
  }
}

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Lay out an on-disk `tool-*` package directory (no exports needed — the dir glob alone must find it). */
function writeToolDirPackage(root: string, group: string, dir: string): void {
  const pkgDir = join(root, 'packages', group, dir)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/dsh-${dir}`,
    exports: { '.': './lib/index.js' },
  }))
}

/** Lay out a package named for its DOMAIN whose `exports` map subpath-exports a tool at `./tool`. */
function writeSubpathToolPackage(root: string, group: string, dir: string, pkgName: string): void {
  const pkgDir = join(root, 'packages', group, dir)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: pkgName,
    exports: {
      '.': './lib/index.js',
      './tool': './lib/tool.js',
    },
  }))
}

describe('assertManifestComplete', () => {
  it('passes when every on-disk package (either shape) is listed', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    writeSubpathToolPackage(root, 'demo', 'demo-domain', '@deepseek-ai/dsh-demo-domain')
    const packages = [
      toolPackage({ dir: 'tool-demo' }),
      toolPackage({ pkg: '@deepseek-ai/dsh-demo-domain', dir: 'demo-domain' }),
    ]
    expect(() => { assertManifestComplete(packages, root) }).not.toThrow()
  })

  it('still catches a plain `tool-*` directory missing from the manifest (back-compat)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    expect(() => { assertManifestComplete([], root) }).toThrow('tool-demo')
  })

  it('discovers a subpath-exported tool (package.json `exports["./tool"]`) on a non-`tool-*` directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    // The domain-named directory alone would never match `packages/*/tool-*`.
    writeSubpathToolPackage(root, 'session', 'session-title', '@deepseek-ai/dsh-session-title')
    expect(() => { assertManifestComplete([], root) }).toThrow('session-title')
  })

  it('fails the guard when a subpath-exported tool is omitted from the manifest, even with the `tool-*` case covered', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    writeSubpathToolPackage(root, 'memory', 'memory', '@deepseek-ai/dsh-memory')
    // Only the tool-* case is listed — the subpath-exported one is left out,
    // mirroring the exact gap this fix closes.
    const packages = [toolPackage({ dir: 'tool-demo' })]
    expect(() => { assertManifestComplete(packages, root) })
      .toThrow('gen-tool-catalog: 1 tool package(s) not in the boot manifest: memory.')
  })

  it('does not mistake an ordinary `.` main-entry package for a subpath-exported tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    const pkgDir = join(root, 'packages', 'demo', 'not-a-tool')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-not-a-tool',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
    }))
    expect(() => { assertManifestComplete([], root) }).not.toThrow()
  })

  it('tolerates an unreadable or malformed package.json instead of crashing discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    const pkgDir = join(root, 'packages', 'demo', 'broken')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{ not valid json')
    expect(() => { assertManifestComplete([], root) }).not.toThrow()
  })
})
