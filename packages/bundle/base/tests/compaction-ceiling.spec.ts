/**
 * Guard for the founder's compaction ceiling ruling (SWD-114): the base
 * bundle's `cordis.patch.yml` mounts `compaction-basic` with
 * `thresholdRatio: 0.75` -- lowered from the package default of 0.95 after a
 * seat entered a degenerate reasoning loop at 82% context consumed (incident
 * 2026-09-01, ruling landed in commit f5739d4822) -- alongside
 * `context-pressure`'s [0.25, 0.5, 0.75] warning ladder, which precedes the
 * cut. No gate asserted either row before this spec, so a stray edit could
 * raise the ceiling or drop the ladder with every other gate green.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { DEFAULT_THRESHOLDS, resolveSpec } from '@deepseek-ai/dsh-context-pressure/src/config.ts'
// Relative, not a package specifier: dsh-app-boot is not (and should not
// become, just for this test) a declared dependency of dsh-base. Mirrors
// scripts/verify-cli-profile-closure.ts's own relative import of this same
// helper for the same reason.
import { computeInstallationClosure } from '../../../boot/app-boot/src/index.ts'

/** Quoted verbatim in the failure so the assertion carries the ruling, not just a number. */
const FOUNDER_CEILING_MESSAGE = 'founder ceiling 0.75, incident 2026-09-01; raising this needs a founder decision'

interface PatchRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: unknown
}

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(TESTS_DIR, '..')
const REPO_ROOT = resolve(TESTS_DIR, '../../../..')

/** Parse the shipped base patch and flatten every `insert` row across its patch documents. */
function loadBaseRows(): PatchRow[] {
  const parsed = yaml.load(
    readFileSync(resolve(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
  return parsed.flatMap((patch): PatchRow[] =>
    typeof patch === 'object' && patch !== null
      ? (patch as { insert?: PatchRow[] }).insert ?? []
      : [])
}

describe('dsh-base compaction ceiling (SWD-114)', () => {
  it('mounts compaction-basic at the founder ceiling of 0.75, not the package default', () => {
    const row = loadBaseRows().find(candidate => candidate.id === 'compaction-basic')
    if (row === undefined) throw new Error('base patch must mount a compaction-basic row')
    expect(row.name).toBe('@deepseek-ai/dsh-compaction-basic')
    expect(row.config?.thresholdRatio, FOUNDER_CEILING_MESSAGE).toBe(0.75)
  })

  it('documents the package default is still 0.95, so the bundle row is a deliberate override', () => {
    // Reads the package's OWN resolved default (no override applied) rather
    // than a hard-coded 0.95 literal here, so this fails loudly -- rather
    // than silently going stale -- the moment someone "fixes" the ceiling
    // mismatch by editing the package default instead of the bundle row.
    const packageDefault = resolveConfig({})
    expect(
      packageDefault.thresholdRatio,
      'compaction-basic package default moved off 0.95: the bundle row overrides it to the '
      + `founder ceiling deliberately, on top of this default (${FOUNDER_CEILING_MESSAGE})`,
    ).toBe(0.95)
  })

  it('mounts context-pressure enabled at the package default warning ladder', () => {
    const row = loadBaseRows().find(candidate => candidate.id === 'context-pressure')
    if (row === undefined) throw new Error('base patch must mount a context-pressure row')
    expect(row.name).toBe('@deepseek-ai/dsh-context-pressure')
    expect(row.disabled, 'context-pressure warning ladder must not be disabled').toBeUndefined()
    const spec = resolveSpec(row.config ?? {})
    expect(spec.thresholds.map(threshold => threshold.ratio)).toEqual([...DEFAULT_THRESHOLDS])
    // Documents the ladder this row is relying on staying [0.25, 0.5, 0.75]
    // (imported from the package, not retyped) as the effective warning gate
    // ahead of the 0.75 compaction cut.
    expect([...DEFAULT_THRESHOLDS]).toEqual([0.25, 0.5, 0.75])
  })

  it('keeps compaction-basic and context-pressure reachable from the real CLI install closure', () => {
    const installAnchor = resolve(REPO_ROOT, 'apps/cli/package.json')
    const closure = computeInstallationClosure(installAnchor)
    expect(closure.has('@deepseek-ai/dsh-compaction-basic')).toBe(true)
    expect(closure.has('@deepseek-ai/dsh-context-pressure')).toBe(true)
  })
})
