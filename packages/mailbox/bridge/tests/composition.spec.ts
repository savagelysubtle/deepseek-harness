/**
 * Real-composition delivery flows over real Loader trees with only the model
 * mocked: a dormant named session cold-resumes when the bridge drains a seeded
 * SQLite queue into it, and the headless served-address hook admits queued
 * mail ahead of its own task turn.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { deriveNamedSessionId, namedLockPath } from '@deepseek-ai/dsh-named-sessions'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import MailboxLocal, { openMailboxDatabase, SqliteMailboxStore } from '@deepseek-ai/dsh-mailbox-local'
import * as HeadlessRunnerModule from '../../../bundle/headless/src/index.ts'
import * as HeadlessStartupModule from '../../../bundle/headless/src/startup.ts'
import * as bridge from '../src/index.ts'

/**
 * A throwaway org registry for one test file.
 *
 * The bridge defaults to `~/.dsh/org/registry.yml` when no path is configured.
 * A test that falls back to it reads — and could mutate — the operator's live
 * roster, which is both a flake source and a real hazard.
 */
let cachedRegistryPath: string | undefined
function testRegistryPath(): string {
  if (cachedRegistryPath !== undefined) return cachedRegistryPath
  const dir = mkdtempSync(join(tmpdir(), 'dsh-composition-registry-'))
  const path = join(dir, 'registry.yml')
  const seats = ['hook-target', 'hook-gate', 'target', 'gotham-seat']
  // Seat tool-restriction fixtures, alongside the fixture tools every boot
  // registers (see FIXTURE_TOOL_NAMES below): 'tool-open' carries no `tools`
  // field at all (the unconfigured-by-default case), 'tool-narrow' allows
  // only one real registered tool, and 'tool-degraded' allows a name that is
  // never registered — the degrade-instead-of-crash case.
  const toolSeats = [
    '  tool-open: { cwd: . }',
    '  tool-narrow: { cwd: ., tools: { allow: [alpha-tool] } }',
    '  tool-degraded: { cwd: ., tools: { allow: [ghost-tool] } }',
  ]
  writeFileSync(
    path,
    `baseDir: ${dir}\nseats:\n${seats.map(seat => `  ${seat}: { cwd: . }`).join('\n')}\n${toolSeats.join('\n')}\nedges: []\n`,
    'utf8',
  )
  cachedRegistryPath = path
  return path
}

/** Global tool names every `boot()` registers, for the seat tool-restriction tests below. */
const FIXTURE_TOOL_NAMES = ['alpha-tool', 'beta-tool', 'gamma-tool'] as const


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

/**
 * Concatenate every jsonl session log file under one sessions root,
 * recursively — the jsonl backend groups sessions under a project-keyed
 * subdirectory (or `_no-cwd`), so a cold-provisioned seat's log is never at
 * the root itself.
 * @param root - the sessions root a boot's `env.sessionsRoot` names.
 */
