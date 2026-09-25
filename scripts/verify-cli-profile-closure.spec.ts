import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectCliProfileClosureViolations } from './verify-cli-profile-closure.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REQUIRED_GLOBS = ['packages/hooks/*/package.json']

const HOOK_BRIDGE_PEER_DEPENDENCIES = { 'hook-protocol': '0.0.0' }

/**
 * Stage a fixture tree mirroring the real repo shape: three
 * `packages/hooks/*` manifests (discovered by glob, never resolvable on
 * their own) and a CLI install anchor with a flat `node_modules` that only
 * Node's own module resolution can walk. `presentBridges` controls which
 * bridge packages the anchor actually depends on; `hook-protocol` is staged
 * into `node_modules` whenever at least one bridge is present, since both
 * bridges only reach it through a `peerDependencies` entry, never a direct
 * app dependency.
 */
function fixtureRoot(presentBridges: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cli-profile-closure-'))
  roots.push(root)

  const hookPackagesDir = join(root, 'packages/hooks')
  writeHookPackageManifest(hookPackagesDir, 'hook-protocol', {})
  writeHookPackageManifest(hookPackagesDir, 'hooks-claude-code', { peerDependencies: HOOK_BRIDGE_PEER_DEPENDENCIES })
  writeHookPackageManifest(hookPackagesDir, 'hooks-codex', { peerDependencies: HOOK_BRIDGE_PEER_DEPENDENCIES })

  const appDir = join(root, 'apps/cli')
  const modulesDir = join(appDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appDependencies: Record<string, string> = {}
  for (const bridge of presentBridges) {
    appDependencies[bridge] = '0.0.0'
    writeNodeModulesManifest(modulesDir, bridge, { peerDependencies: HOOK_BRIDGE_PEER_DEPENDENCIES })
  }
  if (presentBridges.length > 0) {
    writeNodeModulesManifest(modulesDir, 'hook-protocol', {})
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', dependencies: appDependencies }))

  return root
}

function writeHookPackageManifest(
  hookPackagesDir: string,
  name: string,
  manifest: { peerDependencies?: Record<string, string> },
): void {
  const dir = join(hookPackagesDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
}

function writeNodeModulesManifest(
  modulesDir: string,
  name: string,
  manifest: { peerDependencies?: Record<string, string> },
): void {
  const dir = join(modulesDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }))
}

function violationsFor(root: string): ReturnType<typeof collectCliProfileClosureViolations> {
  return collectCliProfileClosureViolations({
    repoRoot: root,
    installAnchor: resolve(root, 'apps/cli/package.json'),
    requiredGlobs: REQUIRED_GLOBS,
  })
}

describe('collectCliProfileClosureViolations', () => {
  it('reports no violations when the anchor reaches every packages/hooks/* package, directly or via a peerDependency', () => {
    const root = fixtureRoot(['hooks-claude-code', 'hooks-codex'])
    expect(violationsFor(root)).toEqual([])
  })

  it('reports exactly one violation, naming the package, its declaring manifest, and the remedy string verbatim', () => {
    const root = fixtureRoot(['hooks-claude-code'])
    expect(violationsFor(root)).toEqual([
      {
        name: 'hooks-codex',
        declaringManifest: 'packages/hooks/hooks-codex/package.json',
        remedy: 'add "hooks-codex": "workspace:^" to apps/cli/package.json "dependencies" so healProfilesModuleFallback links it into $DSH_HOME/profiles/node_modules on the next boot.',
      },
    ])
  })

  it('counts a package reachable only transitively, through a bridge\'s peerDependencies, as reachable', () => {
    // Only hooks-codex is a direct app dependency; hook-protocol is reachable
    // solely through hooks-codex's peerDependencies entry, never directly.
    const root = fixtureRoot(['hooks-codex'])
    const violations = violationsFor(root)
    expect(violations.map(violation => violation.name)).toEqual(['hooks-claude-code'])
    expect(violations.some(violation => violation.name === 'hook-protocol')).toBe(false)
  })
})
