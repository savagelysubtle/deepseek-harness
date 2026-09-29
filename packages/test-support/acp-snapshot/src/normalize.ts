/**
 * Pure ACP transcript and session-log normalizers. They scrub session ids, run cwd, RPC ids,
 * timestamps, and hook duration while preserving deterministic event sequence numbers.
 * Request-header scrubbers stay composable so one scenario per header class can pin prompt and
 * tool-schema sidecars.
 * @module @deepseek-ai/dsh-acp-snapshot/normalize
 */

const SESSION_ID = '{{sessionId}}'
const CWD = '{{cwd}}'
const SYSTEM = '{{system}}'
const TOOLS = '{{tools}}'
const EVENT_TIME = '{{eventTime}}'
const EVENT_OMITTED_BYTES = '{{eventOmittedBytes}}'
const LOG_TIME = '{{logTime}}'

/** A cwd-rooted path after volatile cwd replacement, through its last separator-delimited segment. */
const CWD_ROOTED_PATH_RE = /\{\{cwd\}\}(?:[\\/][^\s<>"'`]+)+/g
const PATH_TAG_RE = /(<path>)([^<]*)(<\/path>)/g
const ADDITIONAL_INSTRUCTIONS_PATH_RE = /(Additional instructions from: )([^\r\n]+)/g
const EMBEDDED_EVENT_TIME_RE = /^(  "time": )\d+(?=,\r?$)/gm
const EVENT_READ_OMITTED_BYTES_RE = /(\r?\n\r?\n\(Omitted )\d+( bytes\.)/g
const EVENT_READ_TARGET_REGION_RE
  = /^Session [^\r\n]+ — [^\r\n]+\r?\nTarget event seq \d+:\r?\n```json\r?\n\{\r?\n[\s\S]*?(?=\r?\n```(?:\r?\n|$)|\r?\n\r?\n\(Omitted )/
const PATH_TEXT_BOUNDARY_RE = /[\s<>'"`()\[\]{},;:!?=]/
const FILE_URI_PATH_PREFIX_RE = /(?:^|[^a-z0-9+.-])file:\/\/\/?$/i

/** A UUID v4 string, the shape `randomUUID()` produces for session ids. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/**
 * The timestamp prefix the Node `logger-console` exporter's `render()` writes ahead of every
 * accepted message (SWD-151: `logger-console/src/shared.ts`'s default `showTime` template,
 * `yyyy-MM-dd hh:mm:ss `, followed by the `[E|I|W|D]` severity bracket) — matched by a lookahead so
 * only the timestamp itself is consumed and replaced, leaving the bracket, logger name, and message
 * text in place for {@link normalizeConsoleExporterStderr}.
 */
const CONSOLE_EXPORTER_LOG_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?=\[[EIWD]\] )/gm
/**
 * A console-exporter line already normalized by {@link CONSOLE_EXPORTER_LOG_TIME_RE}, capturing the
 * logger name so {@link normalizeConsoleExporterStderr} can canonicalize boot-log order (see there
 * for why order needs canonicalizing at all).
 */
const NORMALIZED_CONSOLE_EXPORTER_LINE_RE = /^\{\{logTime\}\} \[[EIWD]\] (\S+) /
const LOCAL_SPILL_PATH_RE = new RegExp(
  String.raw`\{\{cwd\}\}[\\/]\.spill[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)
const SNAPSHOT_SPILL_PATH_RE = new RegExp(
  String.raw`(?:[A-Za-z]:)?[\\/](?:tmp|t)[\\/](?:dsh-acp-snap-[0-9a-f]{9}|dsh-acp-snapshot-spill)[\\/]session-[0-9a-f]{12}[\\/][0-9a-f]{12}-([A-Za-z0-9._~-]+?)`
  + String.raw`(?=\. Use read with offset/limit|[\s)]|$)`,
  'g',
)

/**
 * Extract every snapshot-mode spill path from a session log, keyed by spill
 * filename. Used by refresh write-back to keep spill paths stable across runs.
 * @param content - the raw session log text to scan.
 * @returns spill filename → the full matched spill path, last match wins per name.
 */
export function extractSnapshotSpillPaths(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const match of content.matchAll(SNAPSHOT_SPILL_PATH_RE)) {
    const name = match[1]
    /* v8 ignore next -- the filename capture is required and non-empty whenever the spill regex matches */
    if (name === undefined) continue
    result.set(name, match[0])
  }
  return result
}

/** Convert separators only inside generated path-bearing text markers. */
function canonicalizeEmbeddedPaths(value: string): string {
  return value
    .replace(PATH_TAG_RE, (_match, open: string, path: string, close: string) =>
      `${open}${path.replaceAll('\\', '/')}${close}`)
    .replace(ADDITIONAL_INSTRUCTIONS_PATH_RE, (_match, prefix: string, path: string) =>
      `${prefix}${path.replaceAll('\\', '/')}`)
}

/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
  /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
  sessionIds: string[]
  /** The generated cwd the run used — replaced with `{{cwd}}`. */
  cwd: string
  /** Other filesystem spellings of the same cwd (for example Windows short and long paths). */
  cwdAliases?: readonly string[]
}

/** How cwd-rooted path separators are represented after the cwd is tokenized. */
export type CwdPathMode = 'canonical' | 'native'

/** Optional controls shared by stdout and session-log normalization. */
export interface NormalizeOptions {
  /** Use `/` for shared goldens, or preserve captured separators for a platform-specific golden. */
  cwdPathMode?: CwdPathMode
}

/** Return every known spelling of the generated cwd, most specific first. */
function cwdSpellings(ctx: NormalizeContext): string[] {
  const spellings = [...new Set([ctx.cwd, ...ctx.cwdAliases ?? []])]
    .filter(spelling => spelling.length > 0)
  const macAliases = spellings
    .filter(spelling => spelling.startsWith('/') && !spelling.startsWith('/private/'))
    .map(spelling => `/private${spelling}`)
  return [...new Set([...spellings, ...macAliases])]
    .sort((left, right) => right.length - left.length)
}

/** Whether an embedded cwd match starts and ends at a path/text boundary. */
function isCwdMatch(value: string, start: number, length: number): boolean {
  const before = value[start - 1]
  const after = value[start + length]
  const afterPunctuation = value[start + length + 1]
  const startsAtBoundary = before === undefined
    || PATH_TEXT_BOUNDARY_RE.test(before)
    || FILE_URI_PATH_PREFIX_RE.test(value.slice(0, start))
  const endsAtBoundary = after === undefined
    || after === '/'
    || after === '\\'
    || PATH_TEXT_BOUNDARY_RE.test(after)
    || after === '.' && (afterPunctuation === undefined || PATH_TEXT_BOUNDARY_RE.test(afterPunctuation))
  return startsAtBoundary && endsAtBoundary
}

/** Replace one cwd spelling without matching a longer path segment that merely shares its prefix. */
function replaceCwdSpelling(value: string, spelling: string, replacement: string): string {
  let cursor = 0
  let out = ''
  while (cursor < value.length) {
    const match = value.indexOf(spelling, cursor)
    if (match < 0) return out + value.slice(cursor)
    const end = match + spelling.length
    if (isCwdMatch(value, match, spelling.length)) {
      out += value.slice(cursor, match) + replacement
      cursor = end
    } else {
      out += value.slice(cursor, end)
      cursor = end
    }
  }
  return out
}

/** Replace every known cwd spelling with one stable token. */
function replaceCwd(value: string, ctx: NormalizeContext, replacement: string): string {
  let out = value
  for (const spelling of cwdSpellings(ctx)) out = replaceCwdSpelling(out, spelling, replacement)
  return out
}

/** Replace cwd, session ids, and any stray UUID with stable tokens in a string. */
function scrubString(value: string, ctx: NormalizeContext, cwdPathMode: CwdPathMode): string {
  let out = replaceCwd(value, ctx, CWD)
  // Filesystem APIs can report one directory with several spellings. Replace
  // every known spelling longest-first so a shorter alias cannot corrupt a
  // longer one before it is tokenized. macOS additionally symlinks
  // /tmp → /private/tmp and /var → /private/var: the session header cwd may
  // omit the /private prefix while fs tools resolve symlinks, so cover the
  // prefixed form of every spelling too, then collapse a residual prefixed
  // token.
  out = out.split(`/private${CWD}`).join(CWD)
  if (cwdPathMode === 'canonical') {
    // Restrict separator conversion to paths rooted at the cwd token. A global
    // backslash rewrite would corrupt regexes, commands, and model-authored text.
    out = out.replace(CWD_ROOTED_PATH_RE, path => path.replaceAll('\\', '/'))
    out = canonicalizeEmbeddedPaths(out)
  }
  out = out.replace(LOCAL_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  out = out.replace(SNAPSHOT_SPILL_PATH_RE, (_match, name: string) => `{{spillLocator:${name}}}`)
  // Exact event-read results render the target as pretty JSON inside a
  // distinctive envelope. Restrict time scrubbing to that fenced target so
  // neighbor, model, bash, and unrelated tool text remains regression-visible.
  if (EVENT_READ_TARGET_REGION_RE.test(out)) {
    out = out.replace(
      EVENT_READ_TARGET_REGION_RE,
      target => target.replace(EMBEDDED_EVENT_TIME_RE, `$1${EVENT_TIME}`),
    )
    out = out.replace(EVENT_READ_OMITTED_BYTES_RE, `$1${EVENT_OMITTED_BYTES}$2`)
  }
  for (const id of ctx.sessionIds) out = out.split(id).join(SESSION_ID)
  out = out.replace(UUID_RE, SESSION_ID)
  return out
}

/** Recursively scrub a parsed JSON value (strings replaced; structure kept). */
function scrubValue(value: unknown, ctx: NormalizeContext, cwdPathMode: CwdPathMode, key?: string): unknown {
  if (typeof value === 'string') {
    const scrubbed = scrubString(value, ctx, cwdPathMode)
    return cwdPathMode === 'canonical' && key === 'path' ? scrubbed.replaceAll('\\', '/') : scrubbed
  }
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, cwdPathMode))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx, cwdPathMode, k)
    return out
  }
  return value
}

/** Escape one literal path segment for use in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace any absolute spelling whose final segment is the generated cwd basename. */
function tokenizeFixtureString(value: string, ctx: NormalizeContext, basename: string): string {
  const exact = replaceCwd(value, ctx, CWD)
  const absoluteCwd = new RegExp(
    String.raw`(?:[A-Za-z]:)?[\\/](?:[^\\/\s<>"]+[\\/])*${escapeRegExp(basename)}`
    + String.raw`(?=$|[\\/\s<>'"()\[\]{},;:!?=])`,
    'g',
  )
  return exact.replace(absoluteCwd, CWD).split(`/private${CWD}`).join(CWD)
}

/** Recursively replace generated-cwd spellings while preserving every other JSON value. */
function tokenizeFixtureValue(
  value: unknown,
  ctx: NormalizeContext,
  basename: string,
): unknown {
  if (typeof value === 'string') return tokenizeFixtureString(value, ctx, basename)
  if (Array.isArray(value)) return value.map(item => tokenizeFixtureValue(item, ctx, basename))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      tokenizeFixtureValue(item, ctx, basename),
    ]))
  }
  return value
}

