/**
 * Vitest's own "N passed | M skipped (T)" summary is not proof that every
 * declared test file ran. A worker process can die mid-run and silently
 * take the file it was holding with it: no failure line is printed, the
 * exit code is still 0, and the summary reads as a clean pass — except the
 * parenthesised declared total no longer equals the sum of the segments
 * before it (884 passed + 8 skipped = 892, not the declared 893). The
 * project's gate standard is "zero failures", which cannot see this
 * defect; the arithmetic check below can, and it is branch-independent
 * (884 + 8 is not 893 regardless of which branch produced those numbers).
 *
 * This script has two halves:
 *  - a pure parser (`verifySuiteAccounting`) that takes captured vitest
 *    output and checks the "Test Files" and "Tests" summary lines close;
 *  - a CLI entry that spawns vitest, tees its output live to this
 *    process's own stdout/stderr while accumulating it, and fails the run
 *    when either vitest failed or the accounting does not close.
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One `<count> <category>` segment inside a vitest summary line, e.g. "885 passed". */
export interface SuiteAccountingSegment {
  /** The segment's count, e.g. `885`. */
  readonly count: number
  /** The segment's category word, e.g. `passed`, `failed`, `skipped`, `todo`. */
  readonly category: string
}

/** Parsed verdict for one vitest summary line ("Test Files" or "Tests"). */
export interface SuiteAccountingLineVerdict {
  /** The summary line's label, exactly as vitest prints it. */
  readonly label: 'Test Files' | 'Tests'
  /** True only when the line was found, every segment parsed, and the segments sum to the declared total. */
  readonly ok: boolean
  /** The line's text after the label, ANSI stripped and trimmed, when the line was found. */
  readonly raw: string | undefined
  /** The parenthesised total vitest declared for this line, when found (0 for vitest's bare "no tests"). */
  readonly declaredTotal: number | undefined
  /** Every `<count> <category>` segment parsed from before the declared total. Empty when parsing failed. */
  readonly segments: readonly SuiteAccountingSegment[]
  /** Sum of every parsed segment's count. */
  readonly accountedTotal: number
  /** `accountedTotal - declaredTotal`: negative is a shortfall, positive is a surplus, undefined when no total was found. */
  readonly delta: number | undefined
  /** Human explanation of why `ok` is false. Undefined when `ok` is true. */
  readonly reason: string | undefined
}

/** Combined accounting verdict for one vitest run's captured output. */
export interface SuiteAccountingVerdict {
  /** True only when both summary lines close. */
  readonly ok: boolean
  readonly testFiles: SuiteAccountingLineVerdict
  readonly tests: SuiteAccountingLineVerdict
}

// Vitest (via picocolors/tinyrainbow) can emit standard CSI SGR sequences in
// its output, and does so unconditionally under GITHUB_ACTIONS even without
// a TTY (see .github/workflows/sandbox.yml). Strip them before parsing so a
// colored run and a plain one parse identically.
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}

const DECLARED_TOTAL_PATTERN = /\((\d+)\)\s*$/
// Vitest categories are not always one word: `.fails()` tests are reported as
// a literal two-word "expected fail" category (installed runner, getStateString
// in node_modules/vitest/dist/chunks/utils.BS4fH3nR.js). Accept any run of
// space-separated words so a category like that is still counted.
const SEGMENT_PATTERN = /^(\d+)\s+([A-Za-z]+(?: [A-Za-z]+)*)$/
// Vitest's own zero-task branch (same getStateString) prints this bare word
// pair with no parenthesised total at all when a line's task list is empty —
// not "missing", genuinely nothing to account for. Recognised only as this
// exact text, never as a general stand-in for "the line could not be parsed".
const BARE_NO_TESTS = 'no tests'

function findLastSummaryLine(cleanOutput: string, label: 'Test Files' | 'Tests'): string | undefined {
  const linePattern = new RegExp(`^\\s*${label}\\s+(.*)$`)
  let raw: string | undefined
  for (const line of cleanOutput.split('\n')) {
    const captured = linePattern.exec(line)?.[1]
    if (captured !== undefined) raw = captured.trimEnd()
  }
  return raw
}

function unparsedLineVerdict(
  label: 'Test Files' | 'Tests',
  raw: string | undefined,
  declaredTotal: number | undefined,
  reason: string,
): SuiteAccountingLineVerdict {
  return {
    label,
    ok: false,
    raw,
    declaredTotal,
    segments: [],
    accountedTotal: 0,
    delta: undefined,
    reason,
  }
}

