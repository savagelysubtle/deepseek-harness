import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNTING_FAILURE_EXIT_CODE,
  formatAccountingFailure,
  formatAccountingSkippedNotice,
  reporterWasOverridden,
  resolveWrapperExitCode,
  verifySuiteAccounting,
} from './verify-suite-accounting.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

const PLUGIN_WARNING = 'The plugin "vite-tsconfig-paths" is detected. Vite now supports tsconfig paths '
  + 'resolution natively via the resolve.tsconfigPaths option. You can remove the plugin and set '
  + 'resolve.tsconfigPaths: true in your Vite config instead.'

/** A real 893-file run whose worker pool never lost a file. */
const HEALTHY_RUN = [
  PLUGIN_WARNING,
  '',
  ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
  '',
  '',
  ' Test Files  885 passed | 8 skipped (893)',
  '      Tests  14591 passed | 109 skipped (14700)',
  '   Start at  09:14:02',
  '   Duration  612.40s (transform 41.20s, setup 58.11s, import 12.04s, tests 480.02s, environment 0.31s)',
  '',
].join('\n')

/**
 * The same run, except one worker died mid-run and silently took a test
 * file with it: no failure line anywhere, exit code 0, but 884 + 8 is not
 * 893 and 14589 + 109 is not 14700.
 */
const DEFECTIVE_RUN = [
  PLUGIN_WARNING,
  '',
  ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
  '',
  '',
  ' Test Files  884 passed | 8 skipped (893)',
  '      Tests  14589 passed | 109 skipped (14700)',
  '   Start at  09:14:02',
  '   Duration  598.11s (transform 40.02s, setup 57.90s, import 11.88s, tests 466.13s, environment 0.30s)',
  '',
].join('\n')

/**
 * A worker died AND a surviving file had a genuine test failure — the shape
 * from a real captured log: `Test Files  1 failed | 883 passed | 8 skipped
 * (893)`. Both things are true at once here, which is exactly what
 * formatAccountingFailure must not misrepresent: it must not claim vitest
 * "reported no failures" when the segments themselves say otherwise.
 */
const SHORTFALL_WITH_GENUINE_FAILURE_RUN = [
  PLUGIN_WARNING,
  '',
  ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  packages/session/session-persistence-jsonl/tests/jsonl.spec.ts > jsonl > round-trips a record',
  'AssertionError: expected 1 to be 2',
  '',
  ' Test Files  1 failed | 883 passed | 8 skipped (893)',
  '      Tests  4 failed | 14585 passed | 109 skipped (14700)',
  '   Start at  09:14:02',
  '   Duration  601.02s (transform 40.55s, setup 57.98s, import 11.95s, tests 469.02s, environment 0.30s)',
  '',
].join('\n')

/** A legitimate red run: real failing tests, and the accounting still closes. */
const GENUINE_FAILURE_RUN = [
  PLUGIN_WARNING,
  '',
  ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  packages/session/session-persistence-jsonl/tests/jsonl.spec.ts > jsonl > round-trips a record',
  'AssertionError: expected 1 to be 2',
  '',
  ' Test Files  1 failed | 884 passed | 8 skipped (893)',
  '      Tests  3 failed | 14588 passed | 109 skipped (14700)',
  '   Start at  09:14:02',
  '   Duration  603.55s (transform 40.91s, setup 58.02s, import 12.00s, tests 471.77s, environment 0.31s)',
  '',
].join('\n')

