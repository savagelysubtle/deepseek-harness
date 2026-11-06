/**
 * Fixed Claude Code one-shot subagent provider. Every accepted run invokes
 * the official Agent SDK in the delegating Session's workspace and places
 * the SDK-spawned real CLI under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { guardConfigSchema } from '@deepseek-ai/dsh-config-guard'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startClaudeCodeRun,
  type ClaudeCodeRunSpec,
} from './run.ts'

/**
 * The managed-process adapter, re-exported so the Claude Code seat driver imports the built package root
 * instead of reaching into this package's raw `src/` (which Node cannot load: it uses a TypeScript parameter property).
 */
export { claudeSpawnSpec, ManagedClaudeCodeProcess } from './process.ts'

export const name = 'subagent-claude-code'
export const inject = ['subagents', 'subprocess']

/* jscpd:ignore-start -- sibling product providers intentionally expose the
 * same two deployment-owned fields without adding a shared config owner. */
/** Deployment-owned environment and process-release bound. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = guardConfigSchema(z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
}))

type ResolvedConfig = Required<Config>
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration and shared-seam plumbing mirror
 * the Codex sibling; each product's lifecycle remains package-private. */
class ClaudeCodeProvider implements SubagentProvider {
  readonly name = 'claude-code'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const executable = await this.ctx.subprocess.resolveExecutable(
      'claude',
      this.config.env,
      request.signal,
    )
    const spec: ClaudeCodeRunSpec = {
      cwd: resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      ),
      executable,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    const startedAt = Date.now()
    const run = await startClaudeCodeRun(request, spec)
    // Every run is a separate billed Claude Code session: leave a host-log trace.
    const taskLength = request.prompt.reduce(
      (total, block) => total + (block.type === 'text' ? block.text.length : 0),
      0,
    )
    this.ctx.logger.info(
      `subagent-claude-code: run started (provider=${this.name}, run=${run.id}, taskChars=${taskLength})`,
    )
    void run.result.then(
      (result) => {
        this.ctx.logger.info(
          `subagent-claude-code: run completed (run=${run.id}, stopReason=${result.stopReason}, durationMs=${Date.now() - startedAt})`,
        )
      },
      () => {
        // The shared result contract settles rather than rejects; nothing to log.
      },
    )
    return run
  }
}

/**
 * Register the fixed `claude-code` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - explicit child environment and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-claude-code',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new ClaudeCodeProvider(ctx, resolved))
}
/* jscpd:ignore-end */
