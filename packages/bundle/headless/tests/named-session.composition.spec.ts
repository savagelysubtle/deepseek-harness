/**
 * Real-composition named-session flow over a real Loader tree: the first run
 * creates the derived session through the shipping loop and persistence
 * backend, the second resumes it with prior context, and json mode emits
 * well-formed NDJSON lines. Only external services (the model) are mocked.
 */

import { mkdtempSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { afterEach, describe, expect, it } from 'vitest'
import * as runner from '../src/index.ts'
import { internals } from '../src/index.ts'
import * as startup from '../src/startup.ts'

const originalInternals = { ...internals }
let home: string | undefined
let sessionsRoot: string | undefined

afterEach(async () => {
  Object.assign(internals, originalInternals)
  delete process.env.DSH_HOME
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  if (sessionsRoot !== undefined) await rm(sessionsRoot, { recursive: true, force: true })
  home = undefined
  sessionsRoot = undefined
})

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

/** What one booted application reported. */
interface BootResult {
  code: number
  out: string
}

/**
 * Boot one full application over a real Loader tree and let the runner drive.
 * @param args - the invocation's inner command line.
 * @param adapter - the scripted model to register inside the tree.
 * @returns the requested exit code and captured stdout.
 */
async function boot(args: readonly string[], adapter: ScriptedAdapter): Promise<BootResult> {
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-headless-comp-config-'))
  const mockPath = join(configDir, 'mock-model.mjs')
  await writeFile(mockPath, [
    'export const name = "test-mock-model"',
    'export const inject = ["llm"]',
    'export function apply(ctx) { globalThis.__headlessCompositionRegisterModel(ctx) }',
    '',
  ].join('\n'))
  const configPath = join(configDir, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(sessionsRoot!)}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    `- name: ${JSON.stringify(pathToFileURL(mockPath).href)}`,
    "- name: '@deepseek-ai/dsh-headless/startup'",
    "- name: '@deepseek-ai/dsh-headless'",
    '  inject: [headlessStartup]',
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    sessionName: !!js ctx.headlessStartup.sessionName',
    '    format: !!js ctx.headlessStartup.format',
    '',
  ].join('\n'))

  const globals = globalThis as unknown as {
    __headlessCompositionRegisterModel: (ctx: ContextType) => void
  }
  globals.__headlessCompositionRegisterModel = (ctx: ContextType) => {
    ctx.llm.registerAdapter(['mock'], adapter)
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
    ['@deepseek-ai/dsh-headless/startup', startup],
    ['@deepseek-ai/dsh-headless', runner],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      // Workspace plugins resolve to source through the map; local fixture
      // rows are plain file URLs the browser-grade resolver handles natively.
      if (modules.has(specifier)) return modules.get(specifier)
      if (specifier.startsWith('file:')) {
        return import(specifier) as Promise<unknown>
      }
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  let observed = ''
  internals.stdout = { write: (chunk: string) => { observed += chunk; return true } }
  internals.stderr = { write: (chunk: string) => { observed += chunk; return true } }
  const exited = new Promise<number>((resolve) => {
    provideCmdline(ctx, {
      args,
      exit: resolve,
    })
  })

  try {
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    return { code: await exited, out: observed }
  } finally {
    await ctx.fiber.dispose()
    delete (globalThis as { __headlessCompositionRegisterModel?: unknown }).__headlessCompositionRegisterModel
  }
}

describe('named sessions over the real composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution is slow enough to trip cold-cache budgets.
  it('creates on first run, resumes with prior context on the second, and streams NDJSON', { timeout: 60_000 }, async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-headless-comp-home-'))
    sessionsRoot = mkdtempSync(join(tmpdir(), 'dsh-headless-comp-sessions-'))
    process.env.DSH_HOME = home

    const first = new ScriptedAdapter(['first answer'])
    const firstRun = await boot(
      ['--session-name', 'comp-test', '--format', 'json', 'first task'],
      first,
    )
    expect(firstRun.code).toBe(0)
    const lines = firstRun.out.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    const firstLine = lines[0]
    if (firstLine === undefined) throw new Error('the json run produced no output line')
    const line = JSON.parse(firstLine) as {
      type: string
      sessionID: string
      part: { type: string; text: string }
    }
    expect(line.type).toBe('text')
    expect(line.sessionID).toMatch(/^named-[0-9a-f]{32}$/)
    expect(line.part).toEqual({ type: 'text', text: 'first answer' })
    const firstLastMessage = first.requests.at(-1)?.messages.at(-1)
    if (firstLastMessage === undefined) throw new Error('the first run produced no model message')
    expect(firstLastMessage).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'first task' }],
    })

    const second = new ScriptedAdapter(['second answer'])
    const secondRun = await boot(['--session-name', 'comp-test', 'second task'], second)
    expect(secondRun.code).toBe(0)
    expect(secondRun.out).toBe('second answer\n')
    const conversation = JSON.stringify(second.requests[0]?.messages)
    expect(conversation).toContain('first task')
    expect(conversation).toContain('first answer')
    const lastMessage = second.requests.at(-1)?.messages.at(-1)
    if (lastMessage === undefined) throw new Error('the resumed run produced no model message')
    expect(lastMessage).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'second task' }],
    })
  })
})