describe('verifySuiteAccounting', () => {
  it('passes a healthy run where every declared file and test is accounted for', () => {
    const verdict = verifySuiteAccounting(HEALTHY_RUN)
    expect(verdict.ok).toBe(true)
    expect(verdict.testFiles).toMatchObject({ ok: true, declaredTotal: 893, accountedTotal: 893, delta: 0 })
    expect(verdict.tests).toMatchObject({ ok: true, declaredTotal: 14700, accountedTotal: 14700, delta: 0 })
  })

  it('fails a run where a worker died, naming a shortfall of 1 file and 2 tests', () => {
    const verdict = verifySuiteAccounting(DEFECTIVE_RUN)
    expect(verdict.ok).toBe(false)

    expect(verdict.testFiles.ok).toBe(false)
    expect(verdict.testFiles.declaredTotal).toBe(893)
    expect(verdict.testFiles.accountedTotal).toBe(892)
    expect(verdict.testFiles.delta).toBe(-1)
    expect(verdict.testFiles.reason).toContain('1 missing')

    expect(verdict.tests.ok).toBe(false)
    expect(verdict.tests.declaredTotal).toBe(14700)
    expect(verdict.tests.accountedTotal).toBe(14698)
    expect(verdict.tests.delta).toBe(-2)
    expect(verdict.tests.reason).toContain('2 missing')
  })

  it('treats a genuine red run as accounting that closes, not an accounting fault', () => {
    const verdict = verifySuiteAccounting(GENUINE_FAILURE_RUN)
    expect(verdict.ok).toBe(true)
    expect(verdict.testFiles).toMatchObject({ ok: true, declaredTotal: 893, accountedTotal: 893, delta: 0 })
    expect(verdict.tests).toMatchObject({ ok: true, declaredTotal: 14700, accountedTotal: 14700, delta: 0 })
    // A real failure is still visible in the segments — this check does not hide it, it just
    // isn't the thing that makes accounting fail.
    expect(verdict.testFiles.segments).toContainEqual({ count: 1, category: 'failed' })
    expect(verdict.tests.segments).toContainEqual({ count: 3, category: 'failed' })
  })

  it('parses ANSI-coloured summary lines identically to plain ones', () => {
    const colored = [
      PLUGIN_WARNING,
      '',
      ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
      '',
      '',
      ' [1mTest[22m[32m Files[39m  [32m885 passed[39m | [33m8 skipped[39m (893)',
      '      [32mTests[39m  [32m14591 passed[39m | [33m109 skipped[39m (14700)',
      '   Start at  09:14:02',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(colored)
    expect(verdict.ok).toBe(true)
    expect(verdict.testFiles).toMatchObject({ ok: true, declaredTotal: 893, accountedTotal: 893 })
    expect(verdict.tests).toMatchObject({ ok: true, declaredTotal: 14700, accountedTotal: 14700 })
  })

  it('counts a todo category it has never been told about, rather than dropping it', () => {
    const withTodo = [
      ' Test Files  1 failed (1)',
      '      Tests  1 failed | 1 passed | 1 skipped | 1 todo (4)',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(withTodo)
    expect(verdict.ok).toBe(true)
    expect(verdict.tests.segments).toContainEqual({ count: 1, category: 'todo' })
    expect(verdict.tests.accountedTotal).toBe(4)
  })

  it('fails rather than passing vacuously when a summary line never appears', () => {
    const truncated = [
      PLUGIN_WARNING,
      '',
      ' RUN  v4.1.8 /home/runner/work/dsh/dsh',
      '',
      ' Test Files  885 passed | 8 skipped (893)',
      // The process died before vitest ever printed the Tests line.
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(truncated)
    expect(verdict.ok).toBe(false)
    expect(verdict.testFiles.ok).toBe(true)
    expect(verdict.tests.ok).toBe(false)
    expect(verdict.tests.raw).toBeUndefined()
    expect(verdict.tests.reason).toContain('could not find the Tests line')
  })

  it('fails and flags a surplus when segments add up to more than the declared total', () => {
    const surplus = [
      ' Test Files  886 passed | 8 skipped (893)',
      '      Tests  14591 passed | 109 skipped (14700)',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(surplus)
    expect(verdict.ok).toBe(false)
    expect(verdict.testFiles.ok).toBe(false)
    expect(verdict.testFiles.accountedTotal).toBe(894)
    expect(verdict.testFiles.delta).toBe(1)
    expect(verdict.testFiles.reason).toContain('more than declared')
  })

  it('takes the LAST occurrence of each summary line when interim content repeats the words', () => {
    const withInterimNoise = [
      ' FAIL  some/flaky.spec.ts > Test Files are not actually mentioned here, just Tests in prose',
      ' Test Files  10 passed (11)', // an earlier, wrong total that must not win
      '      Tests  50 passed (51)',
      ' Test Files  885 passed | 8 skipped (893)',
      '      Tests  14591 passed | 109 skipped (14700)',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(withInterimNoise)
    expect(verdict.ok).toBe(true)
    expect(verdict.testFiles.declaredTotal).toBe(893)
    expect(verdict.tests.declaredTotal).toBe(14700)
  })
})

describe('formatAccountingFailure', () => {
  it('renders a block naming the failing line, the shortfall, the cause, and the remedy', () => {
    const verdict = verifySuiteAccounting(DEFECTIVE_RUN)
    const block = formatAccountingFailure(verdict)

    expect(block).toContain('SUITE ACCOUNTING FAILURE')
    expect(block).toContain('Test Files')
    expect(block).toContain('declared total: 893')
    expect(block).toContain('MISSING:        1')
    expect(block).toContain('Tests')
    expect(block).toContain('declared total: 14700')
    expect(block).toContain('MISSING:        2')
    expect(block).toContain('worker process died')
    expect(block).toContain('Remedy: re-run')
    expect(block).toContain('NOT a')
  })

  it('claims vitest reported no failures only when the segments actually say so', () => {
    const verdict = verifySuiteAccounting(DEFECTIVE_RUN)
    const block = formatAccountingFailure(verdict)

    expect(block).toContain('reported no failures')
    expect(block).toContain('no failure line is printed anywhere')
    // The failure-present wording must not leak into a run with zero failed segments.
    expect(block).not.toContain('also reported real')
  })

  it('does not claim vitest reported no failures when a shortfall run also had real failures', () => {
    const verdict = verifySuiteAccounting(SHORTFALL_WITH_GENUINE_FAILURE_RUN)
    expect(verdict.ok).toBe(false)
    // Sanity: this fixture really does carry both problems at once.
    expect(verdict.testFiles.segments).toContainEqual({ count: 1, category: 'failed' })
    expect(verdict.tests.segments).toContainEqual({ count: 4, category: 'failed' })

    const block = formatAccountingFailure(verdict)

    expect(block).toContain('also reported real')
    expect(block).toContain('separate problem')
    // The exact false claim this test guards against: the block must never tell the
    // reader vitest reported no failures when a `failed` segment says otherwise.
    expect(block).not.toContain('reported no failures')
    expect(block).not.toContain('no failure line is printed anywhere')
  })
})

describe('verifySuiteAccounting — multi-word categories', () => {
  it('counts a two-word "expected fail" category instead of failing to parse it', () => {
    // Real shape from the installed runner's getStateString: a `.fails()` test that
    // failed as expected renders as a literal two-word category, "expected fail".
    const withExpectedFail = [
      ' Test Files  885 passed | 8 skipped (893)',
      '      Tests  14588 passed | 3 expected fail | 109 skipped (14700)',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(withExpectedFail)
    expect(verdict.ok).toBe(true)
    expect(verdict.tests.segments).toContainEqual({ count: 3, category: 'expected fail' })
    expect(verdict.tests.accountedTotal).toBe(14700)
  })
})

describe('verifySuiteAccounting — bare "no tests"', () => {
  it('closes a line that is vitest\'s genuine zero-task "no tests" output, not a parse failure', () => {
    // Real shape: a file that fails to collect any suite still gets a normal
    // Test Files tally, but the Tests line has nothing to count and prints the
    // bare word pair with no parenthesised total at all.
    const zeroTasksOnTestsLine = [
      ' Test Files  1 failed (1)',
      '      Tests  no tests',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(zeroTasksOnTestsLine)
    expect(verdict.ok).toBe(true)
    expect(verdict.tests).toMatchObject({ ok: true, declaredTotal: 0, accountedTotal: 0, delta: 0, segments: [] })
  })

  it('closes both lines when both are genuinely empty', () => {
    const bothEmpty = [
      ' Test Files  no tests',
      '      Tests  no tests',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(bothEmpty)
    expect(verdict.ok).toBe(true)
    expect(verdict.testFiles).toMatchObject({ ok: true, declaredTotal: 0, accountedTotal: 0 })
    expect(verdict.tests).toMatchObject({ ok: true, declaredTotal: 0, accountedTotal: 0 })
  })

  it('does not treat other unparenthesised text as the empty case — only the exact "no tests" text', () => {
    const notActuallyEmpty = [
      ' Test Files  885 passed | 8 skipped (893)',
      '      Tests  no things happened',
      '',
    ].join('\n')

    const verdict = verifySuiteAccounting(notActuallyEmpty)
    expect(verdict.ok).toBe(false)
    expect(verdict.tests.ok).toBe(false)
    expect(verdict.tests.reason).toContain('no parenthesised declared total')
  })
})

describe('reporterWasOverridden', () => {
  it('detects every real spelling of a reporter override', () => {
    expect(reporterWasOverridden(['--reporter=json'])).toBe(true)
    expect(reporterWasOverridden(['--reporter', 'dot'])).toBe(true)
    expect(reporterWasOverridden(['--reporters=tap'])).toBe(true)
    expect(reporterWasOverridden(['--reporters', 'junit'])).toBe(true)
    expect(reporterWasOverridden(['run', '--reporter=json'])).toBe(true)
  })

  it('does not false-positive on ordinary runs or unrelated flags', () => {
    expect(reporterWasOverridden([])).toBe(false)
    expect(reporterWasOverridden(['run'])).toBe(false)
    expect(reporterWasOverridden(['run', 'scripts/foo.spec.ts'])).toBe(false)
    expect(reporterWasOverridden(['--coverage'])).toBe(false)
    // Must match the whole flag, not merely start with it.
    expect(reporterWasOverridden(['--reporterFoo'])).toBe(false)
  })
})

describe('formatAccountingSkippedNotice', () => {
  it('visibly says the check was skipped, why, and that the run is unchecked', () => {
    const notice = formatAccountingSkippedNotice()

    expect(notice).toContain('SUITE ACCOUNTING SKIPPED')
    expect(notice).toContain('reporter')
    expect(notice).toContain('NOT been checked')
  })
})

describe('resolveWrapperExitCode', () => {
  it('passes vitest\'s failure through when the accounting closes', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 1, reporterOverridden: false, verdictOk: true })).toBe(1)
  })

  it('lets vitest\'s failure win even when the accounting is also broken', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 1, reporterOverridden: false, verdictOk: false })).toBe(1)
  })

  it('passes a clean vitest run through when the accounting closes', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 0, reporterOverridden: false, verdictOk: true })).toBe(0)
  })

  it('fails a clean vitest run with the accounting exit code when the accounting is broken', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 0, reporterOverridden: false, verdictOk: false }))
      .toBe(ACCOUNTING_FAILURE_EXIT_CODE)
  })

  it('passes a clean vitest run through when the reporter was overridden, regardless of the verdict', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 0, reporterOverridden: true, verdictOk: false })).toBe(0)
  })

  it('passes vitest\'s failure through when the reporter was overridden, ignoring the verdict', () => {
    expect(resolveWrapperExitCode({ vitestExitCode: 1, reporterOverridden: true, verdictOk: true })).toBe(1)
  })
})

