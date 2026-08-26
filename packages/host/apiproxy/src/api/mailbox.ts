/**
 * mailbox domain contract: the wire face for NON-dsh callers to admit mail
 * into a served `<namespace>:<name>` address without local file access. The
 * host routes publication through the mailbox registry's default provider and
 * wakes the bridge immediately; the response reports what the wake achieved.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Addressed publish request: a full `address`, or `namespace` + `name`. */
export interface MailboxPublishPayload {
  /** Full destination address in the `<namespace>:<name>` grammar. */
  readonly address?: string
  /** Namespace half, required together with `name`; exclusive with `address`. */
  readonly namespace?: string
  /** Name half (the target agent's session name), required with `namespace`. */
  readonly name?: string
  /** Sender address; free-form provenance shown to the recipient. */
  readonly from: string
  /** Optional machine-readable intent (`notice`, `task`, …). */
  readonly type?: string
  /** Optional human-readable subject line. */
  readonly subject?: string
  /** Optional JSON-serializable body owned by the sender. */
  readonly payload?: unknown
  /** Optional correlation id threaded into the delivered turn's source. */
  readonly traceId?: string
}

/** Result of one woken admission. */
export interface MailboxPublishValue {
  /** The store-assigned durable id of the admitted message. */
  readonly messageId: string
  /**
   * `delivered`: the bridge routed it into a session inbox this wake (live or
   * cold-resumed). `queued`: it is stored and will be routed by a later cycle
   * — residency was held elsewhere or another claim got there first.
   */
  readonly disposition: 'delivered' | 'queued'
}

/** Mailbox-domain unary methods (the map keys mailbox.* of RpcMethodMap). */
export interface MailboxApi {
  /**
   * Admit one message into a served address and wake its target now.
   *
   * A malformed address, an unknown split of the addressing halves, or an
   * address outside every mounted bridge's roster rejects loud before
   * anything is stored (`mailbox-rejected`). A terminal routing failure
   * after storage (the target names no persisted session, for example)
   * also rejects loud, carrying the routing reason.
   */
  publish(request: RpcRequest<MailboxPublishPayload>): Promise<RpcResponse<MailboxPublishValue>>
}
