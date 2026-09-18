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
import { loadRegistrySeatNames, unknownServedSeats, unknownServedSeatsWarning } from '@deepseek-ai/dsh-mailbox'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { IdentitySources } from './identity.ts'
import { mailboxAwaitTool, mailboxCheckInboxTool, mailboxDirectoryTool, mailboxSendTool } from './tools.ts'

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
export type { CheckInboxResult, DirectoryEntry, InboxEntry, MailboxAwaitOutcome, MailboxAwaitResult, MailboxAwaitSentState, MailboxDirectoryResult, SendResult } from './tools.ts'

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
  /**
   * The org registry the `mailbox_directory` tool lists — the same file the
   * bridge reads for topology. Defaults to the harness home's
   * `org/registry.yml`; override wherever the bridge is pointed elsewhere so
   * the two describe the same org.
   */
  readonly orgRegistryPath?: string
}

/** Schema for {@link Config}. */
export const Config: Schema<Config> = z.object({
  sessionName: z.string(),
  addresses: z.array(z.string()),
  orgRegistryPath: z.string().min(1),
})

/**
 * SWD-118 mount-time roster-drift alarm — see `@deepseek-ai/dsh-mailbox`'s
 * roster module for the two conditions it judges. Declares this mount's
 * served roster to the shared `ctx.mailbox` registry (condition A: this
 * roster disagreeing with another mount's, e.g. `mailbox-bridge`'s) and
 * checks it against the org registry (condition B: a served name the
 * registry does not know). Runs once at mount, and only when `addresses` is
 * configured — a single-seat headless run serves no roster to declare, so
 * declaring an empty one would read as every OTHER mount's roster disagreeing
 * with it.
 *
 * Warns, never throws: a wrong or unreadable registry must never block this
 * mount. A registry that is simply ABSENT is the legitimate no-registry
 * world (a deployment without an org graph): nothing is knowable as a seat,
 * so condition (B) no-ops rather than alarming. A registry that EXISTS but
 * will not load is different, and the alarm itself must never become a
 * silent failure — that case warns explicitly that condition (B) could not
 * be checked, instead of quietly passing as "nothing is wrong."
 * @param ctx - plugin context carrying the shared mailbox registry.
 * @param addresses - the served roster this mount declares.
 * @param orgRegistryPath - the registry path this mount was configured with, or the harness-home default.
 */
export async function checkRosterDrift(ctx: Context, addresses: readonly string[], orgRegistryPath: string): Promise<void> {
  try {
    ctx.mailbox.declareRoster('tool-mailbox', addresses)
    const outcome = await loadRegistrySeatNames(orgRegistryPath)
    if (outcome.kind === 'missing') return
    if (outcome.kind === 'unavailable') {
      ctx.logger.warn(
        `mailbox tools: cannot check served addresses against the org registry at "${orgRegistryPath}" for `
        + `roster drift — it exists but would not load: ${outcome.error.message}. Fix the registry and restart `
        + 'to re-run this check; treat this as unresolved, not as "nothing is wrong."',
      )
      return
    }
    const unknown = unknownServedSeats(addresses, outcome.seatNames)
    if (unknown.length > 0) ctx.logger.warn(unknownServedSeatsWarning('tool-mailbox', unknown))
  } catch (error) {
    // The alarm itself must never crash the mount; an unexpected failure
    // here is reported the same way any other roster-drift finding would be.
    ctx.logger.warn(`mailbox tools: roster-drift check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Mount the mailbox tools on the tool registry. The trusted session name
 * flows into both tool bodies; the identity resolution it feeds runs inside
 * `execute`, which is the earliest point at which a missing or malformed name
 * is a live failure rather than an unused mount.
 *
 * A missing or empty `addresses` switches `mailbox_send`'s known-recipient
 * admission from the served roster to the org registry (see `tools.ts`'s
 * `unknownRecipientRefusal` and `registryRecipientRefusal`). Which check is
 * in force is a property of the mount, not of any one message, so it is
 * stated once here rather than per send — and it is stated even when nothing
 * is wrong, because "the weaker check is running" and "no check ran at all"
 * must never look identical to an operator reading the log.
 * @param ctx - registrant context carrying the tool and mailbox registries.
 * @param config - the deployment-supplied session name.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const identity: IdentitySources = {
    ...config.sessionName !== undefined ? { sessionName: config.sessionName } : {},
    ...config.addresses !== undefined ? { addresses: config.addresses } : {},
    ...config.orgRegistryPath !== undefined ? { orgRegistryPath: config.orgRegistryPath } : {},
  }
  if (identity.addresses === undefined || identity.addresses.length === 0) {
    // Info, not warn: this is the correct and expected shape for a
    // single-seat deployment, which never mounts a bridge and so has no
    // served roster to check against. The line exists so the weaker check is
    // never mistaken for no check.
    ctx.logger.info(
      'mailbox tools: mounted with no served roster (`addresses` is empty or absent), which is normal for a '
      + 'single-seat deployment — mailbox_send admits recipients against the org registry instead, refusing '
      + 'a name that is not a seat. It cannot tell that a real seat is currently unserved; configure '
      + '`addresses` with this deployment\'s served roster (the same list `mailbox-bridge` mounts with) to '
      + 'get that stronger check.',
    )
  }
  ctx.tools.register(mailboxSendTool(ctx.mailbox, identity))
  ctx.tools.register(mailboxCheckInboxTool(ctx.mailbox, identity))
  ctx.tools.register(mailboxAwaitTool(ctx.mailbox, identity))
  ctx.tools.register(mailboxDirectoryTool({
    ...config.addresses !== undefined ? { addresses: config.addresses } : {},
    ...config.orgRegistryPath !== undefined ? { orgRegistryPath: config.orgRegistryPath } : {},
  }))
  if (identity.addresses !== undefined && identity.addresses.length > 0) {
    // SWD-118 roster-drift alarm: warns loudly, never throws (see
    // `checkRosterDrift`'s own contract). Deliberately LAST, after every
    // tool above is already registered: a stalled registry read (a hung or
    // slow filesystem, not merely a thrown error) can never delay this
    // mount's actual job of making the mailbox tools callable. Runs only
    // when this deployment actually serves a roster -- the exact inverse of
    // the branch above, which reports that a deployment serving no roster
    // admits recipients against the org registry instead. Between them every
    // mount says on the log which of the two checks it is running.
    await checkRosterDrift(ctx, identity.addresses, config.orgRegistryPath ?? dshHomePath('org', 'registry.yml'))
  }
}
