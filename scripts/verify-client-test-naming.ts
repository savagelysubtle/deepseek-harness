/**
 * Enforce the `packages/client` test-naming convention documented above the
 * `exclude` block in `tsconfig.host.json`: a test file names the face it
 * covers -- `*.client.*` belongs to the Client aggregate, `*.host.spec.ts` to
 * the Host aggregate -- and the two suffixes are mutually exclusive.
 *
 * `tsconfig.host.json` includes `packages/*\/*\/tests/**\/*.ts` and excludes
 * only the `.client.*` shapes. A test file under `packages/client/*\/tests/`
 * that carries neither marker therefore matches the host include glob with no
 * exclude to remove it: it silently joins the host TypeScript program and can
 * drag `packages/client/**` source in behind it. Warm, incremental `tsc -b`
 * runs do not re-validate include/exclude glob membership, so this break is
 * invisible until a cold build -- which is exactly why this fast, dedicated
 * check exists instead.
 * @module scripts/verify-client-test-naming
 */

import { globSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Marks a test as belonging to the Client aggregate. */
const CLIENT_MARKER = '.client.'
/** Suffix marking a test as belonging to the Host aggregate. */
const HOST_SPEC_SUFFIX = '.host.spec.ts'

/** Result of checking every test file under `packages/client/*\/tests/**`. */
export interface ClientTestNamingReport {
  /** Number of `.ts`/`.tsx` test files checked. */
  checkedCount: number
  /** Repository-relative diagnostics for files carrying neither marker. */
  failures: string[]
}

function isNamedCorrectly(fileName: string): boolean {
  return fileName.includes(CLIENT_MARKER) || fileName.endsWith(HOST_SPEC_SUFFIX)
}

/**
 * Check every `.ts`/`.tsx` file under `packages/client/*\/tests/**` for the
 * `.client.` / `.host.spec.ts` naming convention.
 * @param root - absolute repository root containing `packages/client`.
 * @returns the checked file count and every naming violation.
 */
export function inspectClientTestNaming(root: string): ClientTestNamingReport {
  const files = globSync('packages/client/*/tests/**/*.{ts,tsx}', { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()

  const failures: string[] = []
  for (const file of files) {
    if (isNamedCorrectly(basename(file))) continue
    failures.push(
      `${file}: name must contain ".client." (Client aggregate) or end in ".host.spec.ts" (Host ` +
        'aggregate); found neither. tsconfig.host.json includes this path and excludes only the ' +
        '".client.*" shapes, so an unmarked file silently joins the host TypeScript program and can ' +
        'break it in a way a warm, incremental build will not report.',
    )
  }

  return { checkedCount: files.length, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectClientTestNaming(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-client-test-naming: unmarked packages/client test file(s) found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-client-test-naming: ${String(report.checkedCount)} file(s) checked, all named correctly.\n`,
    )
  }
}
