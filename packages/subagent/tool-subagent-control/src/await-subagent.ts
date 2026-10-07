/**
 * The globally named `await_subagent` tool: a thin model-facing adapter over
 * `ctx.subagents.awaitSettlement()`. It gives the calling agent a single,
 * capped wait for a continuable child's durable terminal outcome instead of
 * a polling loop — one deadline, fired once, then one direct read of the
 * durable settlement record. This is the founder-ruled 08-31 wait pattern
 * (deadline fires once, the caller re-reads the source of truth directly, no
 * watcher/cron/hook) applied to subagent settlement.
 *
 * Registered from the root plugin (`./index.ts`) next to `interrupt_agent`.
 * Authorization is NOT the ancestor-of-any-descendant rule `interrupt_agent`
 * uses: `ctx.subagents.awaitSettlement()` accepts only the child's exact
 * live durable direct parent (the same rule `send_message`/`followup()`
 * enforce), rejecting a deeper or unrelated caller as `UNAUTHORIZED`. This
 * tool adds no authority of its own; the service performs the only check.
 * @module @deepseek-ai/dsh-tool-subagent-control/await-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_AWAIT_SETTLEMENT_DEADLINE_MS } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'

/** Wait applied when the model omits `deadline_ms`, well under the service's own ceiling. */
export const DEFAULT_AWAIT_DEADLINE_MS = 10_000

/**
 * Resolve the requested deadline to a finite, positive value capped at
 * {@link MAX_AWAIT_SETTLEMENT_DEADLINE_MS} — the same ceiling
 * `ctx.subagents.awaitSettlement()` itself enforces, reused here rather than
 * duplicated so the tool's documented cap can never drift from the service's
 * real one. The service clamps independently too; this call keeps the
 * value accurate for the rendered description regardless.
 */
function resolveDeadlineMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_AWAIT_DEADLINE_MS
  }
  return Math.min(requested, MAX_AWAIT_SETTLEMENT_DEADLINE_MS)
}

/**
 * Register the `await_subagent` tool.
 * @param ctx - context carrying the tool registry and subagent service.
 */
export function registerAwaitSubagent(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'await_subagent',
    description:
      'Wait for one of your background subagents to settle (finish, for any reason) by its subagent id. The '
      + 'target must be your exact direct child — the same caller `send_message` requires. '
      + `This call blocks for at most ${MAX_AWAIT_SETTLEMENT_DEADLINE_MS}ms (default ${DEFAULT_AWAIT_DEADLINE_MS}ms, `
      + 'set with `deadline_ms`, always capped at the maximum regardless of what you request): it returns as soon '
      + 'as settlement is observed, or, once the deadline passes, after exactly one direct check of the durable '
      + 'record — never a polling loop. A `pending` result means the subagent had not settled by the deadline: '
      + 'call `list_agents` to check later, or call `await_subagent` again.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      deadline_ms: {
        type: 'integer',
        description:
          'How long to wait, in milliseconds, before returning a pending result instead of blocking further. '
          + `Default ${DEFAULT_AWAIT_DEADLINE_MS}; capped at ${MAX_AWAIT_SETTLEMENT_DEADLINE_MS} regardless of the `
          + 'value given.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, enum: ['settled'] },
              outcome: { type: 'string', required: true },
              settledAt: { type: 'number', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, enum: ['pending'] },
            },
          },
        ],
      },
      render: (args, value) => [{
        type: 'text',
        text: value.status === 'settled'
          ? `subagent ${args.subagent_id} settled: ${value.outcome} at ${new Date(value.settledAt).toISOString()}`
          : `subagent ${args.subagent_id} has not settled yet — call list_agents to check later, or await_subagent again`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Direct-parent authority requires an exact live calling agent, the
        // same precondition `send_message`/`interrupt_agent` enforce.
        throw new Error('await_subagent requires a calling agent (exec.agent was undefined)')
      }
      const deadlineMs = resolveDeadlineMs(args.deadline_ms)
      const result = await ctx.subagents.awaitSettlement(
        SessionId(args.subagent_id),
        parent,
        deadlineMs,
        exec.signal,
      )
      if (result.status === 'settled') {
        return { status: 'settled' as const, outcome: result.outcome, settledAt: result.settledAt }
      }
      return { status: 'pending' as const }
    },
  }))
}
