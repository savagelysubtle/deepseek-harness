/** Slug minting uniqueness, format, and durable-load validation. */

import { describe, expect, it } from 'vitest'
import { mintWorktreeSlug, parseWorktreeSlug, WORKTREE_SLUG_PATTERN_SOURCE } from '../src/slug.ts'

describe('mintWorktreeSlug', () => {
  it('mints unique slugs across a long sequence', () => {
    const slugs = new Set<string>()
    for (let index = 0; index < 2_000; index += 1) slugs.add(mintWorktreeSlug())
    expect(slugs.size).toBe(2_000)
  })

  it('mints unique slugs across parallel spawns', async () => {
    const slugs = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve(mintWorktreeSlug())))
    expect(new Set(slugs).size).toBe(50)
  })

  it('mints slugs matching the documented grammar', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(mintWorktreeSlug()).toMatch(new RegExp(WORKTREE_SLUG_PATTERN_SOURCE))
    }
  })
})

describe('parseWorktreeSlug', () => {
  it('round-trips a minted slug', () => {
    const slug = mintWorktreeSlug()
    expect(parseWorktreeSlug(slug)).toBe(slug)
  })

  it('rejects foreign shapes loudly', () => {
    for (const raw of ['', 'With-Caps', 'under_score', 'dot.name', 'a/b', 'a b']) {
      expect(() => parseWorktreeSlug(raw)).toThrow(`invalid worktree slug ${JSON.stringify(raw)}`)
    }
  })
})
