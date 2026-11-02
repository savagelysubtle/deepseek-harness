import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as claudeCode from '../src/index.ts'

// Spends the user's Claude plan quota (one tiny prompt), so it only runs when
// explicitly requested. It uses the `claude` installed on PATH and the user's
// native login; no API key is read, set, or passed.
const LIVE = process.env.DSH_LIVE_CLAUDE_SUBSCRIPTION === '1'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!LIVE)('Claude Code provider with the native subscription login', () => {
  it('answers one nonce with no API credential in the child environment', {
    // retry: 0 overrides the shared e2e config's retry: 2 so a failed live run
    // cannot re-spend plan quota.
    timeout: 180_000,
    retry: 0,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-claude-subscription-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const handles: SubprocessHandle[] = []
    const specs: SubprocessSpawnSpec[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      specs.push(spec)
      const handle = spawn(spec)
      handles.push(handle)
      return handle
    })
    // Empty env: nothing but the native login can authenticate the child.
    await ctx.plugin(claudeCode, { env: {}, disposeGraceMs: 3_000 })

    const nonce = `DSH_CLAUDE_SUBSCRIPTION_${randomUUID()}`
    const parent = {
      id: 'subscription-e2e-parent',
      session: { header: { cwd: workspace } },
    } as unknown as Agent
    const run = await ctx.subagents.start('claude-code', {
      prompt: [{ type: 'text', text: `Reply with exactly: ${nonce}` }],
      parent,
      signal: new AbortController().signal,
    })

    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      for (const [name, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) continue
        expect(name, `child env must not carry ${name}`).not.toMatch(SENSITIVE_ENV_PATTERN)
      }
    }

    const result = await run.result
    await run.dispose()
    expect(result.stopReason).toBe('completed')
    const text = result.output
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    expect(text).toBe(nonce)
    for (const handle of handles) {
      await expect(handle.waitForExit()).resolves.toBe(true)
    }
  })
})