function allSessionLogText(root: string): string {
  return readdirSync(root, { recursive: true })
    .map(entry => join(root, String(entry)))
    .filter(path => statSync(path).isFile())
    .map(path => readFileSync(path, 'utf8'))
    .join('')
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
  /**
   * Resolves once the boot may dispose (run exited / delivery observed). The
   * live composed context is handed through so a caller can inspect the real
   * registries before teardown, rather than inferring state from request
   * traffic alone — e.g. `ctx.agents.get(id).ctx.tools.schemas(scopeOf(agent.ctx))`;
   * `schemas()` with no scope argument reads the GLOBAL unscoped view, not
   * what one agent's restriction narrows it to.
   */
  readonly settled: (ctx: ContextType) => Promise<void>
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

  // Fixture tools every boot registers globally, so a seat tool-restriction
  // test can prove real narrowing against the actual tool registry instead of
  // asserting only the helper's returned outcome. Inert for every other test
  // in this file: nothing else names these tools or asserts an exact schema
  // list.
  //
  // Rows in one `cordis:include` config mount CONCURRENTLY (the loader
  // `Promise.allSettled`s every row's own `create()`), so nothing guarantees
  // this plugin's registration loop finishes before a sibling row's `apply()`
  // runs — including the polling mailbox-bridge row, whose OWN `apply()`
  // forces one full inline delivery (and, for a tool-restricted seat, a
  // one-time read of `tools.schemas()`) before it even returns. A seat
  // created from that race reads back whatever the registry held at that
  // instant, permanently — unlike the model-adapter fixture below, an early
  // miss here cannot self-correct on a later poll. So this plugin PROVIDES a
  // marker service once registration completes, and the tool-restriction
  // seats' own bridge row below (`toolSeatBridgeRows`) injects it — a real
  // Cordis dependency edge, not a timing hope — so the bridge's row cannot
  // even start mounting until every fixture tool is genuinely on the
  // registry.
  const toolsFixturePath = join(configDir, 'fixture-tools.mjs')
  await writeFile(toolsFixturePath, [
    'export const name = "test-fixture-tools"',
    'export const inject = ["tools"]',
    'export function apply(ctx) {',
    `  for (const toolName of ${JSON.stringify(FIXTURE_TOOL_NAMES)}) {`,
    '    ctx.tools.register({',
    '      name: toolName,',
    '      description: `fixture tool ${toolName}`,',
    '      parameters: { type: "object", properties: {}, additionalProperties: false },',
    '      output: {',
    '        schema: { type: "object", properties: {}, additionalProperties: false },',
    '        render: () => [],',
    '      },',
    '      execute: async () => ({}),',
    '    })',
    '  }',
    '  ctx.provide("mailboxCompositionToolsFixtureReady", true)',
    '}',
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
    `- name: ${JSON.stringify(pathToFileURL(toolsFixturePath).href)}`,
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
      options.settled(ctx),
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
          // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
          // operator state is both flaky and a way to mutate it by accident.
          `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
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
      expect(mail.content?.[0]?.text).toMatch(/^\[.+ - from .+ \((?:seat|unverified)\)(?: · trace [0-9a-f-]+)?\]$/m)
      expect(mail.content?.[0]?.text).toContain('\n\nwake up')
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
          // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
          // operator state is both flaky and a way to mutate it by accident.
          `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
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
          // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
          // operator state is both flaky and a way to mutate it by accident.
          `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
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
          // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
          // operator state is both flaky and a way to mutate it by accident.
          `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
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
      expect(mail?.content?.[0]?.text).toMatch(/^\[.+ - from .+ \((?:seat|unverified)\)(?: · trace [0-9a-f-]+)?\]$/m)
      expect(mail?.content?.[0]?.text).toContain('\n\nwake up')

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
          // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
          // operator state is both flaky and a way to mutate it by accident.
          `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
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
      expect(mail.content?.[0]?.text).toMatch(/^\[.+ - from .+ \((?:seat|unverified)\)(?: · trace [0-9a-f-]+)?\]$/m)
      expect(mail.content?.[0]?.text).toContain('\n\nwake up')
    },
  )
})

/**
 * Config rows for one mailbox-bridge serving `address`, admitting the fixture
 * sender, over the tool-restriction seats {@link testRegistryPath} declares.
 * @param address - the served seat address.
 * @param options - `residencyIdleMs` override — 0 forces the bridge's own
 *   flush-and-dispose to complete inside the SAME drain that delivered the
 *   mail, which a durable-log assertion needs; the default (resident) is
 *   fine when only the in-memory model request is under test.
 */
function toolSeatBridgeRows(address: string, options: { readonly residencyIdleMs?: number } = {}): string[] {
  return [
    "- name: '@deepseek-ai/dsh-mailbox-bridge'",
    // Real Cordis dependency edge, not a timing hope: the fixture-tools
    // plugin above only provides this once every fixture tool is registered,
    // so this row's `apply()` — and the forced inline first drain inside it —
    // cannot start until the registry this test inspects is actually
    // populated. See the fixture-tools comment in `boot()` for the race this
    // closes.
    '  inject: [mailboxCompositionToolsFixtureReady]',
    '  config:',
    // Never the user's real ~/.dsh/org/registry.yml: a test that reads live
    // operator state is both flaky and a way to mutate it by accident.
    `    orgRegistryPath: ${JSON.stringify(testRegistryPath())}`,
    `    addresses: ["${address}"]`,
    '    pollIntervalMs: 10',
    '    admitFrom:',
    '      - sender',
    ...options.residencyIdleMs !== undefined ? [`    residencyIdleMs: ${options.residencyIdleMs}`] : [],
  ]
}

describe('seat tool-restriction over a real tool registry', () => {
  it(
    'narrows a restricted seat\'s live tool set against the real registry, never just the returned outcome',
    { timeout: 180_000 },
    async () => {
      const env = makeEnv()
      const id = await seed(env.storePath, 'tool-narrow')
      const adapter = new ScriptedAdapter(['ok'])
      await boot(env, {
        adapter,
        awaitQuiescence: false,
        extraRows: toolSeatBridgeRows('tool-narrow'),
        settled: async () => {
          await until(() => storedState(env.storePath, id) === 'done')
          await until(() => adapter.requests.length >= 1)
        },
      })
      const toolNames = (adapter.requests[0]?.tools ?? []).map(tool => tool.name).sort()
      expect(toolNames).toEqual(['alpha-tool'])
    },
  )

  it(
    'leaves an existing UNCONFIGURED seat\'s tool set identical to before — nobody is restricted by default',
    { timeout: 180_000 },
    async () => {
      // The founder's hard constraint this feature rests on: a seat that
      // never opted in must see exactly what it always saw. Compared against
      // the SAME fixture tool set the narrowed-seat test above restricts, so
      // "identical to before" means "every fixture tool, unfiltered" here.
      const env = makeEnv()
      const id = await seed(env.storePath, 'tool-open')
      const adapter = new ScriptedAdapter(['ok'])
      await boot(env, {
        adapter,
        awaitQuiescence: false,
        extraRows: toolSeatBridgeRows('tool-open'),
        settled: async () => {
          await until(() => storedState(env.storePath, id) === 'done')
          await until(() => adapter.requests.length >= 1)
        },
      })
      const toolNames = (adapter.requests[0]?.tools ?? []).map(tool => tool.name).sort()
      expect(toolNames).toEqual([...FIXTURE_TOOL_NAMES].sort())
    },
  )

  it(
    'degrades an allow-list naming a never-registered tool to the intersected set and logs a structured, findable notice',
    { timeout: 180_000 },
    async () => {
      const env = makeEnv()
      const id = await seed(env.storePath, 'tool-degraded')
      const adapter = new ScriptedAdapter(['ok'])
      const run = await boot(env, {
        adapter,
        awaitQuiescence: false,
        // residencyIdleMs: 0 — the bridge's own flush-and-dispose completes
        // inside the drain that delivered the mail, so the notice is
        // guaranteed on disk once the mailbox row settles `done`, rather than
        // racing this boot's teardown against a floating residency flush.
        extraRows: toolSeatBridgeRows('tool-degraded', { residencyIdleMs: 0 }),
        settled: async () => {
          await until(() => storedState(env.storePath, id) === 'done')
          await until(() => !existsSync(namedLockPath('tool-degraded')))
        },
      })
      expect(run.code).toBe(0)

      // The seat still boots and still runs its turn — degrading, never crashing.
      expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
      const toolNames = (adapter.requests[0]?.tools ?? []).map(tool => tool.name)
      expect(toolNames).toEqual([])

      // The structured notice is on disk, findable by an external tool
      // reading the log directly — the seat that would report this has, by
      // construction, no tools left to send mail with. A cold-provisioned
      // seat's log nests under a project-keyed subdirectory (the jsonl
      // backend groups by cwd), so the walk is recursive rather than
      // top-level-only.
      const logText = allSessionLogText(env.sessionsRoot)
      expect(logText).toContain('"kind":"mailbox-bridge-tool-restriction"')
      expect(logText).toContain('"degraded":true')
      expect(logText).toContain('"ghost-tool"')
      expect(logText).toContain('"seatName":"tool-degraded"')
    },
  )

  it(
    'a restricted seat\'s own subagent inherits the narrowing and cannot widen back out',
    { timeout: 180_000 },
    async () => {
      // A subagent is, in `@deepseek-ai/dsh-tools` terms, exactly a scope
      // whose parent chain (`@deepseek-ai/dsh-scope`) includes the spawning
      // agent's scope key — that is the ONE primitive `dsh-subagent`'s own
      // preset-join (`agentPresets.composeFrom`) rides to give a real child
      // its parent's composition. Minting that same parent-child scope
      // relationship directly here, with the real registered `ctx.tools`,
      // proves the chain-intersection behavior this change relies on but
      // never touches — without pulling in the whole subagent/preset stack
      // this minimal composition does not otherwise need.
      const env = makeEnv()
      const id = await seed(env.storePath, 'tool-narrow')
      const adapter = new ScriptedAdapter(['ok'])
      let parentTools: string[] = []
      let childTools: string[] = []
      let childToolsAfterWidenAttempt: string[] = []
      await boot(env, {
        adapter,
        awaitQuiescence: false,
        extraRows: toolSeatBridgeRows('tool-narrow'),
        settled: async (ctx) => {
          await until(() => storedState(env.storePath, id) === 'done')
          await until(() => adapter.requests.length >= 1)
          const agent = ctx.agents.get(deriveNamedSessionId('tool-narrow'))
          if (agent === undefined) {
            throw new Error('composition test bug: the restricted seat is not resident after delivery')
          }
          const parentScope = scopeOf(agent.ctx)
          if (parentScope === undefined) {
            throw new Error('composition test bug: the restricted seat carries no scope key to parent a child under')
          }
          // `schemas()` with no argument reads the GLOBAL unscoped view —
          // every production caller that wants what ONE scope sees passes
          // its scope key explicitly (e.g. the cordis-host-runner guard);
          // omitting it here would read back all three fixture tools
          // regardless of the seat's restriction and prove nothing.
          parentTools = agent.ctx.tools.schemas(parentScope).map(schema => schema.name).sort()

          // Minted from the PARENT's own scoped context, not the bare root
          // `ctx`: a scope's dependency-injection visibility (here, `.tools`)
          // is inherited from whichever context it was minted under, and only
          // `agent.ctx` — already proven to reach `.tools` above — carries
          // that entitlement forward to the child.
          const child = createScope(agent.ctx, { probe: 'tool-narrow-child' }, { parent: parentScope })
          try {
            const childScope = scopeOf(child.ctx)
            childTools = child.ctx.tools.schemas(childScope).map(schema => schema.name).sort()
            // The child tries to widen itself back to every fixture tool; an
            // ancestor's restriction still masks what a descendant scope
            // admits, so this must not grant back what the parent took away.
            child.ctx.tools.restrict({ allow: [...FIXTURE_TOOL_NAMES] })
            childToolsAfterWidenAttempt = child.ctx.tools.schemas(childScope).map(schema => schema.name).sort()
          } finally {
            await child.dispose()
          }
        },
      })
      expect(parentTools).toEqual(['alpha-tool'])
      expect(childTools).toEqual(['alpha-tool'])
      expect(childToolsAfterWidenAttempt).toEqual(['alpha-tool'])
    },
  )
})