/**
 * Store one generated workspace as `{{cwd}}` while retaining every other
 * session value. The caller opts in only for workspaces created under a
 * platform temporary root; explicitly relocated workspaces keep their real
 * path.
 *
 * @param rawLog The raw or refresh-stabilized session JSONL fixture.
 * @returns Compact JSONL whose known cwd spellings become `{{cwd}}`.
 * @throws If a non-empty line is invalid JSON or the session cwd has no basename.
 */
export function tokenizeSessionFixtureCwd(rawLog: string): string {
  const lines = rawLog.split('\n')
  const firstLine = lines.find(line => line.trim().length > 0)
  const header = firstLine === undefined ? undefined : JSON.parse(firstLine) as { cwd?: unknown }
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const basename = cwd.split(/[\\/]/).at(-1)
  if (basename === undefined || basename.length === 0) {
    throw new Error('acp-snapshot: cannot tokenize a cwd without a basename')
  }
  const ctx: NormalizeContext = { sessionIds: [], cwd }
  return lines.map((line) => {
    if (line.trim().length === 0) return line
    return JSON.stringify(tokenizeFixtureValue(JSON.parse(line), ctx, basename))
  }).join('\n')
}

/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a stable expected output
 * in the same shape as the wire: one compact JSON frame per line (NDJSON), with the JSON-RPC
 * `id` rewritten to a per-transcript sequence (1, 2, 3, …) and all volatile strings scrubbed.
 * Invalid JSON throws, doubling as a protocol-stdout purity check.
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export function normalizeStdout(
  rawStdout: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const lines = rawStdout.split('\n').filter(line => line.trim().length > 0)
  // Map each distinct JSON-RPC id (request/response correlate by id) to a stable
  // sequence number, in first-seen order, so id churn doesn't perturb the expected output.
  const idSeq = new Map<string, number>()
  const stableId = (id: unknown): number => {
    const key = JSON.stringify(id)
    let n = idSeq.get(key)
    if (n === undefined) { n = idSeq.size + 1; idSeq.set(key, n) }
    return n
  }
  const frames = lines.map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>
    if ('id' in frame && frame.id !== undefined && frame.id !== null) {
      frame.id = stableId(frame.id)
    }
    return scrubValue(frame, ctx, cwdPathMode) as Record<string, unknown>
  })
  return frames.map(f => JSON.stringify(f)).join('\n') + '\n'
}

