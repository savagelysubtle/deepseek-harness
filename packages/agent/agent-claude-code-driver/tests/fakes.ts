/**
 * Test doubles for the Claude Code driver: a fake SDK `query`, a fake child
 * process handle, and a harness that builds a real Context with the session
 * store and agent registry. The real binary is never spawned.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { buildChildEnv } from '../src/env.ts'
import { ProcessLedger } from '../src/ledger.ts'
import type { LedgerProcessOps } from '../src/ledger.ts'
import { ClaudeCodeSeatAgent, SeatGate } from '../src/seat-agent.ts'
import type { SeatAgentDeps, TranscriptState } from '../src/seat-agent.ts'
import { parseSeatRow } from '../src/seat-config.ts'
import type { ClaudeCodeSeatConfig, ClaudeCodeSeatRow } from '../src/seat-config.ts'

export const CLAUDE_PATH = '/opt/claude/versions/2.1.317/claude'

export function seatRow(overrides: Partial<ClaudeCodeSeatRow['claude_code']> = {}): ClaudeCodeSeatRow {
  return {
    driver: 'claude-code',
    claude_code: { model: 'sonnet', role: 'lead', max_turns: 20, claude_path: CLAUDE_PATH, ...overrides },
  }
}

export function seatConfig(overrides: Partial<ClaudeCodeSeatRow['claude_code']> = {}): ClaudeCodeSeatConfig {
  return parseSeatRow(seatRow(overrides), 'tester', { policyExtension: true })
}

export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export function resultMessage(overrides: Record<string, unknown> = {}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 50,
    duration_api_ms: 40,
    num_turns: 2,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.02,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: {
      'claude-sonnet-x': {
        inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
        webSearchRequests: 0, costUSD: 0.02, contextWindow: 200000, maxOutputTokens: 8000,
      },
    },
    permission_denials: [],
    uuid: 'res-uuid',
    session_id: 'sdk-session',
    ...overrides,
  } as unknown as SDKResultMessage
}

/** A hand-driven stand-in for the SDK `Query`: the test decides which messages arrive and when. */
export class FakeQuery {
  readonly consumed: SDKUserMessage[] = []
  promptEnded = false
  interrupted = false
  closed = false
  spawned: SpawnedProcess | undefined
  private readonly out: SDKMessage[] = []
  private waiter: PromiseWithResolvers<undefined> | undefined
  private ended = false
  private failure: Error | undefined

  constructor(readonly prompt: AsyncIterable<SDKUserMessage>, readonly options: Options) {
    void (async () => {
      for await (const message of prompt) this.consumed.push(message)
      this.promptEnded = true
      this.finish()
    })()
  }

  emit(message: SDKMessage): void {
    this.out.push(message)
    this.waiter?.resolve(undefined)
  }

  finish(): void {
    this.ended = true
    this.waiter?.resolve(undefined)
  }

  fail(error: Error): void {
    this.failure = error
    this.waiter?.resolve(undefined)
  }

  /** The uuids of every prompt message consumed so far. */
  uuids(): string[] {
    return this.consumed.map(message => message.uuid as string)
  }

  /** Simulate the SDK spawning the CLI through the supplied hook. */
  spawn(): SpawnedProcess {
    this.spawned = this.options.spawnClaudeCodeProcess?.({
      command: this.options.pathToClaudeCodeExecutable as string,
      args: ['--print'],
      cwd: this.options.cwd as string,
      env: this.options.env as Record<string, string | undefined>,
      signal: this.options.abortController?.signal as AbortSignal,
    })
    return this.spawned as SpawnedProcess
  }

  interrupt(): Promise<undefined> {
    this.interrupted = true
    this.fail(new Error('query interrupted'))
    return Promise.resolve(undefined)
  }

  close(): void {
    this.closed = true
    this.finish()
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    while (true) {
      const message = this.out.shift()
      if (message !== undefined) return { value: message, done: false }
      if (this.failure !== undefined) {
        const error = this.failure
        this.failure = undefined
        throw error
      }
      if (this.ended) return { value: undefined, done: true }
      this.waiter = Promise.withResolvers<undefined>()
      await this.waiter.promise
    }
  }

  [Symbol.asyncIterator](): this {
    return this
  }
}

export interface FakeChild extends SubprocessHandle {
  readonly terminate: Mock<() => void>
  finish(): void
  crash(): void
}

export function fakeChild(pid: number, options: { exitsOnWait?: boolean; waitFails?: boolean } = {}): FakeChild {
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const terminate = vi.fn<() => void>()
  return {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    collected: {},
    done: done.promise,
    terminate,
    waitForExit: () => (options.waitFails === true ? Promise.reject(new Error('wait aborted')) : Promise.resolve(options.exitsOnWait ?? true)),
    finish: () => { done.resolve({ exitCode: 0, signal: null }) },
    crash: () => { done.reject(new Error('child crashed')) },
  }
}

