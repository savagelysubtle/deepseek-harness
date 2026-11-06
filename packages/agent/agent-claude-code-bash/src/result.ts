/**
 * What the model reads back. A call result has two text blocks. The first is the status, written by the host from
 * the real exit code, signal and duration, and every line of it starts with the status marker. The second is
 * what the program printed, sanitised, with any line that looks like a status line escaped, so program output
 * cannot pass for the host's word. Both go through the tools package's scrubber with the home directory as the
 * only root (paths inside the working directory stay readable) and a 64 Ki-character cap.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/result
 */

import { textResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { RUNNER_FAILURE_RULES } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatScrubOptions, SeatToolContext, SeatToolResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { MAX_OUTPUT_CHARS, STATUS_MARKER, TAIL_BYTES } from './limits.ts'
import type { SandboxRunOutcome } from './runner.ts'
import { cleanStream, oneLine } from './sanitize.ts'

/** How a call ended, as the status line names it. */
type CallStatus = 'exited' | 'signaled' | 'timeout' | 'aborted' | 'disk-floor' | 'runner-failure' | 'refused'

/** A rule that identifies a launcher failing before it ran the command (the shape of the sandbox seam's `RunnerFailureRule`). */
export interface FailureRule {
  /** Substrings, matched case-insensitively unless `caseSensitive` is set. */
  readonly fatalSignatures: readonly string[]
  /** When true, the signatures are matched exactly as written (a bundler's "failed to compile" must not match). */
  readonly caseSensitive?: boolean
  /** When true, only the first stderr line is examined, and it must START with a signature. */
  readonly firstLineOnly?: boolean
}

/** The bwrap runner-failure rule: the sandbox seam's own, imported rather than copied. */
export const BWRAP_FAILURE_RULES: readonly FailureRule[] = RUNNER_FAILURE_RULES.bwrap

/**
 * The `systemd-run` failure rule: when the transient scope cannot be created the launcher prints `Failed to ...`
 * first on stderr and exits 1, which would otherwise read as the command's own exit 1.
 */
export const SYSTEMD_RUN_FAILURE_RULES: readonly FailureRule[] = [{ fatalSignatures: ['Failed to '], firstLineOnly: true, caseSensitive: true }]

/** Every rule that marks a run as a launcher failure. */
const LAUNCHER_FAILURE_RULES: readonly FailureRule[] = [...BWRAP_FAILURE_RULES, ...SYSTEMD_RUN_FAILURE_RULES]

/** Denial dialect of bwrap read-only mounts (mirrors the provider's `denialSignatures`). */
const DENIAL_HINTS: ReadonlyArray<{ readonly needles: readonly string[]; readonly hint: string }> = [
  { needles: ['read-only file system'], hint: 'a path you tried to write is read-only in the sandbox (/usr, the whole .git and node_modules are read-only); write under the working directory or /tmp' },
  { needles: ['permission denied'], hint: 'the sandbox may be denying access to that path' },
  {
    needles: ['network is unreachable', 'could not resolve host', 'name or service not known', 'temporary failure in name resolution'],
    hint: 'the sandbox has no network',
  },
  { needles: ['no space left on device'], hint: 'a sandbox filesystem is full (/tmp is 1 GiB, the home directory 256 MiB, the working directory has a free-space floor)' },
]

/** Characters of the output block kept for its section headers and omission markers. */
const OUTPUT_OVERHEAD = 512

/** The scrub options of every block: the home directory is the only root, so paths inside the working directory stay readable. */
const SCRUB: SeatScrubOptions = { scrubRoots: ['home'], maxLength: MAX_OUTPUT_CHARS }

/** Facts the result needs besides the run itself. */
export interface CallSummary {
  /** The run. */
  readonly outcome: SandboxRunOutcome
  /** The deadline that applied, in seconds. */
  readonly deadlineS: number
  /** The longest deadline a call may ask for, in seconds. */
  readonly maxDeadlineS: number
  /** The free-space floor in bytes. */
  readonly floorBytes: number
  /** True when free space was below the floor after the run. */
  readonly lowDiskAfter: boolean
}

/**
 * Whether a finished run looks like the runner failing before the command ran: a non-zero exit and a stderr line
 * that matches a failure rule. A program can print such a line itself, so this only decides wording and a
 * re-check of the sandbox, never a verdict about the command.
 * @param outcome - the run.
 * @param rules - the rules (default the bwrap and systemd-run rules).
 * @returns true when a rule matches.
 */
export function looksLikeRunnerFailure(outcome: SandboxRunOutcome, rules: readonly FailureRule[] = LAUNCHER_FAILURE_RULES): boolean {
  if (outcome.exitCode === null || outcome.exitCode === 0) return false
  const exact = outcome.stderr.text.split('\n')
  const folded = exact.map(line => line.toLowerCase())
  return rules.some((rule) => {
    const lines = rule.caseSensitive === true ? exact : folded
    const signatures = rule.fatalSignatures.map(signature => rule.caseSensitive === true ? signature : signature.toLowerCase())
    if (rule.firstLineOnly === true) return signatures.some(signature => lines[0]?.startsWith(signature) === true)
    return signatures.some(signature => lines.some(line => line.includes(signature)))
  })
}

/** The status word for a run. */
function statusOf(outcome: SandboxRunOutcome): CallStatus {
  if (outcome.runnerFailure !== undefined) return 'runner-failure'
  if (outcome.killReason === 'deadline') return 'timeout'
  if (outcome.killReason === 'abort') return 'aborted'
  if (outcome.killReason === 'disk-floor') return 'disk-floor'
  return outcome.signal === null ? 'exited' : 'signaled'
}

/** Code-point array of a text. */
function points(text: string): string[] {
  return Array.from(text)
}

/** One stream as shown: what is left of it after the cut, and how much was cut. */
interface Shown {
  readonly text: string
  readonly dropped: number
}

/**
 * Keep the last `count` code points of the RAW stream, then sanitise and escape that slice, then put the host's
 * omission marker in front. Cutting first matters: the escape is a leading backslash, and a cut after escaping
 * could land exactly on it and leave a forged status line unescaped. The slice is cleaned as a whole, so its
 * first line is treated as a line start.
 */
function shownTail(raw: readonly string[], count: number, label: string): Shown {
  if (raw.length <= count) return { text: cleanStream(raw.join('')), dropped: 0 }
  const dropped = raw.length - count
  const kept = cleanStream(raw.slice(-count).join(''))
  return { text: `${STATUS_MARKER}] ${dropped} earlier ${label} character(s) omitted\n${kept}`, dropped }
}

/** Share a character budget between the two raw streams, keeping the tail of each. */
function fit(stdout: string, stderr: string, budget: number): { readonly stdout: Shown; readonly stderr: Shown } {
  const out = points(stdout)
  const err = points(stderr)
  const half = Math.floor(budget / 2)
  let outBudget = half
  let errBudget = budget - half
  if (out.length + err.length <= budget) {
    outBudget = out.length
    errBudget = err.length
  } else if (out.length <= half) {
    outBudget = out.length
    errBudget = budget - out.length
  } else if (err.length <= errBudget) {
    outBudget = budget - err.length
  }
  return { stdout: shownTail(out, outBudget, 'stdout'), stderr: shownTail(err, errBudget, 'stderr') }
}

/** Host-written notes about how the call ended. */
function notes(summary: CallSummary, status: CallStatus): string[] {
  const { outcome } = summary
  const lines: string[] = []
  if (status === 'runner-failure') {
    lines.push(`the sandbox failed: ${outcome.runnerFailure}. The command may or may not have completed. Sandbox calls are refused until the host proves the sandbox healthy again; there is no fallback shell.`)
  }
  if (status === 'timeout') {
    lines.push(`killed after the ${summary.deadlineS} s deadline; the output below is what was captured. Pass timeout_s (at most ${summary.maxDeadlineS}) for longer work, or split it into steps.`)
  }
  if (status === 'aborted') lines.push(outcome.notStarted ? 'the call was cancelled before the command started' : 'the call was cancelled and the command was killed')
  if (status === 'disk-floor') lines.push(`killed because free disk space on the working directory's filesystem fell below the floor (${summary.floorBytes} bytes)`)
  if (status === 'signaled') lines.push(`the command was ended by ${outcome.signal}; if that is SIGKILL, the sandbox memory limit may have been reached`)
  if (status !== 'runner-failure' && looksLikeRunnerFailure(outcome)) {
    lines.push('stderr carries a sandbox launcher diagnostic (bwrap or systemd-run): the command may not have run. If it did run and printed that line itself, ignore this note.')
  }
  if (outcome.stdout.truncated || outcome.stderr.truncated) {
    lines.push(`output beyond the last ${TAIL_BYTES / 1024} KiB of ${[outcome.stdout.truncated ? 'stdout' : '', outcome.stderr.truncated ? 'stderr' : ''].filter(Boolean).join(' and ')} was discarded while the command ran; redirect long output into a file under the working directory and read or grep that`)
  }
  const stderr = outcome.stderr.text.toLowerCase()
  for (const { needles, hint } of DENIAL_HINTS) {
    if (needles.some(needle => stderr.includes(needle))) lines.push(`hint (not a verdict): ${hint}`)
  }
  if (summary.lowDiskAfter) lines.push(`free disk space on the working directory's filesystem is below the floor (${summary.floorBytes} bytes); further commands are refused until space is freed`)
  return lines
}

/**
 * Build the two-block result of a finished run.
 * @param context - the seat closure (for the scrubber).
 * @param summary - the run and the limits that applied.
 * @returns the result; `isError` is set for a timeout, kill, cancellation, sandbox failure or bwrap diagnostic, not for a non-zero exit.
 */
export function buildRunResult(context: SeatToolContext, summary: CallSummary): SeatToolResult {
  const { outcome } = summary
  const status = statusOf(outcome)
  const shown = fit(outcome.stdout.text, outcome.stderr.text, MAX_OUTPUT_CHARS - OUTPUT_OVERHEAD)
  const head = [
    `${STATUS_MARKER}] status=${status} exit_code=${outcome.exitCode ?? 'none'} signal=${outcome.signal ?? 'none'} duration_ms=${outcome.durationMs}`,
    ...notes(summary, status).map(line => `${STATUS_MARKER}] note: ${oneLine(line)}`),
    ...shown.stdout.dropped + shown.stderr.dropped > 0 ? [`${STATUS_MARKER}] note: the output block below is clipped to fit the result size`] : [],
  ].join('\n')
  const sections = [
    ...shown.stdout.text === '' ? [] : [`${STATUS_MARKER} stdout]\n${shown.stdout.text}`],
    ...shown.stderr.text === '' ? [] : [`${STATUS_MARKER} stderr]\n${shown.stderr.text}`],
  ]
  const body = sections.length === 0 ? `${STATUS_MARKER}] no output` : sections.join('\n')
  const isError = status === 'timeout' || status === 'aborted' || status === 'disk-floor' || status === 'runner-failure' || looksLikeRunnerFailure(outcome)
  const first = textResult(context, head, false, SCRUB)
  const second = textResult(context, body, false, SCRUB)
  return { content: [...first.content, ...second.content], ...isError ? { isError: true } : {} }
}

/**
 * Build the one-block result of a call that never ran.
 * @param context - the seat closure.
 * @param reason - why it was refused, in one sentence.
 * @param remedy - what can be done about it, when there is something.
 * @param code - a short machine-readable code.
 * @returns an error result.
 */
export function buildRefusal(context: SeatToolContext, code: string, reason: string, remedy?: string): SeatToolResult {
  const lines = [
    `${STATUS_MARKER}] status=refused code=${oneLine(code)} the command did not run`,
    `${STATUS_MARKER}] note: ${oneLine(reason)}`,
    ...remedy === undefined ? [] : [`${STATUS_MARKER}] note: ${oneLine(remedy)}`],
  ]
  return textResult(context, lines.join('\n'), true, SCRUB)
}