/**
 * Normalize a session JSONL log into a stable expected output: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) and every event's `time` are
 * zeroed/scrubbed, all volatile strings scrubbed, and `seq` is LEFT INTACT
 * (deterministic by contract). A packed chunk row's timing (`time0`, the `dt`
 * gaps) zeroes just like an event `time`; its `seq0` stays, like `seq`.
 * Output is JSONL in the same shape as the input — one compact record per
 * line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized JSONL log, one record per line.
 */
export function normalizeSessionLog(
  rawLog: string,
  ctx: NormalizeContext,
  options: NormalizeOptions = {},
): string {
  const cwdPathMode = options.cwdPathMode ?? 'canonical'
  const lines = rawLog.split('\n').filter(line => line.trim().length > 0)
  const records = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    // Header line: { type: 'session', createdAt, id, cwd, … }.
    if (record.type === 'session') {
      if ('createdAt' in record) record.createdAt = 0
    } else if ('time0' in record) {
      // Packed chunk row: zero the anchor timestamp and every member gap.
      record.time0 = 0
      const data = record.data
      if (data !== null && typeof data === 'object' && Array.isArray((data as { dt?: unknown }).dt)) {
        (data as { dt: unknown[] }).dt = (data as { dt: unknown[] }).dt.map(() => 0)
      }
    } else if ('time' in record) {
      // Event line: zero the epoch-ms timestamp; keep seq (deterministic).
      record.time = 0
      // A hook/result carries the hook's wall-clock runtime (`data.durationMs`),
      // which is run-to-run noise like `time` — zero it so the expected output reflects
      // the hook's decision/exit, not how long the shell took.
      if (record.type === 'hook/result' && record.data !== null && typeof record.data === 'object') {
        const data = record.data as Record<string, unknown>
        if ('durationMs' in data) data.durationMs = 0
      }
    }
    return scrubValue(record, ctx, cwdPathMode) as Record<string, unknown>
  })
  return records.map(r => JSON.stringify(r)).join('\n') + '\n'
}