/**
 * Parse and verify one vitest summary line ("Test Files ..." or "Tests
 * ..."), taking the LAST occurrence in the output (a run can print interim
 * content bearing the same words earlier). Sums every `<count> <category>`
 * segment generically instead of enumerating passed/failed/skipped/todo, so
 * a category this function has never heard of still gets counted rather
 * than silently dropped — that enumeration gap is the exact class of bug
 * this check exists to catch. A category may be more than one word (e.g.
 * "expected fail"); that is still one segment, not a parse failure.
 * @param cleanOutput - vitest's captured stdout+stderr, ANSI already stripped.
 * @param label - which summary line to parse.
 * @returns the line's accounting verdict; a missing or malformed line is a failure, never a vacuous pass.
 *   Vitest's own bare "no tests" (zero tasks, no parenthesised total) is the one exception: it closes with 0/0.
 */
function parseSummaryLine(cleanOutput: string, label: 'Test Files' | 'Tests'): SuiteAccountingLineVerdict {
  const raw = findLastSummaryLine(cleanOutput, label)
  if (raw === undefined) {
    return unparsedLineVerdict(label, undefined, undefined, `could not find the ${label} line in the run output`)
  }
  if (raw === BARE_NO_TESTS) {
    return {
      label,
      ok: true,
      raw,
      declaredTotal: 0,
      segments: [],
      accountedTotal: 0,
      delta: 0,
      reason: undefined,
    }
  }

  const declaredMatch = DECLARED_TOTAL_PATTERN.exec(raw)
  if (declaredMatch?.[1] === undefined) {
    return unparsedLineVerdict(
      label,
      raw,
      undefined,
      `found the ${label} line but it has no parenthesised declared total: ${JSON.stringify(raw)}`,
    )
  }
  const declaredTotal = Number.parseInt(declaredMatch[1], 10)

  const segmentsText = raw.slice(0, declaredMatch.index).trim()
  const segmentTexts = segmentsText.length === 0 ? [] : segmentsText.split('|').map(segment => segment.trim())
  const segments: SuiteAccountingSegment[] = []
  for (const segmentText of segmentTexts) {
    const segmentMatch = SEGMENT_PATTERN.exec(segmentText)
    if (segmentMatch?.[1] === undefined || segmentMatch[2] === undefined) {
      return unparsedLineVerdict(
        label,
        raw,
        declaredTotal,
        `could not parse segment ${JSON.stringify(segmentText)} in the ${label} line`,
      )
    }
    segments.push({ count: Number.parseInt(segmentMatch[1], 10), category: segmentMatch[2] })
  }

  const accountedTotal = segments.reduce((sum, segment) => sum + segment.count, 0)
  const delta = accountedTotal - declaredTotal
  if (delta !== 0) {
    return {
      label,
      ok: false,
      raw,
      declaredTotal,
      segments,
      accountedTotal,
      delta,
      reason: delta < 0
        ? `declared total ${String(declaredTotal)} but the segments only account for ${String(accountedTotal)} (${String(-delta)} missing)`
        : `declared total ${String(declaredTotal)} but the segments account for ${String(accountedTotal)} (${String(delta)} more than declared)`,
    }
  }

  return {
    label,
    ok: true,
    raw,
    declaredTotal,
    segments,
    accountedTotal,
    delta: 0,
    reason: undefined,
  }
}

/**
 * Verify that a vitest run's "Test Files" and "Tests" summary lines both
 * close: the sum of their `<count> <category>` segments must equal the
 * parenthesised declared total. This is a pure function over captured text
 * — no subprocess, no real suite — so it is exercised directly in
 * verify-suite-accounting.spec.ts against real vitest output fixtures.
 * @param capturedOutput - a vitest run's captured stdout+stderr, in the order it was produced.
 * @returns the combined verdict; `ok` is true only when both lines close.
 */
export function verifySuiteAccounting(capturedOutput: string): SuiteAccountingVerdict {
  const cleanOutput = stripAnsi(capturedOutput)
  const testFiles = parseSummaryLine(cleanOutput, 'Test Files')
  const tests = parseSummaryLine(cleanOutput, 'Tests')
  return { ok: testFiles.ok && tests.ok, testFiles, tests }
}

