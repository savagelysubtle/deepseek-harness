/**
 * Model-facing mailbox tools over the mailbox seam: `mailbox_send` publishes
 * with a runtime-filled sender, `mailbox_check_inbox` drains the calling
 * session's own address. Both resolve their identity from the
 * deployment-supplied trusted session name ({@link Config.sessionName}) — the
 * schema exposes no sender field and no address argument, so a seat cannot
 * claim another identity or read another seat's mail through these tools.
 *
 * The plugin stays PENDING until `ctx.tools` and `ctx.mailbox` exist, and the
 * tools fail loud at call time when the run has no session name: an anonymous
 * run has no trusted identity, and the bundle mounts the tools unconditionally
 * so the tool catalog does not churn between named and anonymous runs.
 *
 * @module @deepseek-ai/dsh-tool-mailbox
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { mailboxCheckInboxTool, mailboxSendTool } from './tools.ts'

export { CHECK_INBOX_DRAIN_LIMIT, CHECK_INBOX_STALE_CLAIM_MS } from './tools.ts'
export { resolveMailboxIdentity } from './identity.ts'
export type { CheckInboxResult, InboxEntry, SendResult } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = 'tool-mailbox'

/** Services required before the tools can register. */
export const inject = ['tools', 'mailbox']

/** Plugin configuration: the trusted identity source of the two tools. */
export interface Config {
  /**
   * The calling session's trusted name — the name the operator's launcher
   * passed to this process. It is the only sender identity the tools fill and
   * the only address `mailbox_check_inbox` drains. Absent for an anonymous
   * run: both tools then fail loud at call time (see
   * {@link resolveMailboxIdentity}), because there is no identity to trust.
   */
  readonly sessionName?: string
}

/** Schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  sessionName: z.string(),
})

/**
 * Mount the mailbox tools on the tool registry. The trusted session name
 * flows into both tool bodies; the identity resolution it feeds runs inside
 * `execute`, which is the earliest point at which a missing or malformed name
 * is a live failure rather than an unused mount.
 * @param ctx - registrant context carrying the tool and mailbox registries.
 * @param config - the deployment-supplied session name.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(mailboxSendTool(ctx.mailbox, config.sessionName))
  ctx.tools.register(mailboxCheckInboxTool(ctx.mailbox, config.sessionName))
}
