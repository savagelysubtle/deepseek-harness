/** org domain zod schemas (names derived from map keys: orgGetRequestSchema / orgGetValueSchema). */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type {
  OrgDriftResult, OrgDriftRow, OrgEdge, OrgRegistryDocument, OrgRegistryDocumentSeat,
  OrgRegistryResult, OrgRegistryView, OrgRosterResult, OrgSeat, OrgSeatTools,
} from './org.ts'

/** OrgSeatTools of a registry seat's `tools` field. */
export const orgSeatToolsSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}) satisfies z.ZodType<Wire<OrgSeatTools>>

/** OrgSeat: one registry roster entry. */
export const orgSeatSchema = z.object({
  cwd: z.string(),
  lead: z.boolean().optional(),
  sessionId: z.string().optional(),
  test: z.boolean().optional(),
  tools: orgSeatToolsSchema.optional(),
}) satisfies z.ZodType<Wire<OrgSeat>>

/** OrgEdge: one undirected [from, to] seat pair. */
export const orgEdgeSchema = z.tuple([z.string(), z.string()]) satisfies z.ZodType<Wire<OrgEdge>>

/** OrgRegistryView: the parsed registry, keyed roster included. */
export const orgRegistryViewSchema = z.object({
  baseDir: z.string(),
  seats: z.record(z.string(), orgSeatSchema),
  edges: z.array(orgEdgeSchema),
  callUp: z.array(z.string()),
}) satisfies z.ZodType<Wire<OrgRegistryView>>

/** OrgRegistryDocumentSeat: one seat as submitted to org.write (cwd unresolved; see {@link OrgRegistryDocumentSeat}). */
export const orgRegistryDocumentSeatSchema = z.object({
  cwd: z.string(),
  lead: z.boolean().optional(),
  sessionId: z.string().optional(),
  test: z.boolean().optional(),
  tools: orgSeatToolsSchema.optional(),
}) satisfies z.ZodType<Wire<OrgRegistryDocumentSeat>>

/** OrgRegistryDocument: the whole-document write payload org.write accepts (see {@link OrgRegistryDocument}). */
export const orgRegistryDocumentSchema = z.object({
  baseDir: z.string(),
  seats: z.record(z.string(), orgRegistryDocumentSeatSchema),
  edges: z.array(orgEdgeSchema),
  callUp: z.array(z.string()),
}) satisfies z.ZodType<Wire<OrgRegistryDocument>>

/**
 * OrgRegistryResult: the registry read, or a named failure reason (see
 * {@link OrgRegistryResult}). The ok branch carries BOTH `registry` and
 * `document` — declared above so this schema can reference
 * `orgRegistryDocumentSchema`. Including `document` here is load-bearing,
 * not cosmetic: the real wire client parses every response through this
 * schema, and Zod silently STRIPS unknown keys from an object schema — a
 * `document` the server sends but this schema omits would vanish before the
 * client ever saw it.
 */
export const orgRegistryResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    registry: orgRegistryViewSchema,
    document: orgRegistryDocumentSchema,
    token: z.string(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]) satisfies z.ZodType<Wire<OrgRegistryResult>>

/** OrgRosterResult: one served-address roster, or a named failure reason (see {@link OrgRosterResult}). */
export const orgRosterResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), addresses: z.array(z.string()) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]) satisfies z.ZodType<Wire<OrgRosterResult>>

/** OrgDriftRow: one row of registry-vs-roster disagreement. */
export const orgDriftRowSchema = z.object({
  seat: z.string(),
  registered: z.boolean(),
  servedByMailboxBridge: z.boolean(),
  servedByToolMailbox: z.boolean(),
}) satisfies z.ZodType<Wire<OrgDriftRow>>

/** OrgDriftResult: the computed drift report, or a named failure reason (see {@link OrgDriftResult}). */
export const orgDriftResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rows: z.array(orgDriftRowSchema) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]) satisfies z.ZodType<Wire<OrgDriftResult>>

/** org.get request payload (empty object literal — no arguments). */
export const orgGetRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'org.get'>>>

/** org.get response value. */
export const orgGetValueSchema = z.object({
  profile: z.string(),
  registry: orgRegistryResultSchema,
  mailboxBridge: orgRosterResultSchema,
  toolMailbox: orgRosterResultSchema,
  drift: orgDriftResultSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'org.get'>>>

/** org.write request payload: the whole proposed document plus the token it was built against. */
export const orgWriteRequestSchema = z.object({
  document: orgRegistryDocumentSchema,
  expectedToken: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'org.write'>>>

/** org.write response value: the newly written registry and its new content token. */
export const orgWriteValueSchema = z.object({
  registry: orgRegistryViewSchema,
  token: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'org.write'>>>
