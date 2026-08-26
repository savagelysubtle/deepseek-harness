/**
 * mailbox domain wire schemas: the addressed publish payload and its
 * admission result. `payload` stays an open unknown because the body is
 * sender-owned JSON with no seam-level shape.
 */

import { z } from 'zod'
import type { MailboxPublishPayload, MailboxPublishValue } from './mailbox.ts'
import type { Wire } from './rpc.schema.ts'

/** One addressed publish request: full `address` form or `namespace`+`name` form. */
export const mailboxPublishRequestSchema = z.object({
  address: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  from: z.string().min(1),
  type: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  traceId: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<MailboxPublishPayload>>

/** Admission result: store id plus what the immediate wake achieved. */
export const mailboxPublishValueSchema = z.object({
  messageId: z.string().min(1),
  disposition: z.union([z.literal('delivered'), z.literal('queued')]),
}) satisfies z.ZodType<MailboxPublishValue>