describe('verify-suite-accounting CLI — end to end', () => {
  it('exits 1 for a genuinely failing suite, proving the wrapper passes vitest\'s own exit code through', { timeout: 30_000 }, async () => {
    // A real child process, not a mock: the property under test is that the
    // wrapper's OWN process exit status reflects vitest's failure, which no
    // unit test of resolveWrapperExitCode can prove by itself — a verifier
    // once mis-reported "exit 0 despite a failure" by reading a `| tee`
    // pipeline's exit instead of the wrapper's.
    //
    // The temp spec lives under scripts/ (not a mkdtemp dir outside the
    // repo) because vitest.config.ts's include list only matches
    // 'scripts/**/*.spec.ts' (and similar in-repo globs); a file outside the
    // repo tree would never be collected regardless of the path filter
    // passed on the command line.
    const tempSpecPath = join(repositoryRoot, 'scripts', `tmp-always-failing-${randomUUID()}.spec.ts`)
    const tempSpecRelPath = 'scripts/' + tempSpecPath.slice(tempSpecPath.lastIndexOf('/') + 1)

    await writeFile(
      tempSpecPath,
      [
        "import { expect, it } from 'vitest'",
        '',
        "it('deliberately fails to prove the wrapper propagates vitest\\'s exit code', () => {",
        '  expect(true).toBe(false)',
        '})',
        '',
      ].join('\n'),
    )

    try {
      const result = spawnSync(
        process.execPath,
        [tsxCli, 'scripts/verify-suite-accounting.ts', 'run', tempSpecRelPath],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1' },
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1)
    } finally {
      await rm(tempSpecPath, { force: true })
    }
  })
})
