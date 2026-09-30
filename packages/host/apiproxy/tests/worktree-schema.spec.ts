/**
 * `worktree.schema.ts` in isolation: none of the OTHER apiproxy specs exercise
 * worktree.lock/worktree.remove's `.refine` (a non-blank reason), so those two
 * function bodies never ran at all — 0% functions on this file. Direct
 * zod-parse tests, matching the style of `rpc-schemas.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  worktreeCreateRequestSchema, worktreeCreateValueSchema, worktreeHandleSchema,
  worktreeListRequestSchema, worktreeListValueSchema, worktreeLockRequestSchema,
  worktreeLockValueSchema, worktreeRefSchema, worktreeRemoveRequestSchema,
  worktreeRemoveValueSchema, worktreeRowSchema, worktreeSpawnInputSchema,
} from '../src/api/worktree.schema.ts'

describe('worktreeRefSchema', () => {
  it('accepts a non-empty string and brands it, and rejects an empty one', () => {
    expect(worktreeRefSchema.parse('wt-1')).toBe('wt-1')
    expect(() => worktreeRefSchema.parse('')).toThrow()
  })
})

describe('worktreeSpawnInputSchema', () => {
  it('requires both seat and sessionName non-empty', () => {
    expect(worktreeSpawnInputSchema.parse({ seat: 'eve', sessionName: 'task' }))
      .toEqual({ seat: 'eve', sessionName: 'task' })
    expect(() => worktreeSpawnInputSchema.parse({ seat: '', sessionName: 'task' })).toThrow()
    expect(() => worktreeSpawnInputSchema.parse({ seat: 'eve', sessionName: '' })).toThrow()
  })
})

describe('worktreeHandleSchema / worktreeRowSchema', () => {
  it('parses a handle and a row, the row carrying an optional lockReason', () => {
    const handle = worktreeHandleSchema.parse({
      slug: 'wt-1', branch: 'br', path: '/p', sessionName: 'task', seat: 'eve',
    })
    expect(handle).toMatchObject({ slug: 'wt-1', seat: 'eve' })

    const unlocked = worktreeRowSchema.parse({
      seat: 'eve', path: '/p', branch: 'br', sessionName: 'task', locked: false,
    })
    expect(unlocked.lockReason).toBeUndefined()
    const locked = worktreeRowSchema.parse({
      seat: 'eve', path: '/p', branch: 'br', sessionName: 'task', locked: true, lockReason: 'busy',
    })
    expect(locked.lockReason).toBe('busy')
  })
})

describe('worktree.list', () => {
  it('request is an empty object and value carries a row list', () => {
    expect(worktreeListRequestSchema.parse({})).toEqual({})
    expect(worktreeListValueSchema.parse({
      items: [{ seat: 'eve', path: '/p', branch: 'br', sessionName: 'task', locked: false }],
    }).items).toHaveLength(1)
  })
})

describe('worktree.create', () => {
  it('request is the spawn input; value wraps a handle', () => {
    expect(worktreeCreateRequestSchema.parse({ seat: 'eve', sessionName: 'task' }))
      .toEqual({ seat: 'eve', sessionName: 'task' })
    expect(worktreeCreateValueSchema.parse({
      worktree: { slug: 'wt-1', branch: 'br', path: '/p', sessionName: 'task', seat: 'eve' },
    }).worktree.slug).toBe('wt-1')
  })
})

describe('worktree.lock', () => {
  it('accepts a non-blank reason and rejects a blank or whitespace-only one (both refine arms)', () => {
    expect(worktreeLockRequestSchema.parse({ ref: 'wt-1', reason: 'holding for review' }))
      .toEqual({ ref: 'wt-1', reason: 'holding for review' })
    expect(() => worktreeLockRequestSchema.parse({ ref: 'wt-1', reason: '' }))
      .toThrow(/non-blank reason/)
    expect(() => worktreeLockRequestSchema.parse({ ref: 'wt-1', reason: '   ' }))
      .toThrow(/non-blank reason/)
    expect(worktreeLockValueSchema.parse({ locked: true })).toEqual({ locked: true })
    expect(() => worktreeLockValueSchema.parse({ locked: false })).toThrow()
  })
})

describe('worktree.remove', () => {
  it('accepts a non-blank reason and rejects a blank or whitespace-only one (both refine arms)', () => {
    expect(worktreeRemoveRequestSchema.parse({ ref: 'wt-1', reason: 'cleanup' }))
      .toEqual({ ref: 'wt-1', reason: 'cleanup' })
    expect(() => worktreeRemoveRequestSchema.parse({ ref: 'wt-1', reason: '' }))
      .toThrow(/non-blank reason/)
    expect(() => worktreeRemoveRequestSchema.parse({ ref: 'wt-1', reason: '\t\n' }))
      .toThrow(/non-blank reason/)
    expect(worktreeRemoveValueSchema.parse({ removed: true })).toEqual({ removed: true })
    expect(() => worktreeRemoveValueSchema.parse({ removed: false })).toThrow()
  })
})
