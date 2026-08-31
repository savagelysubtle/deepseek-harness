/**
 * Slug minting and validation. The seam mints slugs itself — the caller never
 * chooses one — so parallel rounds inside one process are made unique by a
 * monotonic counter, and cross-process runs by the random tail.
 *
 * @module @deepseek-ai/dsh-worktree/slug
 */

import { randomBytes } from 'node:crypto'
import type { WorktreeSlug } from './types.ts'

/** Source form of one minted slug: base36 time, base36 counter, random tail. */
export const WORKTREE_SLUG_PATTERN_SOURCE = '^[0-9a-z]+(-[0-9a-z]+)*$'

const SLUG_PATTERN = new RegExp(WORKTREE_SLUG_PATTERN_SOURCE)

/** Monotonic per-process counter; guarantees uniqueness across parallel spawns. */
let counter = 0

/**
 * Mint one slug: `<base36 epoch ms>-<base36 counter>-<8 hex random>`. The
 * counter makes parallel mints in one process unique even within the same
 * millisecond; the random tail separates slugs across process restarts.
 * @returns the branded slug.
 */
export function mintWorktreeSlug(): WorktreeSlug {
  counter += 1
  return `${Date.now().toString(36)}-${counter.toString(36)}-${randomBytes(4).toString('hex')}` as WorktreeSlug
}

/**
 * Validate one raw slug against the slug grammar and brand it — the durable
 * registry load path is the only source of foreign slugs.
 * @param raw - candidate slug text.
 * @returns the branded slug.
 * @throws when the slug violates the grammar.
 */
export function parseWorktreeSlug(raw: string): WorktreeSlug {
  if (!SLUG_PATTERN.test(raw)) {
    throw new Error(`invalid worktree slug ${JSON.stringify(raw)}: must match ${WORKTREE_SLUG_PATTERN_SOURCE}`)
  }
  return raw as WorktreeSlug
}
