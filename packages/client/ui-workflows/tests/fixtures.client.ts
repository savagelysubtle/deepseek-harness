/** Shared fixtures and a fake `workflow` Remote namespace for the Workflows surface specs. */
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  WorkflowDryRunOk, WorkflowFailure, WorkflowListOk, WorkflowPendingApprovalsOk,
  WorkflowReadOk, WorkflowRunDetailOk, WorkflowRunsOk, WorkflowValidateResult,
} from '@deepseek-ai/dsh-workflow-remote/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowRemote } from '../src/client/api.ts'
import { en } from '../src/client/locales.ts'

export const SESSION = 'session-1' as SessionId
export const KEY = 'ws-key-aaaa'
export const OTHER_KEY = 'ws-key-bbbb'

/** Translate stub: dictionary lookup with `{param}` interpolation. */
export const translate = ((key: string, params?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}) as never

export const fail = (error: WorkflowFailure['error'], extra: Partial<WorkflowFailure> = {}): WorkflowFailure => ({
  ok: false, error, message: `${error} happened`, ...extra,
})

export const LIST: WorkflowListOk = {
  ok: true,
  workspaceKey: KEY,
  workflows: [
    { name: 'build', description: 'Build it', nodeCount: 2, hash: 'h1', valid: true, diagnosticCount: 0, lastRun: { runId: 'r1', status: 'success' } },
    { name: 'broken', description: '', nodeCount: 0, hash: 'h2', valid: false, diagnosticCount: 3 },
  ],
}

const READ: WorkflowReadOk = { ok: true, name: 'build', text: 'version: 1\nname: build\n', token: 'tok-1' }

const VALID: WorkflowValidateResult = {
  ok: true,
  diagnostics: [],
  graph: {
    nodes: [], edges: [], layers: 0, manifest: [],
    inputs: [
      { name: 'target', type: 'string', required: true, description: 'Where to build' },
      { name: 'count', type: 'number', required: false, default: 1 },
      { name: 'fast', type: 'boolean', required: false },
    ],
  },
}

export const PLAN: WorkflowDryRunOk = {
  ok: true,
  name: 'build',
  hash: 'h1',
  trusted: false,
  trustKey: 'a'.repeat(64),
  trustChallenge: 'c'.repeat(32),
  confirmText: 'This workflow will run: rm -rf dist (workspace /w)',
  graph: {
    nodes: [
      { id: 'clean', kind: 'bash', layer: 0, order: 0, gate: false, triggerRule: 'all_success', dependsOn: [], label: 'Clean' },
      { id: 'ship', kind: 'approval', layer: 1, order: 0, gate: true, when: '$clean.status == success', triggerRule: 'all_success', dependsOn: ['clean'], label: 'Ship', tier: 'fast' },
    ],
    edges: [{ from: 'clean', to: 'ship' }],
    layers: 2,
    manifest: [{ nodeId: 'ship', gateKind: 'approval' }],
    inputs: [],
  },
  layout: { positions: { clean: { x: 0, y: 0 }, ship: { x: 300, y: 0 } }, width: 520, height: 72 },
  manifest: [{ nodeId: 'ship', gateKind: 'approval' }],
  plan: ['clean', 'ship'],
  trust: {
    name: 'build',
    bashCommands: [{ nodeId: 'clean', field: 'bash', command: 'rm -rf dist', workdir: 'sub', envKeys: ['A'], env: { A: '1' } }],
    promptFiles: ['p.md'],
    agents: [{ nodeId: 'ship', tier: 'fast' }],
    approvalNodes: 1,
  },
  warnings: [{ severity: 'warning', code: 'w', message: 'careful', line: 2, column: 3, path: [] }],
}

const { trustChallenge: _challenge, confirmText: _confirm, ...PLAN_BASE } = PLAN
export const TRUSTED_PLAN: WorkflowDryRunOk = {
  ...PLAN_BASE, trusted: true,
  trust: { ...PLAN.trust, bashCommands: [], promptFiles: [], agents: [], approvalNodes: 0 }, warnings: [], manifest: [],
}

