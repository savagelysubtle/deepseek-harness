/**
 * Real-composition delivery flows over real Loader trees with only the model
 * mocked: a dormant named session cold-resumes when the bridge drains a seeded
 * SQLite queue into it, and the headless served-address hook admits queued
 * mail ahead of its own task turn.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import MailboxLocal, { openMailboxDatabase, SqliteMailboxStore } from '@deepseek-ai/dsh-mailbox-local'
import * as HeadlessRunnerModule from '../../../bundle/headless/src/index.ts'
import * as HeadlessStartupModule from '../../../bundle/headless/src/startup.ts'
import * as bridge from '../src/index.ts'

/** The headless launcher's swappable process streams, captured per boot. */
const headlessInternals = HeadlessRunnerModule.internals

/** A scripted model: records every request and answers each with the next canned response. */
class ScriptedAdapter extends LlmAdapter {
  /** Every request the loop assembled, in order. */
  readonly requests: GenerateOptions[] = []

  /**
   * @param responses - one assistant text per streamed request, consumed in order.
   */
  constructor(private readonly responses: readonly string[]) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.responses[this.requests.length - 1] ?? ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let roots: string[] = []

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  roots = []
})

/** One private environment: DSH_HOME root, sessions root, and the queue file. */
function makeEnv(): { home: string; sessionsRoot: string; storePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-comp-'))
  roots.push(dir)
  const home = join(dir, 'home')
  const sessionsRoot = join(home, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  process.env.DSH_HOME = home
  return { home, sessionsRoot, storePath: join(home, 'mailbox.db') }
}

/**
 * Seed one message into the queue file the composed local provider will open,
 * returning its durable id.
 * @param storePath - the database file to publish into.
 * @param address - the destination address to publish to.
 */
async function seed(storePath: string, address: string): Promise<string> {
  const store = new SqliteMailboxStore(openMailboxDatabase(storePath))
  const id = await store.publish({ to: address as never, from: 'comp:sender', subject: 'wake up' })
  store.close()
  return id
}

/** Read one message's stored lifecycle state straight out of the provider file. */
function storedState(storePath: string, messageId: string): string {
  const db = new DatabaseSync(storePath)
  try {
    const row = db.prepare('SELECT state FROM messages WHERE id = ?').get(messageId) as unknown as { state: string }
    return row.state
  } finally {
    db.close()
  }
}

/** Poll a condition until it holds or the budget expires. */
async function until(holds: () => boolean, budgetMs = 20_000): Promise<void> {
  const started = Date.now()
  while (!holds()) {
    if (Date.now() - started > budgetMs) throw new Error('composition condition never settled')
    await new Promise<void>(resolve => { setTimeout(resolve, 50) })
  }
}

interface BootOptions {
  /** Extra yml rows beyond the shared agent stack and mailbox pair. */
  readonly extraRows?: readonly string[]
  /** The scripted model answers, consumed per streamed request. */
  readonly responses: readonly string[]
  /** Inner command line for the launcher; absent boots run without one. */
  readonly args?: readonly string[]
  /** Resolves once the boot may dispose (run exited / delivery observed). */
  readonly settled: () => Promise<void>
  /**
   * Await full tree quiescence before the settled condition. A polling plugin
   * never reaches quiescence, so its boots must opt out.
   */
  readonly awaitQuiescence?: boolean
  /** Captured launcher output from the headless runner's internals. */
  readonly capture?: { stdout: string[]; stderr: string[] } | undefined
}

interface BootOutcome {
  code: number
  adapter: ScriptedAdapter
}

/**
 * Boot one full application over a real Loader tree and dispose it once the
 * caller's settled condition resolves. Workspace plugin names resolve to
 * source through the module map; the scripted model arrives as a fixture
 * file-URL row registering itself through `ctx.llm`.
 * @param env - the shared environment whose queue/sessions files compose in.
 * @param options - rows, script, command line, settled condition, capture.
 */
async function boot(env: ReturnType<typeof makeEnv>, options: BootOptions): Promise<BootOutcome> {
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-comp-config-'))
  roots.push(configDir)

  const mockPath = join(configDir, 'mock-model.mjs')
  await writeFile(mockPath, [
    'export const name = "test-mock-model"',
    'export const inject = ["llm"]',
    'export function apply(ctx) { globalThis.__mailboxCompositionRegisterModel(ctx) }',
    '',
  ].join('\n'))

  const configPath = join(configDir, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(env.sessionsRoot)}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    `- name: ${JSON.stringify(pathToFileURL(mockPath).href)}`,
    "- name: '@deepseek-ai/dsh-mailbox'",
    '  config:',
    '    defaultProvider: local',
    "- name: '@deepseek-ai/dsh-mailbox-local'",
    '  config:',
    `    path: ${JSON.stringify(env.storePath)}`,
    // The one-shot command line drives the runner through the startup
    // service; its lazy config reads whatever that invocation parsed.
    "- name: '@deepseek-ai/dsh-headless/startup'",
    "- name: '@deepseek-ai/dsh-headless'",
    '  inject: [headlessStartup]',
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    sessionName: !!js ctx.headlessStartup.sessionName',
    '    format: !!js ctx.headlessStartup.format',
    '    mailboxNamespace: !!js ctx.headlessStartup.mailboxNamespace',
    ...options.extraRows ?? [],
    '',
  ]
  await writeFile(configPath, rows.join('\n'))

  const adapter = new ScriptedAdapter(options.responses)
  const globals = globalThis as unknown as { __mailboxCompositionRegisterModel?: ((ctx: ContextType) => void) | undefined }
  globals.__mailboxCompositionRegisterModel = (ctx: ContextType) => {
    ctx.llm.registerAdapter(['mock'], adapter)
  }

  const originalInternals = { ...headlessInternals }
  if (options.capture !== undefined) {
    Object.assign(headlessInternals, {
      stdout: { write: (chunk: string) => { options.capture!.stdout.push(chunk); return true } },
      stderr: { write: (chunk: string) => { options.capture!.stderr.push(chunk); return true } },
    })
  }

  const ctx = new Context()
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.baseUrl = pathToFileURL(configDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-mailbox', MailboxRegistry],
    ['@deepseek-ai/dsh-mailbox-local', MailboxLocal],
    ['@deepseek-ai/dsh-mailbox-bridge', bridge],
    ['@deepseek-ai/dsh-headless', HeadlessRunnerModule],
    ['@deepseek-ai/dsh-headless/startup', HeadlessStartupModule],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      // Workspace plugins resolve to source through the map; local fixture
      // rows are plain file URLs the browser-grade resolver handles natively.
      if (modules.has(specifier)) return modules.get(specifier)
      if (specifier.startsWith('file:')) return import(specifier) as Promise<unknown>
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  let exitCode = 0
  let exitSignal: ((code: number) => void) | undefined
  const exited = options.args !== undefined
    ? new Promise<number>((resolve) => { exitSignal = resolve })
    : Promise.resolve(0)

  // The launcher must exist BEFORE the tree mounts: the runner refuses to
  // start without its appExit host value.
  if (options.args !== undefined) {
    provideCmdline(ctx, {
      args: options.args,
      exit: (code: number) => exitSignal?.(code),
    })
  }

  try {
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    // Quiescence first mirrors the shipping composition recipe: every apply,
    // including the runner's own self-wait on it, completes before callers'
    // conditions are even consulted. Poll-driven trees opt out.
    if (options.awaitQuiescence !== false) {
      await ctx.loader.await()
    }
    await Promise.all([
      options.settled(),
      options.args !== undefined && options.awaitQuiescence !== false
        ? exited.then((code) => { exitCode = code })
        : Promise.resolve(),
    ])
    // One scheduler turn so late microtasks finish before teardown.
    await new Promise<void>(resolve => { setTimeout(resolve, 25) })
  } finally {
    await ctx.fiber.dispose()
    if (options.capture !== undefined) Object.assign(headlessInternals, originalInternals)
  }
  return { code: exitCode, adapter }
}

describe('mailbox delivery over real compositions', () => {
  it(
    'cold-resumes a dormant named session when the bridge drains its queue',
    { timeout: 180_000 },
    async () => {
      const env = makeEnv()

      // Phase 1 — an ordinary named run persists the log; nothing consumes mail yet.
      const capture = { stdout: [] as string[], stderr: [] as string[] }
      const warmup = await boot(env, {
        responses: ['warm reply'],
        args: ['--session-name', 'hook-target', 'warmup task'],
        capture,
        settled: async () => {},
      })
      expect(warmup.code,
        `phase1 diagnostics: stdout=${JSON.stringify(capture.stdout)} stderr=${JSON.stringify(capture.stderr)} requests=${warmup.adapter.requests.length}`,
      ).toBe(0)
      expect(warmup.adapter.requests.length,
        `phase1 had no model traffic; stdout=${JSON.stringify(capture.stdout)}`,
      ).toBeGreaterThanOrEqual(1)

      const id = await seed(env.storePath, 'comp:hook-target')

      // Phase 2 — the bridge claims the seeded mail and resumes the dormant log.
      const second = await boot(env, {
        responses: ['reply after wake'],
        awaitQuiescence: false,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses: ["comp:hook-target"]',
          '    pollIntervalMs: 10',
        ],
        settled: async () => {
          // Admission settles before the delivered turn streams; give the
          // resumed agent's model exchange one bounded beat so the scripted
          // adapter records the request before teardown disposes the tree.
          await until(() => storedState(env.storePath, id) === 'done')
          await new Promise<void>(resolve => { setTimeout(resolve, 400) })
        },
      })

      const mailboxMessages = second.adapter.requests
        .flatMap(request => request.messages)
        .filter(message => (message as { source?: { kind?: string } }).source?.kind === 'mailbox')
      expect(mailboxMessages.length).toBeGreaterThanOrEqual(1)
      const mail = mailboxMessages[0] as {
        source: { form: string; address: string; from: string; messageId: string }
        content: readonly [{ type: string; text: string }]
      }
      expect(mail.source).toMatchObject({
        form: 'relay', address: 'comp:hook-target', from: 'comp:sender', messageId: id,
      })
      expect(mail.content[0]?.text).toBe('wake up')
    },
  )

  it(
    'admits queued backlog ahead of the task turn via the served-address hook',
    { timeout: 180_000 },
    async () => {
      const env = makeEnv()
      const id = await seed(env.storePath, 'comp:hook-drain')
      const capture = { stdout: [] as string[], stderr: [] as string[] }

      const run = await boot(env, {
        responses: ['backlog reply', 'final task reply'],
        args: ['--session-name', 'hook-drain', 'final task', '--mailbox-namespace', 'comp'],
        capture,
        settled: async () => {},
      })

      expect(run.code).toBe(0)
      expect(capture.stdout.join('')).toContain('final task reply')
      const firstTurnMessages = run.adapter.requests[0]?.messages ?? []
      const delivered = firstTurnMessages.at(-1) as {
        source?: { kind?: string; form?: string; messageId?: string }
        content?: readonly [{ type: string; text: string }]
      }
      expect(delivered?.source).toMatchObject({ kind: 'mailbox', form: 'relay', messageId: id })
      expect(delivered?.content?.[0]?.text).toBe('wake up')
      const taskMessage = run.adapter.requests.at(-1)?.messages.at(-1) as {
        content?: readonly [{ type: string; text: string }]
      }
      expect(taskMessage?.content?.[0]?.text).toBe('final task')
    },
  )
})
