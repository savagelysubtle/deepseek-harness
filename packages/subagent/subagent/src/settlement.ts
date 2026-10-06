/**
 * The durable subagent-child settlement record: the versioned, log-only
 * `subagent/settlement` session event appended once a continuable child's
 * disposal computes its terminal outcome, inside the same critical section
 * that already resolves {@link SubagentResult.stopReason} — before the
 * existing best-effort in-process settlement push. A durable fact survives a
 * lost push, a torn-down parent, or a cold-resumed listener: any later reader
 * folds the exact same record this module validates.
 *
 * Mirrors {@link descriptor.ts}'s versioned, validated, detached structure.
 * Unlike the descriptor — established once per child and never re-asked —
 * nothing about settlement varies by mode, so this module has a single flat
 * payload shape rather than a one-shot/continuable discriminated union.
 *
 * @module @deepseek-ai/dsh-subagent/settlement
 */

import { SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable terminal outcome of a continuable subagent child, appended once
     * inside `finishDisposal()`'s critical section, before the best-effort
     * in-process settlement notice. Log-only: it carries no `surfaceOp`,
     * never enters model history, and survives compaction.
     */
    'subagent/settlement': SubagentSettlementData
  }
}

/**
 * The current settlement format version, stamped into every appended
 * `subagent/settlement` event and required verbatim by
 * {@link foldSubagentSettlement}. Supporting another recorded field is a
 * deliberate version change, never an implicit extra field.
 */
export const SUBAGENT_SETTLEMENT_VERSION = 1

/** The durable terminal-outcome fact about one continuable subagent child. */
export interface SubagentSettlementData {
  /** Settlement format version ({@link SUBAGENT_SETTLEMENT_VERSION}). */
  readonly version: number
  /** The durable direct parent at settlement time. */
  readonly parentSessionId: SessionId
  /**
   * Why the run ended. Reuses {@link SubagentResult.stopReason}'s
   * merge-extensible union verbatim rather than inventing a parallel
   * near-duplicate vocabulary.
   */
  readonly outcome: SubagentResult['stopReason']
  /**
   * Epoch ms the settlement was computed. Redundant with the event's own
   * `time`, kept explicit for a reader without access to event metadata.
   */
  readonly settledAt: number
}

/** Input {@link snapshotSubagentSettlement} validates and detaches. */
export interface SubagentSettlementInput {
  /** The durable direct parent at settlement time. */
  readonly parentSessionId: SessionId
  /** Why the run ended. */
  readonly outcome: SubagentResult['stopReason']
  /** Epoch ms the settlement was computed. */
  readonly settledAt: number
}

const SETTLEMENT_KEYS = new Set(['version', 'parentSessionId', 'outcome', 'settledAt'])

/** Whether a persisted JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one persisted settlement payload for the current runtime. */
function parseSubagentSettlement(value: unknown): SubagentSettlementData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted subagent settlement payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted subagent settlement version must be a number')
  }
  if (version !== SUBAGENT_SETTLEMENT_VERSION) return undefined

  const unknown = Object.keys(value).find(key => !SETTLEMENT_KEYS.has(key))
  if (unknown !== undefined) {
    throw new Error(`persisted subagent settlement payload has unknown field "${unknown}"`)
  }
  const parentSessionId = value['parentSessionId']
  if (typeof parentSessionId !== 'string') {
    throw new Error('persisted subagent settlement parentSessionId must be a string')
  }
  const outcome = value['outcome']
  if (typeof outcome !== 'string') {
    throw new Error('persisted subagent settlement outcome must be a string')
  }
  const settledAt = value['settledAt']
  if (typeof settledAt !== 'number') {
    throw new Error('persisted subagent settlement settledAt must be a number')
  }
  return {
    version: SUBAGENT_SETTLEMENT_VERSION,
    parentSessionId: SessionId(parentSessionId),
    outcome: outcome as SubagentResult['stopReason'],
    settledAt,
  }
}

/**
 * Validate and detach a settlement input into the durable payload, the same
 * detached lossless-JSON boundary {@link snapshotSubagentDescriptor} enforces
 * for the descriptor, applied before the append so a synchronous validation
 * failure never produces a half-written durable fact.
 * @param input - the caller-collected parent, outcome, and timestamp.
 * @returns the versioned, detached settlement payload.
 * @throws when a field is not losslessly JSON-serializable.
 */
export function snapshotSubagentSettlement(input: SubagentSettlementInput): SubagentSettlementData {
  const candidate: SubagentSettlementData = {
    version: SUBAGENT_SETTLEMENT_VERSION,
    parentSessionId: input.parentSessionId,
    outcome: input.outcome,
    settledAt: input.settledAt,
  }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('subagent settlement is not losslessly JSON-serializable')
  }
  return snapshot
}

/**
 * Fold a persisted child log to its supported settlement record. The first
 * matching `subagent/settlement` event in the given slice is authoritative;
 * the registered projection unit achieves last-wins behavior across a whole
 * log by calling this with one event at a time as each is folded, rather than
 * by this function scanning for the latest match itself.
 * @param events - the loaded child session events, or a single-event slice.
 * @returns the settlement record, or `undefined` when the slice has none or
 *   its version is not {@link SUBAGENT_SETTLEMENT_VERSION} (the record cannot
 *   be classified by this runtime).
 * @throws when a current-version persisted payload does not match its
 *   complete declared schema.
 */
export function foldSubagentSettlement(events: readonly SessionEvent[]): SubagentSettlementData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/settlement'> => candidate.type === 'subagent/settlement',
  )
  if (event === undefined) return undefined
  return parseSubagentSettlement(event.data)
}