/**
 * Replace system-prompt content in request headers with `{{system}}` tokens
 * while retaining field presence.
 * Other header content stays verbatim, so a header-pinning fixture can keep
 * its complete tool schemas while every JSONL fixture omits the prompt text.
 * Lines without a system payload pass through byte-for-byte; the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with system-prompt content tokenized.
 */
export function scrubSystemPrompts(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true })
}

/**
 * Replace tool schemas in full request-header snapshots with `{{tools}}`
 * tokens while retaining field presence. System prompts and session-prefix
 * messages stay verbatim so pinning fixtures can move only schema bulk into
 * their dedicated JSON sidecar. Lines without a tool payload pass through
 * byte-for-byte; the transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with tool-schema content tokenized.
 */
export function scrubToolSchemas(rawLog: string): string {
  return scrubHeaderContent(rawLog, { tools: true })
}

/**
 * Replace all bulky request-header content in a session JSONL with stable
 * tokens. This includes the system-prompt fields handled by
 * {@link scrubSystemPrompts}, tool schemas, and session-prefix messages. It
 * keeps prefix message counts, field presence, config, and reason. Lines
 * without content to scrub pass through byte-for-byte, and the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with all header bulk tokenized, other lines byte-identical.
 */
export function scrubRequestHeaders(rawLog: string): string {
  return scrubHeaderContent(rawLog, { system: true, tools: true })
}

