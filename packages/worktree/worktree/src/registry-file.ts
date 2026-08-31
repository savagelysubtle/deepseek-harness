/**
 * JSON persistence of registry rows under the worktrees root. The file is a
 * mirror the next process loads at mount — git's own worktree state stays the
 * authority over what exists on disk; rows only remember the seam's bookkeeping.
 *
 * @module @deepseek-ai/dsh-worktree/registry-file
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorktreeError } from './errors.ts'
import { parseWorktreeSlug } from './slug.ts'
import type { WorktreeRow } from './types.ts'

/** Persistence schema version; a mismatched file fails loud instead of merging. */
export const REGISTRY_FILE_VERSION = 1

/** Name of the registry file inside the worktrees root. */
export const REGISTRY_FILENAME = 'registry.json'

/**
 * Absolute path of the registry file under a worktrees root.
 * @param worktreesRoot - absolute worktrees root directory.
 * @returns the registry file path.
 */
export function registryFilePath(worktreesRoot: string): string {
  return join(worktreesRoot, REGISTRY_FILENAME)
}

/**
 * Validate one persisted row against the durable-file contract.
 * @param raw - parsed JSON value at `rows[index]`.
 * @param path - registry file path, for the error message.
 * @param index - row index, for the error message.
 * @returns the validated row.
 */
function parseRow(raw: unknown, path: string, index: number): WorktreeRow {
  const fail = (detail: string): WorktreeError => {
    return new WorktreeError(`${path}: corrupt registry row ${index}: ${detail}`, 'REGISTRY_CORRUPT')
  }
  if (typeof raw !== 'object' || raw === null) throw fail('not an object')
  const record = raw as Record<string, unknown>
  const string = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.length === 0) throw fail(`${key} must be a non-empty string`)
    return value
  }
  const createdAt = record['createdAt']
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) throw fail('createdAt must be a safe integer')
  const lockReason = record['lockReason']
  const lastReason = record['lastReason']
  if (lockReason !== undefined && typeof lockReason !== 'string') throw fail('lockReason must be a string when present')
  if (lastReason !== undefined && typeof lastReason !== 'string') throw fail('lastReason must be a string when present')
  let slug: WorktreeRow['slug']
  try {
    slug = parseWorktreeSlug(string('slug'))
  } catch (error: unknown) {
    // Both throwing callees reject with Error subclasses by construction.
    throw fail((error as Error).message)
  }
  return {
    slug,
    seat: string('seat'),
    branch: string('branch'),
    session: string('session'),
    path: string('path'),
    branchRef: string('branchRef'),
    createdAt,
    ...(typeof lockReason === 'string' ? { lockReason } : {}),
    ...(typeof lastReason === 'string' ? { lastReason } : {}),
  }
}

/**
 * Load registry rows from the JSON file. A missing file is the fresh-root
 * state, not a failure; a malformed file fails loud — a half-understood
 * registry would silently fence seats out of their own worktrees.
 * @param path - registry file path from {@link registryFilePath}.
 * @returns the persisted rows; empty when the file does not exist.
 * @throws WorktreeError with code `REGISTRY_CORRUPT` when the file exists but is not a valid v1 registry.
 */
export function loadRegistryFile(path: string): readonly WorktreeRow[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error: unknown) {
    // JSON.parse rejects with SyntaxError by construction.
    throw new WorktreeError(`${path}: registry is not valid JSON: ${(error as Error).message}`, 'REGISTRY_CORRUPT')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WorktreeError(`${path}: registry must be a JSON object`, 'REGISTRY_CORRUPT')
  }
  const version = (parsed as Record<string, unknown>)['version']
  if (version !== REGISTRY_FILE_VERSION) {
    throw new WorktreeError(`${path}: registry version must be ${REGISTRY_FILE_VERSION}, saw ${JSON.stringify(version)}`, 'REGISTRY_CORRUPT')
  }
  const rows = (parsed as Record<string, unknown>)['rows']
  if (!Array.isArray(rows)) {
    throw new WorktreeError(`${path}: registry rows must be an array`, 'REGISTRY_CORRUPT')
  }
  return rows.map((row, index) => parseRow(row, path, index))
}

/**
 * Write registry rows to the JSON file atomically: content lands in a
 * temporary sibling first, then renames over the target, so a crash mid-write
 * never leaves a truncated registry behind.
 * @param path - registry file path from {@link registryFilePath}.
 * @param rows - the rows to persist, in registry order.
 */
export function saveRegistryFile(path: string, rows: readonly WorktreeRow[]): void {
  const content = `${JSON.stringify({ version: REGISTRY_FILE_VERSION, rows }, undefined, 2)}\n`
  const temporary = `${path}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}
