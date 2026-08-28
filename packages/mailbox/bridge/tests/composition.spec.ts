/**
 * Real-composition delivery flows over real Loader trees with only the model
 * mocked: a dormant named session cold-resumes when the bridge drains a seeded
 * SQLite queue into it, and the headless served-address hook admits queued
 * mail ahead of its own task turn.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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
import { deriveNamedSessionId } from '@deepseek-ai/dsh-named-sessions'
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

/**
 * The scripted model behind one finished boot. A boot without an explicit
 * `adapter` option always registers this spec's own ScriptedAdapter, so
 * asserting through its request log needs the concrete class; a stray
 * explicit-adapter boot fails loud instead of misreading its traffic.
 * @param outcome - the completed boot outcome to inspect.
 * @returns that boot's ScriptedAdapter instance.
 */
function scriptedAdapterOf(outcome: BootOutcome): ScriptedAdapter {
  if (!(outcome.adapter instanceof ScriptedAdapter)) {
    throw new Error('composition test bug: expected the spec-local scripted adapter')
  }
  return outcome.adapter
}

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
async function seed(storePath: string, address: string, from = 'sender'): Promise<string> {
  const store = new SqliteMailboxStore(openMailboxDatabase(storePath))
  const id = await store.publish({ to: address as never, from, subject: 'wake up' })
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
async function until(holds: () => boolean, budgetMs = 120_000): Promise<void> {
  const started = Date.now()
  while (!holds()) {
    if (Date.now() - started > budgetMs) throw new Error('composition condition never settled')
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
  }
}

interface BootOptions {
  /** Extra yml rows beyond the shared agent stack and mailbox pair. */
  readonly extraRows?: readonly string[]
  /** Externally owned adapter override (steer probe holds streams itself). */
  readonly adapter?: LlmAdapter
  /** The scripted model answers, consumed per streamed request; unused when `adapter` overrides. */
  readonly responses?: readonly string[]
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
  adapter: LlmAdapter | ScriptedAdapter
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

  const adapter = options.adapter ?? new ScriptedAdapter(options.responses ?? [])
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
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
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
      const warmupScripted = scriptedAdapterOf(warmup)
      expect(warmup.code,
        `phase1 diagnostics: stdout=${JSON.stringify(capture.stdout)} stderr=${JSON.stringify(capture.stderr)} requests=${warmupScripted.requests.length}`,
      ).toBe(0)
      expect(warmupScripted.requests.length,
        `phase1 had no model traffic; stdout=${JSON.stringify(capture.stdout)}`,
      ).toBeGreaterThanOrEqual(1)

      const id = await seed(env.storePath, 'hook-target')

      // Phase 2 — the bridge claims the seeded mail and resumes the dormant log.
      const secondAdapter = new ScriptedAdapter(['reply after wake'])
      await boot(env, {
        adapter: secondAdapter,
        awaitQuiescence: false,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses: ["hook-target"]',
          '    pollIntervalMs: 10',
          '    admitFrom:',
          '      - sender',
        ],
        settled: async () => {
          // Admission settles before the delivered turn streams; wait for the
          // scripted model to record the woken exchange itself — a fixed beat
          // races teardown under aggregate-run contention.
          await until(() => storedState(env.storePath, id) === 'done')
          await until(() => secondAdapter.requests.some(request =>
            request.messages.some(message =>
              (message as { source?: { kind?: string } }).source?.kind === 'mailbox')))
        },
      })

      const mailboxMessages = secondAdapter.requests
        .flatMap(request => request.messages)
        .filter(message => (message as { source?: { kind?: string } }).source?.kind === 'mailbox')
      expect(mailboxMessages.length).toBeGreaterThanOrEqual(1)
      const mail = mailboxMessages[0] as {
        source: { form: string; address: string; from: string; messageId: string }
        content?: ReadonlyArray<{ type: string; text?: string }>
      }
      expect(mail.source).toMatchObject({
        form: 'relay', address: 'hook-target', from: 'sender', messageId: id,
      })
      expect(mail.content?.[0]?.text).toBe('wake up')
    },
  )

  it(
    'settles guest-origin mail sender-not-admitted by default and delivers it once the roster opts in',
    { timeout: 240_000 },
    async () => {
      // Fail-closed composition (no admitFrom): the bridge settles
      // the guest row terminal WITHOUT waking or resuming anything.
      const envA = makeEnv()
      await boot(envA, {
        responses: ['warm reply'],
        args: ['--session-name', 'hook-gate', 'warmup task'],
        settled: async () => {},
      })
      const rejectedId = await seed(envA.storePath, 'hook-gate', 'council')
      await boot(envA, {
        responses: [],
        awaitQuiescence: false,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses: ["hook-gate"]',
          '    pollIntervalMs: 10',
        ],
        settled: () => until(() => storedState(envA.storePath, rejectedId) === 'failed'),
      })
      expect(storedState(envA.storePath, rejectedId)).toBe('failed')

      // Opted-in composition: the same guest origin delivers like any colleague.
      const envB = makeEnv()
      await boot(envB, {
        responses: ['warm reply'],
        args: ['--session-name', 'hook-gate', 'warmup task'],
        settled: async () => {},
      })
      const admittedId = await seed(envB.storePath, 'hook-gate', 'council')
      const secondAdapter = new ScriptedAdapter(['reply after guest wake'])
      await boot(envB, {
        adapter: secondAdapter,
        awaitQuiescence: false,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses: ["hook-gate"]',
          '    pollIntervalMs: 10',
          '    admitFrom: ["council"]',
        ],
        settled: async () => {
          // Same observed-delivery condition as the cold-resume case: settle
          // alone does not prove the resumed turn reached the scripted model.
          await until(() => storedState(envB.storePath, admittedId) === 'done')
          await until(() => secondAdapter.requests.some(request =>
            request.messages.some(message =>
              (message as { source?: { kind?: string } }).source?.kind === 'mailbox')))
        },
      })
      const mailboxMessages = secondAdapter.requests
        .flatMap(request => request.messages)
        .filter(message => (message as { source?: { kind?: string } }).source?.kind === 'mailbox')
      expect(mailboxMessages.length).toBeGreaterThanOrEqual(1)
      const mail = mailboxMessages[0] as {
        source: { address: string; from: string; messageId: string }
      }
      expect(mail.source).toMatchObject({
        address: 'hook-gate', from: 'council', messageId: admittedId,
      })
      expect(storedState(envB.storePath, admittedId)).toBe('done')
    },
  )

  it(
    'routes sender mail into a running seat immediately without aborting held generation',
    { timeout: 240_000 },
    async () => {
      const env = makeEnv()
      let released = false

      class HeldFirstAdapter extends LlmAdapter {
        readonly requests: GenerateOptions[] = []
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          this.requests.push(options)
          const holdsWork = !options.messages.some(message =>
            (message as { source?: { kind?: string } }).source?.kind === 'mailbox')
          while (holdsWork && !released && !options.signal?.aborted) {
            await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
          }
          const text = options.signal?.aborted ? 'held work output (aborted)' : holdsWork ? 'held work output' : 'post-wake reply'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      const heldAdapter = new HeldFirstAdapter()

      const run = await boot(env, {
        responses: [],
        args: ['--session-name', 'steer-live', 'held task'],
        adapter: heldAdapter,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses: ["steer-live"]',
          '    pollIntervalMs: 10',
          '    admitFrom:',
          '      - sender',
        ],
        settled: async () => {
          // Nothing pre-published: against a session whose runner has not
          // registered yet, the inline mount drain would (correctly) settle
          // mail `unknown-address`. Hold first…
          await until(() => heldAdapter.requests.length === 1)
          // …then publish mid-generation; the next drain STEERs it into the
          // live turn within one poll beat even though the seat stays busy.
          const mailedId = await seed(env.storePath, 'steer-live')
          try {
            await until(() => storedState(env.storePath, mailedId) === 'done')
          } catch {
            const db = new DatabaseSync(env.storePath)
            const rows = db.prepare('SELECT state, result FROM messages WHERE id = ?').all(mailedId)
            db.close()
            throw new Error(`mail ${mailedId} unsettled: rows=${JSON.stringify(rows)} reqs=${heldAdapter.requests.length}`)
          }
          released = true
        },
      })
      expect(run.code).toBe(0)

      const kinds = heldAdapter.requests.map(request =>
        ((request.messages.at(-1) as { source?: { kind?: string } }).source?.kind ?? 'user'))
      expect(kinds).toEqual(['user', 'mailbox'])

      const mail = heldAdapter.requests
        .flatMap(request => request.messages)
        .find(message => (message as { source?: { kind?: string } }).source?.kind === 'mailbox') as {
          content?: ReadonlyArray<{ type: string; text?: string }>
        } | undefined
      expect(mail?.content?.[0]?.text).toBe('wake up')

      const db = new DatabaseSync(env.storePath)
      const bounces = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE type = 'bounce'").get() as { n: number }
      db.close()
      expect(bounces.n).toBe(0)

      // NOTHING aborted: held generation completed on its own terms. The
      // jsonl root mixes files and per-session directories — read files only.
      const logText = readdirSync(env.sessionsRoot)
        .map(entry => join(env.sessionsRoot, String(entry)))
        .filter(path => statSync(path).isFile())
        .map(path => readFileSync(path, 'utf8'))
        .join('')
      expect(logText.includes('"kind":"aborted"')).toBe(false)
    },
  )

  it(
    'wakes an idle aliased web-seat session through a real yml-configured bridge',
    { timeout: 240_000 },
    async () => {
      // Chair post-land scenario verbatim: warmup persists the seat's REAL
      // session; the patch row aliases a WEB namespace address to that exact
      // id; mail published while the seat is IDLE cold-resumes and steers it.
      const env = makeEnv()
      const warmup = await boot(env, {
        responses: ['warm reply'],
        args: ['--session-name', 'gotham-seat', 'warmup task'],
        settled: async () => {},
      })
      expect(warmup.code).toBe(0)

      const aliasedId = deriveNamedSessionId('gotham-seat')
      const id = await seed(env.storePath, 'alfred', 'console')

      const run = await boot(env, {
        responses: ['seat wake reply'],
        awaitQuiescence: false,
        extraRows: [
          "- name: '@deepseek-ai/dsh-mailbox-bridge'",
          '  config:',
          '    addresses:',
          '      - alfred',
          '    pollIntervalMs: 10',
          '    admitFrom:',
          '      - console',
          '    seatAliases:',
          '      - address: alfred',
          '        sessionId: ' + JSON.stringify(String(aliasedId)),
        ],
        settled: () => until(() => storedState(env.storePath, id) === 'done'),
      })

      const mailboxMessages = scriptedAdapterOf(run).requests
        .flatMap(request => request.messages)
        .filter(message => (message as { source?: { kind?: string } }).source?.kind === 'mailbox')
      expect(mailboxMessages.length).toBeGreaterThanOrEqual(1)
      const mail = mailboxMessages[0] as {
        source: { address: string; from: string; messageId: string }
        content?: ReadonlyArray<{ type: string; text?: string }>
      }
      expect(mail.source).toMatchObject({
        address: 'alfred', from: 'console', messageId: id,
      })
      expect(mail.content?.[0]?.text).toBe('wake up')
    },
  )
})
