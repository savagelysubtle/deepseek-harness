import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as contextPressure from '../src/index.ts'
import { parseWarningText } from '../src/warning.ts'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const WINDOW = 100_000
// Declared provider usage anchors the meter at exactly input + output = 32_000;
// the tiny composed envelope never heuristic-prices above it.
const TURN_USAGE: TokenUsage = { inputTokens: 30_000, outputTokens: 2_000 }

class WindowedUsageAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: WINDOW } })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Fully framed text keeps the usage-anchor's reassembled pricing equal to
    // the durable assistant pricing, so the measured total stays exact.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'acknowledged' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'acknowledged' } }
    yield { type: 'usage', usage: { ...TURN_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-context-pressure-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-token-meter'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-context-pressure'",
    '  config:',
    '    thresholds: [0.25]',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-context-pressure', contextPressure],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

function isPluginWarning(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'context-pressure'
}

function warningEvents(session: Session): SessionEvent<'user/message'>[] {
  return session.events.filter(isPluginWarning)
}

function warningText(event: SessionEvent<'user/message'>): string {
  return event.data.content.find(block => block.type === 'text')?.text ?? ''
}

function followUp(agent: ReturnType<AgentLoop['create']>, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('context-pressure real Loader composition through cordis.yml', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('boots beside the shipping loop, appends one durable warning past 25%, and dedups later steps', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agentLoop).toBeInstanceOf(AgentLoop)
    expect(loaded.tokenMeter).toBeInstanceOf(TokenMeter)

    loaded.llm.registerAdapter(['mock'], new WindowedUsageAdapter())
    const agent = loaded.agentLoop.create(SessionId('loader-context-pressure'), { provider: 'mock', model: 'mock' })

    // Turn 1: no request/header exists when its pre-step measures, so nothing fires.
    followUp(agent, 'turn one')
    await agent.whenIdle()
    expect(warningEvents(agent.session)).toHaveLength(0)

    // Turn 2: the routed header plus anchored usage 32_000/100_000 has crossed
    // the configured 25% threshold; exactly one durable warning joins the step.
    // The measured total is 32_010, not the anchor's 32_000: the entering
    // turn's own waking user message is already a durable surface event when
    // the pre-step measures, pricing ceil(8/4) + 4 block + 4 role tokens.
    followUp(agent, 'turn two')
    await agent.whenIdle()
    const fired = warningEvents(agent.session)
    expect(fired).toHaveLength(1)
    const warning = fired[0]!
    const text = warningText(warning)
    expect(text).toBe(
      'Context pressure notice: usage passed the 25% threshold '
      + `of this model's context window: 32010 of ${WINDOW} tokens in use `
      + '(32.01%); 67990 tokens remain.\n'
      + 'Before rising pressure forces automatic compaction, you can request compaction yourself '
      + 'with the compact tool.',
    )
    expect(parseWarningText(text)).toEqual({
      thresholdPercent: '25',
      usedPercent: '32.01',
      totalTokens: 32_010,
      contextWindow: WINDOW,
      remainingTokens: 67_990,
    })
    expect(warning.data.source).toEqual({
      kind: 'plugin',
      plugin: 'context-pressure',
      form: 'snapshot',
      sections: [{ name: 'context-pressure', text }],
    })
    // Durable position: inside an entering step, ahead of that step's request
    // work; the loop logs no new request/header when routing is unchanged.
    const warningIndex = agent.session.events.indexOf(warning)
    const stepStartIndex = agent.session.events.slice(0, warningIndex).findLastIndex(
      event => event.type === 'step/start',
    )
    expect(stepStartIndex).toBeGreaterThan(-1)
    const beforeWarning = agent.session.events.slice(stepStartIndex + 1, warningIndex)
    expect(beforeWarning.some(event => event.type === 'request/header')).toBe(false)
    // The warning-bearing step went on to complete a real model request.
    expect(agent.session.events.slice(warningIndex + 1).some(
      event => event.type === 'assistant/message',
    )).toBe(true)
    // Model-visible: the projected history carries the warning into the request.
    expect(agent.session.deriveMessages().some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === text))).toBe(true)

    // Turn 3: the warned threshold stays deduplicated for the generation.
    followUp(agent, 'turn three')
    await agent.whenIdle()
    expect(warningEvents(agent.session)).toHaveLength(1)
  })
})
