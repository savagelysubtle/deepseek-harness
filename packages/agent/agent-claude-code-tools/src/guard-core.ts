/**
 * The seat-guard hook's logic, separated from process I/O so it can be tested in-process. It reads
 * the PreToolUse payload, loads the policy file named on the command line and denies on anything
 * unexpected. It never prints a decision: exit code 2 with a reason on stderr is a deny, exit code 0
 * with no output is "no objection". Guard-reachable: erasable TypeScript only.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/guard-core
 */

import { decide } from './decide.ts'
import { isSeatName, isSha256 } from './grammar.ts'
import { readPolicyFile } from './policy-read.ts'

/** What the process should do. */
export interface GuardOutcome {
  /** Process exit code: 0 (no objection) or 2 (deny). */
  readonly code: 0 | 2
  /** One-line reason for a deny; empty for exit 0. */
  readonly reason: string
}

/** Replaceable pieces, for tests. */
export interface GuardDeps {
  /** The decision function. */
  readonly decide: typeof decide
}

const DEFAULT_DEPS: GuardDeps = { decide }

const MAX_REASON = 300

/** Largest hook payload the guard accepts. */
export const MAX_STDIN_BYTES = 1024 * 1024

function refuse(reason: string): GuardOutcome {
  const line = reason.replace(/[\r\n]+/g, ' ').slice(0, MAX_REASON)
  return { code: 2, reason: `seat-guard: denied: ${line}` }
}

function parseArgs(argv: readonly string[]): { policy: string; sha256: string; seat: string } | string {
  const seen = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag !== '--policy' && flag !== '--sha256' && flag !== '--seat') return `unexpected argument ${JSON.stringify(flag)}`
    if (value === undefined) return `${flag} has no value`
    if (seen.has(flag)) return `${flag} given twice`
    seen.set(flag, value)
  }
  const policy = seen.get('--policy')
  const sha256 = seen.get('--sha256')
  const seat = seen.get('--seat')
  if (policy === undefined || sha256 === undefined || seat === undefined) return 'need --policy, --sha256 and --seat'
  if (!isSeatName(seat)) return 'seat name is not valid'
  if (!isSha256(sha256)) return 'sha256 is not a lower-case hex digest'
  if (!policy.startsWith('/')) return 'policy path is not absolute'
  return { policy, sha256, seat }
}

/**
 * Run the guard once.
 * @param input - the command-line arguments after the script name and the raw stdin text.
 * @param deps - replaceable decision function (tests only).
 * @returns exit code 0 with no reason, or exit code 2 with the reason line to put on stderr.
 */
export function runGuard(
  input: { readonly argv: readonly string[]; readonly stdin: string },
  deps: GuardDeps = DEFAULT_DEPS,
): GuardOutcome {
  try {
    const args = parseArgs(input.argv)
    if (typeof args === 'string') return refuse(args)
    if (Buffer.byteLength(input.stdin) > MAX_STDIN_BYTES) return refuse(`hook input is larger than ${MAX_STDIN_BYTES} bytes`)
    const read = readPolicyFile(args.policy, args.seat, args.sha256)
    if (!read.ok) return refuse(read.reason)
    let payload: unknown
    try {
      payload = JSON.parse(input.stdin)
    } catch {
      return refuse('hook input is not valid JSON')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return refuse('hook input is not an object')
    const record = payload as Record<string, unknown>
    const verdict = deps.decide(read.policy, record['tool_name'], record['tool_input'])
    return verdict.ok ? { code: 0, reason: '' } : refuse(verdict.reason)
  } catch (error: unknown) {
    return refuse(`guard failed (${error instanceof Error ? error.name : 'error'})`)
  }
}
