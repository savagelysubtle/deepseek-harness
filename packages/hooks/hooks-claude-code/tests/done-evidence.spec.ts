import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Coverage for the done-evidence prerequisites: `last_assistant_message` on
 * the Stop and SubagentStop payloads (so a done-evidence hook has a claim to
 * judge), and the `stop_hook_active` loop guard (so a refusing Stop hook
 * cannot trap an agent forever). Full-loop style like `bridge.spec.ts` for the
 * Stop cases — the payload depends on real turn/step session events — and the
 * synthetic-emit style like `coverage-cases.ts` for the SubagentStop cases,
 * which need only the observe-only listener, not a live child.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hc-evidence-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}
/**
 * The shell snippet a capture script uses to land its payload: write to a
 * same-directory temp file, then `mv -f` it onto the final path so a
 * concurrent reader never observes the file mid-write (empty or partial).
 */
function captureCmd(cap: string): string {
  return `cat > "${cap}.tmp.$$"\nmv -f "${cap}.tmp.$$" "${cap}"`
}

async function harness(configPath: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }

/** Poll until `predicate` holds or the deadline passes (detached hooks resolve on a `.then`). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

/**
 * A model response with NO content blocks at all — no `block-start`/`block-end`
 * of any kind, just usage + finish. `BlockAssembler.blocks()` returns `[]` for
 * this, so the appended `assistant/message` carries empty content: the
 * "no final assistant message" case `finalAssistantOutput` must fall through.
 */
function emptyResponse(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('hooks-claude-code — Stop payload: last_assistant_message', () => {
  it('a completed turn\'s final assistant text reaches last_assistant_message', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('the real answer, with a count of 3 tests passing')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { last_assistant_message?: string }
    expect(payload.last_assistant_message).toBe('the real answer, with a count of 3 tests passing')
  })

  it('a step with no content blocks omits last_assistant_message (never the literal "undefined")', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([emptyResponse()])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    const raw = readFileSync(cap, 'utf8')
    expect(raw).not.toContain('undefined')
    const payload = JSON.parse(raw) as Record<string, unknown>
    expect('last_assistant_message' in payload).toBe(false)
  })
})

describe('hooks-claude-code — Stop payload: stop_hook_active loop guard', () => {
  it('is false on the first stop, true after a forced continuation, and resets on the next turn\'s unrefused stop', async () => {
    // Denies only its FIRST invocation (forcing one continuation), then allows
    // every later one — so a THIRD invocation, on a fresh turn, proves the
    // counter reset rather than staying stuck at "active".
    const d = dir()
    const counter = join(d, 'counter')
    const captureDir = join(d, 'captures')
    const s = sh(d, 'stop.sh', `#!/usr/bin/env bash
mkdir -p "${captureDir}"
if [ -e "${counter}" ]; then N=$(cat "${counter}"); else N=0; fi
N=$((N+1))
echo "$N" > "${counter}"
cat > "${captureDir}/stop-$N.json.tmp.$$"
mv -f "${captureDir}/stop-$N.json.tmp.$$" "${captureDir}/stop-$N.json"
if [ "$N" -eq 1 ]; then
  echo "one more pass please" >&2
  exit 2
fi
exit 0
`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('first claim'), textResponse('second claim'), textResponse('third claim')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    // Turn A: denied once → forced continuation → a second step ran, then the
    // hook allowed and the turn stopped.
    expect(adapter.requests).toHaveLength(2)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go again' }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    // Turn B: a brand-new turn, one more model step.
    expect(adapter.requests).toHaveLength(3)

    const stop1 = JSON.parse(readFileSync(join(captureDir, 'stop-1.json'), 'utf8')) as { stop_hook_active: boolean; last_assistant_message?: string }
    const stop2 = JSON.parse(readFileSync(join(captureDir, 'stop-2.json'), 'utf8')) as { stop_hook_active: boolean; last_assistant_message?: string }
    const stop3 = JSON.parse(readFileSync(join(captureDir, 'stop-3.json'), 'utf8')) as { stop_hook_active: boolean; last_assistant_message?: string }

    expect(stop1.stop_hook_active).toBe(false) // never forced before
    expect(stop1.last_assistant_message).toBe('first claim')

    expect(stop2.stop_hook_active).toBe(true) // follows the forced continuation above
    expect(stop2.last_assistant_message).toBe('second claim')

    expect(stop3.stop_hook_active).toBe(false) // reset: turn A's stop-2 was NOT refused
    expect(stop3.last_assistant_message).toBe('third claim')
  }, 15_000)

  it('caps consecutive forced continuations at 8, then lets the agent stop and warns', async () => {
    const d = dir()
    // Refuses on EVERY invocation — proves the guard, not the script, ends the loop.
    const s = sh(d, 'stop.sh', '#!/usr/bin/env bash\necho "always refuse" >&2\nexit 2\n')
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    // 1 initial step + up to 8 forced continuations = 9 possible model steps.
    const adapter = new MockAdapter(Array.from({ length: 9 }, (_v, i) => textResponse(`claim ${i}`)))
    const ctx = await harness(path, adapter)
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(agent)

    // The cap, not script exhaustion, ended the loop: exactly 9 requests, never
    // a 10th (which would throw "script exhausted" inside the adapter and fail
    // the turn instead of completing it).
    expect(adapter.requests).toHaveLength(9)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('8 consecutive'))
    // The turn actually stopped (no unresolved forced continuation left pending).
    expect(events(agent).filter(e => e.type === 'turn/end')).toHaveLength(1)
  }, 15_000)
})

describe('hooks-claude-code — SubagentStop payload: last_assistant_message', () => {
  it('joins the end info\'s text content blocks into one plain string', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'sa.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooks(d, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    ctx.emit(subagentCarrier(ctx), 'subagent/end', {
      runId: SubagentRunId('run-text'),
      provider: 'inproc',
      id: SessionId('child-text'),
      local: false,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'partial ' }, { type: 'text', text: 'answer' }],
    })
    await waitFor(() => {
      try { readFileSync(cap, 'utf8'); return true } catch { return false }
    })

    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { last_assistant_message?: string }
    expect(payload.last_assistant_message).toBe('partial answer')
  })

  it('omits last_assistant_message when the end info carries none', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'sa.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooks(d, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    ctx.emit(subagentCarrier(ctx), 'subagent/end', {
      runId: SubagentRunId('run-none'),
      provider: 'inproc',
      id: SessionId('child-none'),
      local: false,
      stopReason: 'completed',
      // lastAssistantMessage deliberately absent (e.g. infrastructure rejection).
    })
    await waitFor(() => {
      try { readFileSync(cap, 'utf8'); return true } catch { return false }
    })

    const raw = readFileSync(cap, 'utf8')
    expect(raw).not.toContain('undefined')
    const payload = JSON.parse(raw) as Record<string, unknown>
    expect('last_assistant_message' in payload).toBe(false)
  })

  it('omits last_assistant_message when the end info has only non-text blocks (not stringified)', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'sa.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooks(d, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    ctx.emit(subagentCarrier(ctx), 'subagent/end', {
      runId: SubagentRunId('run-reasoning'),
      provider: 'inproc',
      id: SessionId('child-reasoning'),
      local: false,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'reasoning', text: 'internal thoughts only' }],
    })
    await waitFor(() => {
      try { readFileSync(cap, 'utf8'); return true } catch { return false }
    })

    const raw = readFileSync(cap, 'utf8')
    expect(raw).not.toContain('internal thoughts only')
    const payload = JSON.parse(raw) as Record<string, unknown>
    expect('last_assistant_message' in payload).toBe(false)
  })
})
