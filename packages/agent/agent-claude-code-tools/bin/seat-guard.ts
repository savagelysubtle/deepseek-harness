/**
 * Entry of the seat-guard PreToolUse hook. Thin: read stdin, run the guard, exit 2 with a reason on
 * stderr or exit 0 silently. This file prints no decision of any kind.
 */

import { readFileSync } from 'node:fs'
import { runGuard } from '../src/guard-core.ts'

let stdin = ''
try {
  stdin = readFileSync(0, 'utf8')
} catch {
  // an unreadable stdin parses as invalid JSON and is denied
}
const outcome = runGuard({ argv: process.argv.slice(2), stdin })
if (outcome.code === 2) process.stderr.write(`${outcome.reason}\n`)
process.exit(outcome.code)
