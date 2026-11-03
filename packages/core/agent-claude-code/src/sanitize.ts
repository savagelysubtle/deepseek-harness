/** Redaction and bounding for free-text fields the driver records. @module @deepseek-ai/dsh-agent-claude-code/sanitize */

import { CLAUDE_CODE_MAX_TEXT_CHARS } from './constants.ts'

/** Placeholder written where a credential-shaped substring was removed. */
export const REDACTED_TOKEN = '[redacted]'

/** Placeholder written where a file path was removed. */
export const REDACTED_PATH = '[path]'

/** Input is pre-capped so the redaction regexes never scan unbounded text. */
const REGEX_INPUT_CAP = 4096

// Order matters: PEM blocks and specific vendor prefixes first, then key=value shapes. All case-insensitive.
const TOKEN_PATTERNS: readonly RegExp[] = [
  // A private-key block, or an unterminated one cut off at the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gi,
  /sk-ant-[\w-]+/gi,
  /\bsk-[\w-]{16,}/gi,
  // Stripe secret, restricted and publishable keys, and webhook signing secrets (underscore variants).
  /\b(?:sk|rk|pk)_(?:live|test)_[a-z0-9]{8,}/gi,
  /\bwhsec_[a-z0-9]{8,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9]{16,}/gi,
  /\bgithub_pat_\w{16,}/gi,
  /\bglpat-[\w-]{16,}/gi,
  /\bnpm_[a-z0-9]{20,}/gi,
  /\bxox[abprs]-[\w-]{8,}/gi,
  // AWS access key ids: long-lived (AKIA) and temporary (ASIA).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gi,
  // Google API keys and OAuth access tokens.
  /\bAIza[\w-]{30,}/gi,
  /\bya29\.[\w.-]{20,}/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/gi,
  /\b(?:Bearer|Basic)\s+[\w.~+/=-]{8,}/gi,
]

// Twilio API key and account SIDs: upper-case SK or AC followed by 32 hex characters. Case-SENSITIVE on purpose: a
// lower-case 34-character hex word is an ordinary identifier, and redacting it would break ids that must stay intact.
const TWILIO_SID = /\b(?:SK|AC)[0-9a-f]{32}\b/g

// key=value / key: value / quoted JSON "key":"value" for credential-named keys. The pattern starts at the keyword (so
// a long run of word characters is not rescanned from every position); the redaction then reaches left over the rest
// of the key name and an opening quote.
const KEY_VALUE_PATTERN = /(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|auth)["']?\s*[:=]\s*["']?[^\s"',;]{4,}["']?/gi

const KEY_NAME_CHAR = /[\w-]/

/** Replace every credential-named key=value, including the whole key name and its opening quote. */
function redactKeyValues(text: string): string {
  let out = ''
  let kept = 0
  for (const match of text.matchAll(KEY_VALUE_PATTERN)) {
    let start = match.index
    while (start > kept && KEY_NAME_CHAR.test(text.charAt(start - 1))) start -= 1
    const quote = text.charAt(start - 1)
    if (start > kept && (quote === '"' || quote === "'")) start -= 1
    out += text.slice(kept, start) + REDACTED_TOKEN
    kept = match.index + match[0].length
  }
  return out + text.slice(kept)
}

/** A long token-like run; applied to free text only, never to identifiers. */
const LONG_RUN_PATTERN = /\b[\w-]{40,}\b/g

/**
 * A path needs a leading `/` or `~` that is not glued to a preceding word,
 * dot, colon, or slash, and at least two segments. This leaves dates
 * (`2026/11/02`), relative fragments (`a/b/c`), and URL tails alone.
 */
const PATH_PATTERN = /(?<![\w.~/:-])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g

// Control characters (C0, DEL, C1) and Unicode line/paragraph separators.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g

/**
 * Replace credential-shaped substrings with a placeholder.
 * @param text - text to scan.
 * @returns the text with token-shaped substrings replaced by `[redacted]`.
 */
export function redactTokens(text: string): string {
  let out = text
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED_TOKEN)
  return redactKeyValues(out.replace(TWILIO_SID, REDACTED_TOKEN))
}

/**
 * Replace any 40-plus-character token-like run with a placeholder. Free text
 * only: identifiers such as cwd-salted session ids are legitimately that long.
 * @param text - text to scan.
 * @returns the text with long runs replaced by `[redacted]`.
 */
export function redactLongRuns(text: string): string {
  return text.replace(LONG_RUN_PATTERN, REDACTED_TOKEN)
}

/**
 * Replace absolute, home-relative, and relative multi-segment paths with a placeholder.
 * @param text - text to scan.
 * @returns the text with path-shaped substrings replaced by `[path]`.
 */
export function redactPaths(text: string): string {
  return text.replace(PATH_PATTERN, REDACTED_PATH)
}

/**
 * Replace control characters with single spaces and trim.
 * @param text - text to clean.
 * @returns the cleaned text.
 */
export function stripControl(text: string): string {
  return text.replace(CONTROL_PATTERN, ' ').trim()
}

/**
 * Sanitize an identifier-like string (session id, SDK session id, model):
 * control-strip, vendor-token-redact, cap. Long runs and paths are kept
 * because identifiers are legitimately long (cwd-salted ids) and may contain
 * slashes.
 * @param value - candidate string; non-strings become the empty string.
 * @param max - character cap (default 500).
 * @returns the bounded, redacted string.
 */
export function sanitizeLabel(value: unknown, max: number = CLAUDE_CODE_MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') return ''
  return redactTokens(stripControl(value.slice(0, REGEX_INPUT_CAP))).slice(0, max)
}

/**
 * Sanitize free text (steering reason, outcome, stop reason): control-strip,
 * token-redact, long-run-redact, path-redact, cap.
 * @param value - candidate string; non-strings become the empty string.
 * @param max - character cap (default 500).
 * @returns the bounded, redacted string.
 */
export function sanitizeFreeText(value: unknown, max: number = CLAUDE_CODE_MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') return ''
  return redactPaths(redactLongRuns(redactTokens(stripControl(value.slice(0, REGEX_INPUT_CAP))))).slice(0, max)
}