/**
 * Normalize a captured stderr stream that may carry Node `logger-console` exporter output
 * (SWD-151) for a byte-stable golden. Every accepted log level now writes its own rendered line to
 * stderr, so an assembled app's operator-facing boot logs legitimately interleave with any literal
 * stderr text a golden pins (a startup error message, for example) — those log lines carry a
 * wall-clock timestamp and can embed a random session id, neither of which is reproducible run to
 * run. This replaces just those two volatile pieces: the render() timestamp prefix becomes
 * `{{logTime}}`, and any embedded UUID (matching {@link normalizeSessionLog}'s session-id scrub)
 * becomes `{{sessionId}}`. Severity, logger name, and the rest of the message text stay verbatim, so
 * a real change to what an app logs still shows up in the golden diff. Lines outside the
 * console-exporter shape (including any literal stderr text unrelated to logging) pass through
 * unchanged except for the same UUID scrub.
 *
 * Different plugins log their own boot messages independently and concurrently, with no ordering
 * guarantee between one plugin's logger and another's (confirmed on the running host 2026-09-29: the
 * same headless-profile boot logged `tool-mailbox` before `tool-subagent` in one run and after it in
 * the next). A byte-stable golden cannot pin an order that is not actually guaranteed, so every
 * now-normalized console-exporter line is stable-sorted by its logger name — this canonicalizes
 * cross-plugin order while leaving same-plugin lines in their original relative order (stable sort),
 * since consecutive lines from the same synchronous logger call ARE ordered.
 *
 * The sort is scoped to each CONTIGUOUS run of console-exporter lines independently — it resets at
 * every non-matching line (a literal stderr line, or a blank line) — rather than pooling every
 * matching line across the whole text. Only lines racing against each other at the same boot moment
 * lack an ordering guarantee; a `[W]`/`[E]` line logged right before an unrelated later fatal line
 * has no such race with it and must never be sorted away from it into an earlier, unrelated cluster.
 * Non-log lines always keep their original position.
 *
 * @param stderr - captured process stderr text.
 * @returns stderr with every console-exporter line's timestamp and embedded UUID replaced by
 * stable tokens, and each contiguous run of boot-log lines canonicalized by logger name.
 */
export function normalizeConsoleExporterStderr(stderr: string): string {
  const withTokens = stderr
    .replace(CONSOLE_EXPORTER_LOG_TIME_RE, `${LOG_TIME} `)
    .replace(UUID_RE, SESSION_ID)
  const lines = withTokens.split('\n')
  const result = [...lines]
  let runStart: number | undefined
  let run: { line: string; key: string; originalIndex: number }[] = []
  const flushRun = (): void => {
    if (runStart === undefined) return
    const start = runStart
    const sorted = [...run].sort((left, right) =>
      left.key === right.key ? left.originalIndex - right.originalIndex : left.key < right.key ? -1 : 1)
    sorted.forEach((entry, offset) => { result[start + offset] = entry.line })
    runStart = undefined
    run = []
  }
  lines.forEach((line, index) => {
    const key = NORMALIZED_CONSOLE_EXPORTER_LINE_RE.exec(line)?.[1]
    if (key === undefined) {
      flushRun()
      return
    }
    runStart ??= index
    run.push({ line, key, originalIndex: run.length })
  })
  flushRun()
  return result.join('\n')
}

/** Which independent request-header payloads a scrubber replaces. */
interface HeaderScrubOptions {
  system?: boolean
  tools?: boolean
}

/** Transform the selected request-header payloads. */
function scrubHeaderContent(rawLog: string, options: HeaderScrubOptions): string {
  const lines = rawLog.split('\n')
  const out = lines.map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    const data = record.data as Record<string, unknown> | null | undefined
    if (data === null || typeof data !== 'object') return line
    if (record.type === 'request/header') {
      const header = data.header as Record<string, unknown> | null | undefined
      if (header === null || typeof header !== 'object') return line
      let touched = false
      if (options.system === true && 'system' in header) { header.system = SYSTEM; touched = true }
      if (options.tools === true && 'tools' in header) { header.tools = TOOLS; touched = true }
      return touched ? JSON.stringify(record) : line
    }
    return line
  })
  return out.join('\n')
}
