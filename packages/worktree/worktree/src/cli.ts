#!/usr/bin/env node
/**
 * The `dsh-worktree` CLI: bash-invocable access to the worktree seam for
 * seats and operators driving worktrees from a shell, with no harness and no
 * MCP dependency. One invocation constructs a `WorktreeService` plus the
 * local git provider, runs exactly one operation, prints the result as JSON
 * on stdout, and exits 0 — there is no resident process behind the command.
 *
 * Statelessness is carried by the registry mirror: every invocation persists
 * (`persist: true`), so the slug an earlier invocation minted stays
 * addressable by the next one. Refusals print `<code>: <message>` on stderr
 * and exit 1; the message is the seam's own reason, never paraphrased.
 *
 * Built as its own bundle and declared in `package.json` `bin`; runs under
 * plain Node with no host up (precedent: `dsh-mailbox`).
 *
 * @module @deepseek-ai/dsh-worktree/cli
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { WorktreeError } from './errors.ts'
import { WorktreeService } from './index.ts'
import { LocalGitWorktreeProvider } from './local-git.ts'
import { parseWorktreeSlug } from './slug.ts'
import type { WorktreeSlug } from './types.ts'

/** Help text printed for `--help`/`-h`; ends with exactly one newline. */
export const USAGE = `dsh-worktree — seat-scoped git worktrees over @deepseek-ai/dsh-worktree

usage:
  dsh-worktree spawn  --seat <name> --intent <text> [--main-ref <ref>]
  dsh-worktree list
  dsh-worktree lock   --slug <slug> --reason <text>
  dsh-worktree unlock --slug <slug> --reason <text>
  dsh-worktree remove --slug <slug> --reason <text>

flags (all commands):
  --repo-root <dir>       main checkout the seam branches from (default: the current directory)
  --worktrees-root <dir>  directory worktrees are created under (default: <basename(repoRoot)>.worktrees sibling)
  -h, --help              print this help

Each invocation is stateless: it runs one operation, prints the result as
JSON on stdout, and exits 0. Registry rows are mirrored to
<worktreesRoot>/registry.json so a later invocation addresses the slugs an
earlier one minted. Refusals print \`<code>: <message>\` on stderr and exit 1;
spawn requires DEEPSEEK_API_KEY in the environment (the seam's env gate).
`

/** Process-facing effects of one invocation: the two output streams the runner writes to. */
interface WorktreeCliIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** Output sinks the runner writes to; tests substitute captures. */
export const internals: WorktreeCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Parsed arguments of one invocation. */
export type WorktreeCliArgs =
  | { readonly kind: 'help' }
  | {
    readonly kind: 'spawn'
    readonly seat: string
    readonly intent: string
    readonly mainRef?: string
    readonly repoRoot?: string
    readonly worktreesRoot?: string
  }
  | { readonly kind: 'list'; readonly repoRoot?: string; readonly worktreesRoot?: string }
  | {
    readonly kind: 'lock' | 'unlock' | 'remove'
    readonly slug: WorktreeSlug
    readonly reason: string
    readonly repoRoot?: string
    readonly worktreesRoot?: string
  }

/** Flags that take a value; every other `--` token is refused as unknown. */
const VALUE_FLAGS = new Set(['--seat', '--intent', '--main-ref', '--repo-root', '--worktrees-root', '--slug', '--reason'])

/**
 * Parse one invocation's argv (no script path). A `--help`/`-h` token anywhere
 * selects help; every other token must be a known flag with a value. The slug
 * validates against the slug grammar here, so a malformed slug refuses at the
 * parser instead of surfacing as an unrelated missing-row refusal.
 * @param argv - raw argv entries after the script path.
 * @returns the parsed arguments.
 * @throws naming the offending flag when the usage is malformed.
 */