export const RUNS: WorkflowRunsOk = {
  ok: true,
  workspaceKey: KEY,
  runs: [
    { runId: 'r1', name: 'build', hash: 'h1', startedAt: 1_700_000_000_000, status: 'running' },
    { runId: 'r0', name: 'build', hash: 'h1', startedAt: 1_600_000_000_000, endedAt: 1_600_000_100_000, status: 'failed' },
  ],
}

export const DETAIL: WorkflowRunDetailOk = {
  ok: true,
  runId: 'r1',
  name: 'build',
  status: 'running',
  startedAt: 1_700_000_000_000,
  pinnedHash: 'h1',
  fileChanged: true,
  inputs: { target: 'prod' },
  nodes: [
    { nodeId: 'clean', kind: 'bash', status: 'success', attempt: 2, startedAt: 1, durationMs: 40, exitCode: 0, truncated: true, hasOutput: true },
    { nodeId: 'ship', kind: 'approval', status: 'running', attempt: 1, startedAt: 2, truncated: false, hasOutput: false, error: 'boom' },
  ],
  gates: [{ nodeId: 'ship', gateKind: 'approval', outcome: 'fired-pass' }],
  approvals: [
    { approvalId: 'ap1', nodeId: 'ship', message: 'Ship it?', state: 'pending', at: 1 },
    { approvalId: 'ap0', nodeId: 'ship', message: 'Earlier?', state: 'rejected', reason: 'nope', at: 0 },
  ],
}

const PENDING: WorkflowPendingApprovalsOk = {
  ok: true,
  approvals: [{ runId: 'r1', approvalId: 'ap1', nodeId: 'ship', message: 'Ship it?' }],
}

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }
const ok = (value: unknown): Result => ({ ok: true, value })

/** Every method name of the `workflow` namespace. */
export type RemoteMethod =
  'list' | 'read' | 'validate' | 'dryRun' | 'runs' | 'runDetail' | 'pendingApprovals' | 'save' | 'run' | 'resume'
  | 'cancel' | 'nodeOutput' | 'approve' | 'reject' | 'attachUi' | 'detachUi'

/** A fake Remote namespace; every method is a mock returning the happy-path fixture. */
export function makeRemote(): Record<RemoteMethod, Mock> & { asRemote: WorkflowRemote } {
  const mocks: Record<RemoteMethod, Mock> = {
    list: vi.fn(() => Promise.resolve(ok(LIST))),
    read: vi.fn(() => Promise.resolve(ok(READ))),
    validate: vi.fn(() => Promise.resolve(ok(VALID))),
    dryRun: vi.fn(() => Promise.resolve(ok(PLAN))),
    runs: vi.fn(() => Promise.resolve(ok(RUNS))),
    runDetail: vi.fn(() => Promise.resolve(ok(DETAIL))),
    pendingApprovals: vi.fn(() => Promise.resolve(ok(PENDING))),
    save: vi.fn(() => Promise.resolve(ok({ ok: true, token: 'tok-2', diagnostics: [] }))),
    run: vi.fn(() => Promise.resolve(ok({ ok: true, runId: 'r9' }))),
    resume: vi.fn(() => Promise.resolve(ok({ ok: true, runId: 'r8' }))),
    cancel: vi.fn(() => Promise.resolve(ok({ ok: true, status: 'cancelled' }))),
    nodeOutput: vi.fn(() => Promise.resolve(ok({ ok: true, text: 'hello out', totalBytes: 9, truncated: false }))),
    approve: vi.fn(() => Promise.resolve(ok({ ok: true, state: 'allowed' }))),
    reject: vi.fn(() => Promise.resolve(ok({ ok: true, state: 'rejected' }))),
    attachUi: vi.fn(() => Promise.resolve(ok({ ok: true, leaseId: 'l'.repeat(32), ttlMs: 45_000, workspaceKey: KEY }))),
    detachUi: vi.fn(() => Promise.resolve(ok({ ok: true }))),
  }
  return Object.assign(mocks, { asRemote: mocks })
}

/** A carrier-level failure, as the Remote face folds a non-2xx answer. */
export const carrierFailure = (message: string): Result => ({ ok: false, error: { code: 'internal', message, details: {} } })
export const hostValue = ok

/** Let queued promise continuations run, under fake timers too. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