export interface Harness {
  readonly ctx: Context
  readonly queries: FakeQuery[]
  readonly children: FakeChild[]
  readonly killed: number[]
  readonly warnings: string[]
  readonly ledger: ProcessLedger
  readonly ledgerFile: string
  readonly gate: SeatGate
  readonly state: {
    transcript: TranscriptState
    hostEnv: NodeJS.ProcessEnv
    failNextQuery: Error | undefined
    now: number
    flushError: Error | undefined
    /** Order in which the session flush and the SDK query ran. */
    calls: string[]
  }
  readonly deps: SeatAgentDeps
  session(id?: string): Session
  agent(options?: { session?: Session; seat?: string; config?: ClaudeCodeSeatConfig }): ClaudeCodeSeatAgent
  /** Wait until the Nth query exists. */
  query(index: number): Promise<FakeQuery>
}

export function ledgerOps(
  table: Map<number, string>,
  killed: number[],
  extra: Partial<LedgerProcessOps> = {},
): LedgerProcessOps {
  return {
    readStartTime: pid => table.get(pid),
    killGroup: (pid) => { killed.push(pid) },
    groupAlive: () => false,
    bootId: () => 'boot-1',
    hostPid: 777,
    ...extra,
  }
}

const tempDirs: string[] = []

/** A fresh private temporary directory, removed by {@link cleanTempDirs}. */
export function tempDir(prefix = 'cc-driver-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Remove every directory {@link tempDir} made. */
export function cleanTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A private executable file standing in for the claude binary; returns its path. */
export function fakeClaudeBinary(content = '#!/bin/sh\nexit 0\n'): string {
  const dir = tempDir('cc-bin-')
  chmodSync(dir, 0o700)
  const file = join(dir, 'claude')
  writeFileSync(file, content, { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}

export async function harness(options: { childPid?: number; childExitsOnWait?: boolean; childWaitFails?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const queries: FakeQuery[] = []
  const children: FakeChild[] = []
  const killed: number[] = []
  const warnings: string[] = []
  const state: Harness['state'] = { transcript: 'ok', hostEnv: {}, failNextQuery: undefined, now: 1_800_000_000_000, flushError: undefined, calls: [] }
  const ledgerFile = join(tempDir(), 'pids.json')
  const ledger = new ProcessLedger(ledgerFile, ledgerOps(new Map([[options.childPid ?? 4242, 'tick-1'], [777, 'host-tick']]), []))
  const gate = new SeatGate()
  const waiters: Array<{ index: number; resolve: (query: FakeQuery) => void }> = []
  const deps: SeatAgentDeps = {
    query: ({ prompt, options: queryOptions }) => {
      state.calls.push('query')
      if (state.failNextQuery !== undefined) {
        const error = state.failNextQuery
        state.failNextQuery = undefined
        throw error
      }
      const fake = new FakeQuery(prompt, queryOptions)
      queries.push(fake)
      for (const waiter of waiters.filter(entry => entry.index < queries.length)) waiter.resolve(queries[waiter.index] as FakeQuery)
      return fake as unknown as Query
    },
    spawnProcess: () => {
      const exits = options.childExitsOnWait === undefined ? {} : { exitsOnWait: options.childExitsOnWait }
      const child = fakeChild(options.childPid ?? 4242, { ...exits, waitFails: options.childWaitFails === true })
      children.push(child)
      return child
    },
    killProcessGroup: (pid) => { killed.push(pid) },
    transcriptState: () => Promise.resolve(state.transcript),
    hostEnv: () => state.hostEnv,
    childEnv: () => buildChildEnv({ PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u' }),
    now: () => state.now,
    graceMs: 10,
    defaultPauseMs: 60_000,
    ledger,
    flush: () => {
      state.calls.push('flush')
      return state.flushError === undefined ? Promise.resolve() : Promise.reject(state.flushError)
    },
    warn: (message) => { warnings.push(message) },
  }
  let counter = 0
  const harnessValue: Harness = {
    ctx, queries, children, killed, warnings, ledger, ledgerFile, gate, state, deps,
    session: (id = `cc-session-${++counter}`) => ctx.sessions.create(SessionId(id)),
    agent: (agentOptions = {}) => {
      const session = agentOptions.session ?? harnessValue.session()
      return new ClaudeCodeSeatAgent(
        ctx, session.id, session, agentOptions.seat ?? 'tester', agentOptions.config ?? seatConfig(), '/work/seat', deps, gate,
      )
    },
    query: (index) => {
      const existing = queries[index]
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise<FakeQuery>((resolve) => { waiters.push({ index, resolve }) })
    },
  }
  return harnessValue
}

/** Resolve after the macrotask queue has drained the pending microtasks. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
