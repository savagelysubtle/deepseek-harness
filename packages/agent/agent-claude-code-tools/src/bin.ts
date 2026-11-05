/**
 * Entry of the seat-guard PreToolUse hook. Thin: read bounded stdin, run the guard, exit 2 with a
 * reason on stderr or exit 0 silently. This file prints no decision of any kind. The package build
 * bundles it with the guard modules into a single plain-JavaScript `lib/seat-guard.js`.
 */

import { MAX_STDIN_BYTES, runGuard } from './guard-core.ts'
import { readStdinCapped } from './stdin.ts'

const outcome = runGuard({ argv: process.argv.slice(2), stdin: readStdinCapped(0, MAX_STDIN_BYTES) })
if (outcome.code === 2) process.stderr.write(`${outcome.reason}\n`)
process.exit(outcome.code)
