/**
 * `dsh owners <path>` and `dsh owners --overlaps` — read-only seat territory report (OP-115).
 * Thin wrapper: parse nothing (args.ts did), load the org registry, call the pure functions of @deepseek-ai/dsh-mailbox,
 * print, return the exit code.
 * @module apps/cli/src/owners
 */
import { resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { findOverlaps, findOwners, formatOverlapReport, formatOwnerLookup, loadOrgRegistry } from '@deepseek-ai/dsh-mailbox'

/** Process-facing effects of one invocation: the two output streams the runner writes to. */
export interface OwnersIo {
  readonly stdout: { write(text: string): unknown }
  readonly stderr: { write(text: string): unknown }
}

/** Output sinks the runner writes to; tests substitute captures. */
export const internals: OwnersIo = { stdout: process.stdout, stderr: process.stderr }

/** What args.ts decided: either a path to look up, or the overlaps report — never both, and never neither. */
export interface OwnersRequest {
  readonly path: string | undefined
  readonly overlaps: boolean
}

/** Injection points for tests: a custom registry file, a working directory for path resolution, and an overlap scan cap. */
export interface OwnersOptions {
  readonly registryPath?: string
  readonly cwd?: string
  readonly maxFiles?: number
}

/**
 * Run one `dsh owners` invocation: load the org registry, call the pure owner functions, print via `internals`.
 * @param request The parsed request from args.ts.
 * @param options Optional injections for tests; defaults read the home registry and resolve paths against the process cwd.
 * @returns 0 on a lookup or an uncapped report with no overlaps, 1 when overlaps exist, 2 on usage or registry errors
 *   and for a capped report.
 */
export async function runOwners(request: OwnersRequest, options: OwnersOptions = {}): Promise<number> {
  if ((request.overlaps && request.path !== undefined) || (!request.overlaps && request.path === undefined)) {
    internals.stderr.write('dsh owners: pass exactly one of <path> or --overlaps\n')
    return 2
  }
  const registryPath = options.registryPath ?? dshHomePath('org', 'registry.yml')
  let registry: Awaited<ReturnType<typeof loadOrgRegistry>>
  try {
    registry = await loadOrgRegistry(registryPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    internals.stderr.write(`dsh owners: cannot read the org registry at ${registryPath}: ${message}\n`)
    return 2
  }
  if (request.path !== undefined) {
    const absolute = resolve(options.cwd ?? process.cwd(), request.path)
    internals.stdout.write(`${formatOwnerLookup(findOwners(registry, absolute))}\n`)
    return 0
  }
  const report = findOverlaps(registry, options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles })
  internals.stdout.write(`${formatOverlapReport(report)}\n`)
  if (report.capped) return 2
  return report.overlappingPaths > 0 ? 1 : 0
}
