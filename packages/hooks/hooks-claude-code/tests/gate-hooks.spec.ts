import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * The in-harness gate-hook contract (OP-180 Slice C): control-plane gate scripts
 * (plan-gate / screenshot-gate / done-evidence) are unmodified Claude Code hooks,
 * so the bridge must hand them the harness tool name, a `file_path`, and the
 * session `cwd` on PreToolUse, honour only exit 2 as a refusal, and let a refusing
 * Stop hook force the turn to continue.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hc-gate-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooksFile(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}
/** Land stdin in `cap` atomically, so a reader never sees a partial payload. */
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

function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }

/** Register a recording stand-in for a harness file tool; `ran` flips when it executes. */
function registerFileTool(ctx: Context, name: string, pathKey: 'file_path' | 'path'): { ran: () => boolean } {
  let ran = false
  ctx.tools.register(defineContentToolFixture({
    name,
    description: 'file tool stand-in',
    parameters: { [pathKey]: { type: 'string', required: true, description: 'target' } },
    async execute() { ran = true; return [{ type: 'text', text: 'wrote' }] },
  }))
  return { ran: () => ran }
}

function prompt(agent: Agent, text = 'go'): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const EDIT_MATCHER = '^(Edit|Write|MultiEdit|NotebookEdit|edit|write|str_replace_editor)$'

describe('gate hooks — PreToolUse payload for harness file tools', () => {
  it('delivers tool_name "edit", file_path and cwd to a Claude-dialect script', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'gate.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooksFile(d, { PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: '/repo/src/components/Button.tsx' }),
      textResponse('done'),
    ])
    const ctx = await harness(path, adapter)
    const tool = registerFileTool(ctx, 'edit', 'file_path')
    // The factory honors meta.cwd, so the payload cwd is the session workspace.
    const workspace = dir()
    const handle = await ctx.agents.create({ sessionId: SessionId('a1'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'mock' } })
    const agent = handle.agent
    prompt(agent)
    await agent.whenIdle()

    expect(existsSync(cap)).toBe(true)
    const payload = JSON.parse(readFileSync(cap, 'utf8')) as {
      hook_event_name: string
      tool_name: string
      cwd: string
      tool_input: Record<string, unknown>
    }
    expect(payload.hook_event_name).toBe('PreToolUse')
    expect(payload.tool_name).toBe('edit')
    expect(payload.tool_input.file_path).toBe('/repo/src/components/Button.tsx')
    expect(payload.cwd).toBe(workspace)
    expect(tool.ran()).toBe(true)
    await handle.dispose()
  })

  it('aliases str_replace_editor\'s `path` to file_path and keeps `path`', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'gate.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooksFile(d, { PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'str_replace_editor', { path: '/repo/src/app.css' }),
      textResponse('done'),
    ])
    const ctx = await harness(path, adapter)
    registerFileTool(ctx, 'str_replace_editor', 'path')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent)
    await agent.whenIdle()

    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_name: string; tool_input: Record<string, unknown> }
    expect(payload.tool_name).toBe('str_replace_editor')
    expect(payload.tool_input.file_path).toBe('/repo/src/app.css')
    expect(payload.tool_input.path).toBe('/repo/src/app.css')
  })

  it('never overwrites an explicit file_path with the alias', async () => {
    const d = dir()
    const cap = join(d, 'payload')
    const s = sh(d, 'gate.sh', `#!/usr/bin/env bash\n${captureCmd(cap)}\n`)
    const path = hooksFile(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'both', { file_path: '/a', path: '/b' }),
      textResponse('done'),
    ])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'both',
      description: 'both keys',
      parameters: {
        file_path: { type: 'string', required: true, description: 'a' },
        path: { type: 'string', required: true, description: 'b' },
      },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent)
    await agent.whenIdle()

    const payload = JSON.parse(readFileSync(cap, 'utf8')) as { tool_input: Record<string, unknown> }
    expect(payload.tool_input.file_path).toBe('/a')
    expect(payload.tool_input.path).toBe('/b')
  })
})

describe('gate hooks — exit-code semantics', () => {
  it('exit 2 denies the tool and surfaces the stderr text to the agent', async () => {
    const d = dir()
    const s = sh(d, 'deny.sh', '#!/usr/bin/env bash\necho "PLAN-ATTACHED GATE REFUSED - OP-1 has no plan" >&2\nexit 2\n')
    // `$X` proves the command string is shell-expanded, so `$HOME`-relative paths work.
    const path = hooksFile(d, { PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: `X='${d}'; "$X/deny.sh"` }] }] })
    expect(existsSync(s)).toBe(true)
    const adapter = new MockAdapter([toolCallResponse('c1', 'write', { file_path: '/repo/src/ui/App.tsx' }), textResponse('done')])
    const ctx = await harness(path, adapter)
    const tool = registerFileTool(ctx, 'write', 'file_path')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent)
    await agent.whenIdle()

    expect(tool.ran()).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('PLAN-ATTACHED GATE REFUSED - OP-1 has no plan'))).toBe(true)
  })

  it('exit 1 does not deny (hooks block only on exit 2)', async () => {
    const d = dir()
    const s = sh(d, 'warn.sh', '#!/usr/bin/env bash\necho "gate script crashed" >&2\nexit 1\n')
    const path = hooksFile(d, { PreToolUse: [{ matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'edit', { file_path: '/repo/x.ts' }), textResponse('done')])
    const ctx = await harness(path, adapter)
    const tool = registerFileTool(ctx, 'edit', 'file_path')
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent)
    await agent.whenIdle()

    expect(tool.ran()).toBe(true)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
  })
})

describe('gate hooks — Stop (done-evidence)', () => {
  it('a Stop hook exiting 2 forces the turn to continue with the hook message', async () => {
    const d = dir()
    const counter = join(d, 'count')
    // Refuse the first stop only, so the forced continuation can finish.
    const s = sh(d, 'done.sh', `#!/usr/bin/env bash
cat >/dev/null
if [ -e "${counter}" ]; then exit 0; fi
: > "${counter}"
echo "DONE-EVIDENCE: no gate result in your claim - run the tests and quote the output" >&2
exit 2
`)
    const path = hooksFile(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('all done'), textResponse('ran tests: 12 passed')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    prompt(agent)
    await agent.whenIdle()

    // A second model step ran only because the Stop hook refused the first stop.
    expect(adapter.requests).toHaveLength(2)
    const steer = events(agent).find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    expect(steer?.type === 'user/message'
      && steer.data.content.some(b => b.type === 'text' && b.text.includes('DONE-EVIDENCE: no gate result in your claim'))).toBe(true)
  })
})