export function parseWorktreeCliArgs(argv: readonly string[]): WorktreeCliArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' }
  const [command, ...rest] = argv
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) break
    if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown argument: ${arg}`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    values.set(arg, value)
    i += 1
  }
  const scope = (): { repoRoot?: string; worktreesRoot?: string } => ({
    ...spreadOpt(values, '--repo-root'),
    ...spreadOpt(values, '--worktrees-root'),
  })
  switch (command) {
    case 'spawn': {
      const seat = requireFlag(values, '--seat')
      const intent = requireFlag(values, '--intent')
      return { kind: 'spawn', seat, intent, ...spreadOpt(values, '--main-ref'), ...scope() }
    }
    case 'list':
      return { kind: 'list', ...scope() }
    case 'lock':
    case 'unlock':
    case 'remove':
      return { kind: command, slug: parseWorktreeSlug(requireFlag(values, '--slug')), reason: requireFlag(values, '--reason'), ...scope() }
    default:
      throw new Error(
        'usage: dsh-worktree <spawn|list|lock|unlock|remove> [flags] —'
        + ' see the @deepseek-ai/dsh-worktree README',
      )
  }
}

/** Read one required flag or throw naming it. */
function requireFlag(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)
  if (value === undefined) throw new Error(`missing required flag ${flag}`)
  return value
}

/** Build the conditional single-field object for one optional string flag. */
function spreadOpt(values: Map<string, string>, flag: string): Record<string, string> {
  const value = values.get(flag)
  return value !== undefined ? { [flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]: value } : {}
}

/**
 * Execute one parsed invocation against a freshly constructed service: the
 * same `Config` resolution the plugin mount runs, the local git provider
 * registered against the resolved repo root, one seam operation, the JSON
 * result on stdout. The provider registration and the service teardown
 * effects unwind before the exit code is returned.
 * @param argv - raw argv entries after the script path.
 * @returns the process exit code (0 on success, 1 on any refusal).
 */
export async function runWorktreeCli(argv: readonly string[]): Promise<number> {
  try {
    const args = parseWorktreeCliArgs(argv)
    if (args.kind === 'help') {
      internals.stdout.write(USAGE)
      return 0
    }
    const ctx = new Context()
    const service = new WorktreeService(ctx, {
      repoRoot: args.repoRoot ?? process.cwd(),
      ...(args.worktreesRoot !== undefined ? { worktreesRoot: args.worktreesRoot } : {}),
      persist: true,
    })
    const unregister = service.registerProvider(new LocalGitWorktreeProvider({ repoRoot: service.repoRoot }))
    try {
      switch (args.kind) {
        case 'spawn': {
          const result = await service.spawn({
            seat: args.seat,
            intent: args.intent,
            ...(args.mainRef !== undefined ? { mainRef: args.mainRef } : {}),
          })
          internals.stdout.write(`${JSON.stringify(result)}\n`)
          return 0
        }
        case 'list':
          internals.stdout.write(`${JSON.stringify(service.list())}\n`)
          return 0
        case 'lock': {
          const row = await service.lock(args.slug, args.reason)
          internals.stdout.write(`${JSON.stringify(row)}\n`)
          return 0
        }
        case 'unlock': {
          const row = await service.unlock(args.slug, args.reason)
          internals.stdout.write(`${JSON.stringify(row)}\n`)
          return 0
        }
        case 'remove': {
          await service.remove(args.slug, args.reason)
          internals.stdout.write(`${JSON.stringify({ removed: args.slug })}\n`)
          return 0
        }
        default: {
          // The subcommand union is closed; the never assignment proves the
          // default dead and keeps a future member from compiling silently.
          const unreachable: never = args
          throw new Error(`internal error: unhandled command ${JSON.stringify(unreachable)}`)
        }
      }
    } finally {
      unregister()
      await ctx.fiber.dispose()
    }
  } catch (error: unknown) {
    internals.stderr.write(error instanceof WorktreeError
      ? `${error.code}: ${error.message}\n`
      : `${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Whether one argv script path names THIS module, compared after resolving
 * both sides through the filesystem. `import.meta.url` is always fully
 * resolved, while `process.argv[1]` can carry a symlinked path — a bin shim,
 * a PATH entry into a linked install, or any indirection an operator's shell
 * puts in the way — and an unresolved comparison never matches, so the guard
 * would be false and the CLI would exit 0 having run nothing. A resolution
 * failure (the invoked path does not exist, or cannot be read) answers
 * `false`: a missing file cannot be this module's entry.
 * @param invokedPath - the `process.argv[1]` script path, unresolved.
 * @param entryUrl - this module's `import.meta.url`.
 * @returns whether the invoked path and this module are the same file.
 */
export function isEntryInvocation(invokedPath: string, entryUrl: string): boolean {
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(entryUrl))
  } catch {
    // ENOENT or an unreadable path: the invocation cannot be this module's
    // entry, and there is no fallback comparison that could still match.
    return false
  }
}

// Bin execution guard: run only when this file is the entry module, so an
// in-process import (tests) never starts a git operation. runWorktreeCli
// catches every failure into an exit code, so the promise cannot reject
// except through the output streams themselves.
/* v8 ignore start -- bin-entry glue: the guard comparison runs only when this
   module IS the entry, which coverage never measures in-process; the
   subprocess test drives the real bin end to end and isEntryInvocation's
   resolution paths are covered directly. */
const invoked = process.argv[1] !== undefined
  && isEntryInvocation(process.argv[1], import.meta.url)
if (invoked) {
  void runWorktreeCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
/* v8 ignore stop */
