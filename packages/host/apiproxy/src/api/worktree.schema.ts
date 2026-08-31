/**
 * worktree domain zod schemas (names derived from map keys). The spawn
 * input schema lives here — the worktree domain owns the seat/sessionName
 * vocabulary — and session.create's intent reuses it (see the note there).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WorktreeHandle, WorktreeRef, WorktreeRow, WorktreeSpawnInput } from './worktree.ts'

/** WorktreeRef: one brand cast after non-empty string validation (the only cast point in this domain). */
export const worktreeRefSchema = z.string().min(1) as unknown as z.ZodType<WorktreeRef>

/**
 * The spawn input the consumer forwards verbatim to the seam: seat and host
 * session name, both non-empty. Grammar beyond non-emptiness is the seam's
 * business, so the wire does not hand-copy the seam's naming rules.
 */
export const worktreeSpawnInputSchema = z.object({
  seat: z.string().min(1),
  sessionName: z.string().min(1),
}) satisfies z.ZodType<Wire<WorktreeSpawnInput>>

/** WorktreeHandle row of worktree.create responses. */
export const worktreeHandleSchema = z.object({
  slug: z.string().min(1),
  branch: z.string(),
  path: z.string(),
  sessionName: z.string(),
  seat: z.string(),
}) satisfies z.ZodType<Wire<WorktreeHandle>>

/** WorktreeRow of every worktree.list item. */
export const worktreeRowSchema = z.object({
  seat: z.string(),
  path: z.string(),
  branch: z.string(),
  sessionName: z.string(),
  locked: z.boolean(),
  lockReason: z.string().optional(),
}) satisfies z.ZodType<Wire<WorktreeRow>>

/** worktree.list request payload (empty object literal). */
export const worktreeListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'worktree.list'>>>

/** worktree.list response value. */
export const worktreeListValueSchema = z.object({
  items: z.array(worktreeRowSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.list'>>>

/** worktree.create request payload: the seat/session pair to mint or resolve. */
export const worktreeCreateRequestSchema = worktreeSpawnInputSchema satisfies z.ZodType<
  Wire<RequestPayload<'worktree.create'>>
>

/** worktree.create response value. */
export const worktreeCreateValueSchema = z.object({
  worktree: worktreeHandleSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.create'>>>

/** worktree.lock request payload: the reference must be non-blank. */
export const worktreeLockRequestSchema = z.object({
  ref: worktreeRefSchema,
  reason: z.string(),
}).refine(
  payload => payload.reason.trim() !== '',
  { message: 'worktree.lock requires a non-blank reason' },
) satisfies z.ZodType<Wire<RequestPayload<'worktree.lock'>>>

/** worktree.lock response value. */
export const worktreeLockValueSchema = z.object({
  locked: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.lock'>>>

/** worktree.remove request payload: the reference must be non-blank. */
export const worktreeRemoveRequestSchema = z.object({
  ref: worktreeRefSchema,
  reason: z.string(),
}).refine(
  payload => payload.reason.trim() !== '',
  { message: 'worktree.remove requires a non-blank reason' },
) satisfies z.ZodType<Wire<RequestPayload<'worktree.remove'>>>

/** worktree.remove response value. */
export const worktreeRemoveValueSchema = z.object({
  removed: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'worktree.remove'>>>