function describeLineFailure(line: SuiteAccountingLineVerdict): string[] {
  const rows: string[] = []
  rows.push(`${line.label}: ${line.reason ?? 'accounting does not close'}`)
  if (line.raw !== undefined) rows.push(`  summary line:   ${line.label}  ${line.raw}`)
  if (line.declaredTotal !== undefined) rows.push(`  declared total: ${String(line.declaredTotal)}`)
  rows.push(
    `  accounted for:  ${String(line.accountedTotal)}`
    + (line.segments.length === 0 ? '' : ` (${line.segments.map(segment => `${String(segment.count)} ${segment.category}`).join(', ')})`),
  )
  if (line.delta !== undefined && line.delta < 0) rows.push(`  MISSING:        ${String(-line.delta)}`)
  if (line.delta !== undefined && line.delta > 0) rows.push(`  SURPLUS:        ${String(line.delta)}`)
  return rows
}

/**
 * Render a suite-accounting failure as a block that cannot be skimmed past:
 * which line failed, what was declared, what was accounted for, how many
 * are missing, the likely cause, and the remedy. Any guard that blocks a
 * developer must say so on screen, in that moment, with the reason and the
 * remedy — a silent fence is never acceptable here.
 * @param verdict - a failing verdict from `verifySuiteAccounting`.
 * @returns the formatted block, ready to print to stderr.
 */
export function formatAccountingFailure(verdict: SuiteAccountingVerdict): string {
  const border = '='.repeat(78)
  // Whether this run ALSO reported genuine failures changes what is true about
  // it. Asserting "vitest reported no failures" unconditionally would make this
  // block state something false on a run that lost a file AND failed a test --
  // which is the exact defect class this check exists to catch.
  const reportedFailures = [verdict.testFiles, verdict.tests]
    .flatMap(line => line.segments)
    .some(segment => segment.category === 'failed' && segment.count > 0)
  const lines: string[] = [
    border,
    'SUITE ACCOUNTING FAILURE',
    border,
    '',
    ...(reportedFailures
      ? [
        'The vitest summary below does NOT add up. This run also reported real',
        'test failures, which is a separate problem: on top of those, tests are',
        'missing entirely. Fixing the failures will not make this run trustworthy.',
      ]
      : [
        'The vitest summary below does NOT add up, even though vitest itself',
        'reported no failures. A green-looking summary in this state is NOT a',
        'passing run.',
      ]),
    '',
  ]
  for (const line of [verdict.testFiles, verdict.tests]) {
    if (line.ok) continue
    lines.push(...describeLineFailure(line), '')
  }
  lines.push(
    'Most likely cause: a vitest worker process died mid-run and silently',
    'took a test file with it.',
    ...(reportedFailures
      ? []
      : [
        'When that happens, no failure line is printed anywhere in the output',
        '— only this arithmetic mismatch shows it.',
      ]),
    '',
    'Remedy: re-run the suite. Do not trust this run\'s pass count.',
    border,
  )
  return lines.join('\n')
}

// Vitest's canonical flag is `--reporters`; `--reporter` is its own alias
// (node_modules/vitest/dist/chunks/cac.C9xsMMkH.js), and either accepts
// `=value` or a separate value argument. Any custom reporter (json, dot,
// tap, junit, ...) replaces the default one, and the default reporter is the
// only one that prints the "Test Files"/"Tests" lines this check parses.
const REPORTER_OVERRIDE_PATTERN = /^--reporters?(=.*)?$/

/**
 * True when the caller passed an explicit reporter override, in which case
 * vitest never prints the summary lines this check reads and the accounting
 * check cannot run at all.
 * @param vitestArgs - CLI arguments about to be forwarded to vitest.
 * @returns whether a `--reporter`/`--reporters` flag is present, in any spelling.
 */
export function reporterWasOverridden(vitestArgs: readonly string[]): boolean {
  return vitestArgs.some(arg => REPORTER_OVERRIDE_PATTERN.test(arg))
}

/**
 * Render the notice printed when the accounting check could not run because
 * the caller overrode vitest's reporter. This is a visible skip, never a
 * silent one — a guard that quietly switches itself off is the same defect
 * as a guard that quietly blocks a developer.
 * @returns the formatted notice, ready to print to stderr.
 */
