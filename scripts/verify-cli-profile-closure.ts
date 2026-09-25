/**
 * Verify that every `packages/hooks/*` bridge package is reachable from the
 * CLI's real install closure. `healProfilesModuleFallback`
 * (`@deepseek-ai/dsh-app-boot`) links `$DSH_HOME/profiles/node_modules` from
 * exactly that closure (`computeInstallationClosure`, walked from
 * `apps/cli/package.json`), so a hook bridge apps/cli never declares as a
 * dependency or transitive peer cannot load in any real profile even though
 * its own package.json is perfectly well-formed.
 */

import { globSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { computeInstallationClosure } from '../packages/boot/app-boot/src/profile.ts'

interface RequiredManifest {
  name?: string
}

/** One `packages/hooks/*` package the CLI install closure must reach. */
export interface CliProfileClosureRequiredPackage {
  readonly name: string
  readonly declaringManifest: string
}

/** Inputs for {@link collectCliProfileClosureViolations}. */
export interface CliProfileClosureOptions {
  readonly repoRoot: string
  readonly installAnchor: string
  readonly requiredGlobs: readonly string[]
}

/** One required package the CLI install closure cannot reach. */
export interface CliProfileClosureViolation {
  readonly name: string
  readonly declaringManifest: string
  readonly remedy: string
}

/** Discover the required packages by directory group, never a hand list. */
export function cliProfileClosureRequiredPackages(
  repoRoot: string,
  requiredGlobs: readonly string[],
): CliProfileClosureRequiredPackage[] {
  return globSync([...requiredGlobs], { cwd: repoRoot })
    .map(path => path.split(sep).join('/'))
    .sort()
    .map((declaringManifest) => {
      const manifest = readManifest(resolve(repoRoot, declaringManifest))
      if (manifest.name === undefined || manifest.name === '') {
        throw new Error(`${declaringManifest}: required package manifest must declare a name`)
      }
      return { name: manifest.name, declaringManifest }
    })
}

/** Return every required package the CLI install closure cannot reach. */
export function collectCliProfileClosureViolations(
  options: CliProfileClosureOptions,
): CliProfileClosureViolation[] {
  const { repoRoot, installAnchor, requiredGlobs } = options
  const closure = computeInstallationClosure(installAnchor)
  const anchorRelative = relativeSlash(repoRoot, installAnchor)
  const violations: CliProfileClosureViolation[] = []
  for (const required of cliProfileClosureRequiredPackages(repoRoot, requiredGlobs)) {
    if (closure.has(required.name)) continue
    violations.push({
      name: required.name,
      declaringManifest: required.declaringManifest,
      remedy: `add "${required.name}": "workspace:^" to ${anchorRelative} "dependencies" so healProfilesModuleFallback links it into $DSH_HOME/profiles/node_modules on the next boot.`,
    })
  }
  return violations
}

/** Format one violation as the single diagnostic line the CLI gate prints. */
export function formatCliProfileClosureViolation(
  repoRoot: string,
  installAnchor: string,
  violation: CliProfileClosureViolation,
): string {
  const anchorRelative = relativeSlash(repoRoot, installAnchor)
  return `${violation.name} (declared in ${violation.declaringManifest}) is not reachable from the CLI install closure (${anchorRelative}); ${violation.remedy}`
}

function readManifest(path: string): RequiredManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as RequiredManifest
}

function relativeSlash(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dirname, '..')
  const installAnchor = resolve(repoRoot, 'apps/cli/package.json')
  const requiredGlobs = ['packages/hooks/*/package.json']
  const required = cliProfileClosureRequiredPackages(repoRoot, requiredGlobs)
  const violations = collectCliProfileClosureViolations({ repoRoot, installAnchor, requiredGlobs })

  if (violations.length > 0) {
    console.error('verify-cli-profile-closure: packages/hooks/* packages unreachable from the CLI install closure:')
    for (const violation of violations) {
      console.error(`  ${formatCliProfileClosureViolation(repoRoot, installAnchor, violation)}`)
    }
    process.exit(1)
  }

  console.log(`verify-cli-profile-closure: ${required.length} required packages/hooks/* package(s) verified reachable from the CLI install closure.`)
}
