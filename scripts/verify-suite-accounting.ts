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
  /** The parenthesised total vitest declared for this line, when found. */
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
const SEGMENT_PATTERN = /^(\d+)\s+([A-Za-z]+)$/

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
 * this check exists to catch.
 * @param cleanOutput - vitest's captured stdout+stderr, ANSI already stripped.
 * @param label - which summary line to parse.
 * @returns the line's accounting verdict; a missing or malformed line is a failure, never a vacuous pass.
 */
function parseSummaryLine(cleanOutput: string, label: 'Test Files' | 'Tests'): SuiteAccountingLineVerdict {
  const raw = findLastSummaryLine(cleanOutput, label)
  if (raw === undefined) {
    return unparsedLineVerdict(label, undefined, undefined, `could not find the ${label} line in the run output`)
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

/**
 * Exit code used when vitest itself exited 0 but the accounting check found
 * the summary numbers do not add up. Deliberately distinct from vitest's own
 * exit codes (0 success, 1 failure) so CI logs and callers can tell "tests
 * failed" apart from "a worker most likely died and this run cannot be
 * trusted".
 */
export const ACCOUNTING_FAILURE_EXIT_CODE = 97

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
  const verdict = verifySuiteAccounting(combinedOutput)

  if (!verdict.ok) console.error(`\n${formatAccountingFailure(verdict)}`)

  if (vitestExitCode !== 0) {
    // vitest's own failure always wins and is never masked by this check.
    process.exitCode = vitestExitCode
    return
  }
  process.exitCode = verdict.ok ? 0 : ACCOUNTING_FAILURE_EXIT_CODE
}

if (import.meta.main) await main()
