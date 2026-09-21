/**
 * Enforce `wc -w`-style ceilings from `scripts/doc-budgets.manifest.json`.
 * Missing files and invalid ceilings fail; `--list` reports current usage.
 * Only listed standing docs are budgeted. Ceilings ratchet down with at least
 * 5% headroom; raising one requires the justification defined in
 * `docs/AGENTS.md`.
 *
 * A manifest value is either a positive integer (a total-word ceiling over
 * the whole file) or `{ prose, row }` (for catalog docs whose bulk is a
 * table): a table line's first non-whitespace character is `|`; a delimiter
 * line (only `|`, `-`, `:`, whitespace) counts toward neither check; `prose`
 * caps all non-table lines combined, `row` caps each remaining table line
 * individually.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const MANIFEST_PATH = resolve(root, 'scripts/doc-budgets.manifest.json')

/** `wc -w` equivalent: count whitespace-delimited tokens. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** A table line's first non-whitespace character is `|`. */
function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

/** A delimiter row is only `|`, `-`, `:`, and whitespace — no cell content. */
function isDelimiterLine(line: string): boolean {
  return /^[\s|:-]+$/.test(line)
}

/** First ~50 characters of a line, trimmed, for locating an offending row. */
function excerpt(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed
}

type RowCeiling = { prose: number; row: number }

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>

const listOnly = process.argv.includes('--list')
const failures: string[] = []
const rows: string[] = []

for (const [path, ceiling] of Object.entries(manifest)) {
  if (typeof ceiling === 'number') {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      rows.push(`BAD   ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
      failures.push(`${path}: ceiling must be a positive integer, got ${ceiling}`)
      continue
    }
    const abs = resolve(root, path)
    if (!existsSync(abs)) {
      rows.push(`MISS  ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
      failures.push(`${path}: budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)`)
      continue
    }
    const words = countWords(readFileSync(abs, 'utf8'))
    rows.push(`${words <= ceiling ? 'ok  ' : 'OVER'}  ${String(words).padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    if (words > ceiling) {
      failures.push(`${path}: ${words} words exceeds the ${ceiling}-word ceiling — relocate or condense per docs/AGENTS.md (raising the ceiling requires justification in the PR)`)
    }
    continue
  }

  if (ceiling !== null && typeof ceiling === 'object' && !Array.isArray(ceiling)) {
    const obj = ceiling as Record<string, unknown>
    const unexpectedKeys = Object.keys(obj).filter(key => key !== 'prose' && key !== 'row')
    if (unexpectedKeys.length > 0) {
      rows.push(`BAD   ${'—'.padStart(15)} ${path}`)
      failures.push(`${path}: unexpected key(s) in ceiling object: ${unexpectedKeys.join(', ')} — only "prose" and "row" are allowed`)
      continue
    }
    if (!isPositiveInt(obj.prose) || !isPositiveInt(obj.row)) {
      rows.push(`BAD   ${'—'.padStart(15)} ${path}`)
      failures.push(
        `${path}: "prose" and "row" ceilings must be positive integers, got prose=${JSON.stringify(obj.prose)} row=${JSON.stringify(obj.row)}`,
      )
      continue
    }
    const { prose, row }: RowCeiling = { prose: obj.prose, row: obj.row }

    const abs = resolve(root, path)
    if (!existsSync(abs)) {
      rows.push(`MISS  ${'—'.padStart(15)} ${path}`)
      failures.push(`${path}: budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)`)
      continue
    }

    const lines = readFileSync(abs, 'utf8').split('\n')
    const proseLines: string[] = []
    const dataRows: string[] = []
    for (const line of lines) {
      if (!isTableLine(line)) {
        proseLines.push(line)
        continue
      }
      if (isDelimiterLine(line)) continue
      dataRows.push(line)
    }

    const proseWords = countWords(proseLines.join('\n'))
    const rowCounts = dataRows.map(line => ({ line, words: countWords(line) }))
    const maxRowWords = rowCounts.length > 0 ? Math.max(...rowCounts.map(r => r.words)) : 0
    const overRows = rowCounts.filter(({ words }) => words > row)

    const proseOk = proseWords <= prose
    const rowsOk = overRows.length === 0
    const status = proseOk && rowsOk ? 'ok  ' : 'OVER'
    rows.push(
      `${status}  prose ${String(proseWords).padStart(4)}/${String(prose).padEnd(4)} ${proseOk ? 'ok  ' : 'OVER'}` +
        `  row ${String(maxRowWords).padStart(4)}/${String(row).padEnd(4)} ${rowsOk ? 'ok  ' : `OVER x${overRows.length}`}` +
        `  ${path}`,
    )

    if (!proseOk) {
      failures.push(`${path}: prose is ${proseWords} words, exceeds the ${prose}-word prose ceiling — relocate or condense per docs/AGENTS.md`)
    }
    for (const { line, words } of overRows) {
      failures.push(`${path}: a table row is ${words} words, exceeds the ${row}-word row ceiling — "${excerpt(line)}"`)
    }
    continue
  }

  rows.push(`BAD   ${'—'.padStart(6)} / ${'—'.padEnd(6)} ${path}`)
  failures.push(`${path}: ceiling must be a positive integer or a { prose, row } object, got ${JSON.stringify(ceiling)}`)
}

if (listOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error('verify-doc-budgets failed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nSee docs/AGENTS.md for the documentation standard and the relocation-first rule.')
  process.exit(1)
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} budgeted docs within ceiling.`)
