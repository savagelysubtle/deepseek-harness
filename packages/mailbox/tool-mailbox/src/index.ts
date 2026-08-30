/**
 * Model-facing mailbox tools over the mailbox seam: `mailbox_send` publishes
 * with a runtime-filled sender, `mailbox_check_inbox` drains the calling
 * session's own address, and `mailbox_await` holds the calling turn until a
 * reply arrives, the awaited send is refused, or a deadline expires. The
 * schemas expose no sender field and no address argument, so a seat cannot
 * claim another identity or read another seat's mail through these tools.
 * Where the identity itself comes from depends on how many seats share the
 * process — the launcher's {@link Config.sessionName} for a one-seat headless
 * run, the calling agent matched against {@link Config.addresses} for the
 * many-seat host. See the identity module.
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
import type { IdentitySources } from './identity.ts'
import { mailboxAwaitTool, mailboxCheckInboxTool, mailboxSendTool } from './tools.ts'

export {
  AWAIT_DEFAULT_DEADLINE_MS,
  AWAIT_MAX_DEADLINE_MS,
  AWAIT_MIN_DEADLINE_MS,
  AWAIT_POLL_INTERVAL_MS,
  CHECK_INBOX_DRAIN_LIMIT,
  CHECK_INBOX_STALE_CLAIM_MS,
  clampAwaitDeadlineMs,
} from './tools.ts'
export { resolveMailboxIdentity } from './identity.ts'
export type { IdentitySources } from './identity.ts'
export type { CheckInboxResult, InboxEntry, MailboxAwaitOutcome, MailboxAwaitResult, MailboxAwaitSentState, SendResult } from './tools.ts'

/** Stable Cordis plugin name. */
export const name = 'tool-mailbox'

/** Services required before the tools can register. */
export const inject = ['tools', 'mailbox']

/** Plugin configuration: the trusted identity source of the mailbox tools. */
export interface Config {
  /**
   * The calling session's trusted name — the name the operator's launcher
   * passed to this process. Correct only where the process serves ONE seat,
   * which is the headless run. Absent for an anonymous run: the tools then
   * fail loud at call time (see {@link resolveMailboxIdentity}), because
   * there is no identity to trust.
   */
  readonly sessionName?: string
  /**
   * The addresses this deployment serves — the same roster the bridge is
   * mounted with. Set it wherever one process serves MANY seats (the host
   * behind the UI): the identity then comes from the calling agent's own
   * session id matched against this roster, never from a mount-time name,
   * which in a many-seat process would stamp every session as one seat.
   */
  readonly addresses?: string[]
}

/** Schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  sessionName: z.string(),
  addresses: z.array(z.string()),
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
  const identity: IdentitySources = {
    ...config.sessionName !== undefined ? { sessionName: config.sessionName } : {},
    ...config.addresses !== undefined ? { addresses: config.addresses } : {},
  }
  ctx.tools.register(mailboxSendTool(ctx.mailbox, identity))
  ctx.tools.register(mailboxCheckInboxTool(ctx.mailbox, identity))
  ctx.tools.register(mailboxAwaitTool(ctx.mailbox, identity))
}