export function formatAccountingSkippedNotice(): string {
  const border = '='.repeat(78)
  return [
    border,
    'SUITE ACCOUNTING SKIPPED',
    border,
    '',
    'A --reporter/--reporters override was passed, so vitest never printed the',
    '"Test Files" / "Tests" summary lines this check reads.',
    '',
    'This run has NOT been checked for a worker silently dropping a test file.',
    'Re-run with the default reporter if you need that protection.',
    border,
  ].join('\n')
}

/**
 * Exit code used when vitest itself exited 0 but the accounting check found
 * the summary numbers do not add up. Deliberately distinct from vitest's own
 * exit codes (0 success, 1 failure) so CI logs and callers can tell "tests
 * failed" apart from "a worker most likely died and this run cannot be
 * trusted".
 */
export const ACCOUNTING_FAILURE_EXIT_CODE = 97

/** Inputs to {@link resolveWrapperExitCode}. */
export interface ResolveWrapperExitCodeInput {
  /** Vitest's own exit code (a signal death is already folded to `1` by the caller). */
  readonly vitestExitCode: number
  /** Whether the caller passed a `--reporter`/`--reporters` override, per {@link reporterWasOverridden}. */
  readonly reporterOverridden: boolean
  /** Whether {@link verifySuiteAccounting}'s verdict closed. Ignored when `reporterOverridden` is true. */
  readonly verdictOk: boolean
}

/**
 * Decide this wrapper's own process exit code. Vitest's own failure always
 * wins and is never masked by the accounting check. When the reporter was
 * overridden, the accounting check never ran at all (no summary lines to
 * parse), so the verdict is ignored entirely and vitest's exit code is used
 * as-is. Otherwise, a clean vitest run whose accounting does not close fails
 * with {@link ACCOUNTING_FAILURE_EXIT_CODE} instead of 0.
 * @param input - vitest's exit code, whether its reporter was overridden, and the accounting verdict.
 * @returns the exit code this process should use.
 */
export function resolveWrapperExitCode(input: ResolveWrapperExitCodeInput): number {
  const { vitestExitCode, reporterOverridden, verdictOk } = input
  if (reporterOverridden) return vitestExitCode
  if (vitestExitCode !== 0) return vitestExitCode
  return verdictOk ? 0 : ACCOUNTING_FAILURE_EXIT_CODE
}

const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const root = resolve(import.meta.dirname, '..')

interface TeedVitestRun {
  readonly exitCode: number
  readonly combinedOutput: string
}

/**
 * Run vitest with every argument passed through unchanged, so existing
 * callers of the wrapped `test` script keep working. Tees vitest's combined
 * stdout+stderr: each chunk is written to this process's own stdout/stderr
 * the instant it arrives (a developer still sees the run live) and appended
 * to an accumulator in that same arrival order, which is handed to
 * `verifySuiteAccounting` once the process closes. Nothing is buffered
 * silently.
 * @param vitestArgs - CLI arguments to forward to vitest, verbatim.
 * @returns vitest's exit code (1 when it was killed by a signal) and the full teed output.
 */
function runVitestTeed(vitestArgs: readonly string[]): Promise<TeedVitestRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [vitestCli, ...vitestArgs], {
      cwd: root,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    let combinedOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk)
      combinedOutput += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      combinedOutput += chunk
    })
    child.once('error', (error) => {
      reject(new Error(`verify-suite-accounting: failed to spawn vitest: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      resolvePromise({ exitCode: signal !== null ? 1 : (code ?? 1), combinedOutput })
    })
  })
}

async function main(): Promise<void> {
  const vitestArgs = process.argv.slice(2)
  const { exitCode: vitestExitCode, combinedOutput } = await runVitestTeed(vitestArgs)
  const reporterOverridden = reporterWasOverridden(vitestArgs)

  if (reporterOverridden) {
    // Nothing to parse with a custom reporter — say so loudly and defer to
    // vitest's own exit code, rather than either faking a pass or blocking
    // a run this check was never able to inspect.
    console.error(`\n${formatAccountingSkippedNotice()}`)
    process.exitCode = resolveWrapperExitCode({ vitestExitCode, reporterOverridden, verdictOk: true })
    return
  }

  const verdict = verifySuiteAccounting(combinedOutput)

  if (!verdict.ok) console.error(`\n${formatAccountingFailure(verdict)}`)

  process.exitCode = resolveWrapperExitCode({ vitestExitCode, reporterOverridden, verdictOk: verdict.ok })
}

if (import.meta.main) await main()
