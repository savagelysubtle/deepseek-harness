/**
 * Registry glue for the Claude Code seat driver. It joins two packages that
 * do not know each other: the mailbox bridge (which owns the single view of
 * the org registry and passes each delivery a frozen seat binding) and the
 * Claude Code driver (which owns the SDK, the host-private seat entries and
 * the mail admission seam).
 *
 * It provides exactly two things on the context and holds no state of its own:
 * `claudeCodeSeatSource`, which proves a binding is the bridge's current row
 * before the driver opens a seat on it, and `claudeCodeMailHooks`, whose
 * `admit` applies the row's `admit_from` and `admit_sender_classes` lists to
 * every mail the driver is handed (defense in depth behind the bridge's own
 * admission, which is the verdict the sender sees).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { admitsMail, SEAT_SENDER_CLASSES, seatRowHash } from '@deepseek-ai/dsh-mailbox'
import type { SeatSenderClass } from '@deepseek-ai/dsh-mailbox'
import type {
  ClaudeCodeMailHooks, ClaudeCodeSeatSource, MailAdmission, MailAdmissionDecision, MailAdmissionRequest, SeatSourceRequest,
  SeatSourceResolution,
} from '@deepseek-ai/dsh-agent-claude-code-driver'

/** Cordis plugin name. */
export const name = 'agent-claude-code-registry'

/** Services the glue needs before it can answer: the agent registry (the driver registers its factory on it). */
export const inject = ['agents']

/** The driver key a registry row must select for this glue to open it. */
const DRIVER_KEY = 'claude-code'

/**
 * The part of the bridge's `mailboxSeatRows` service the glue reads. Declared here (not imported from the
 * bridge) so this package depends on the mailbox seam only, never on the bridge package.
 */
export interface SeatRowsService {
  /**
   * The seat's current hash, driver and admission lists (never its cwd, session id or tools), or `undefined`
   * for an unknown or quarantined seat.
   */
  current(seat: string): {
    readonly rowHash: string
    readonly driver: string
    readonly admit_from: readonly string[]
    readonly admit_sender_classes: readonly SeatSenderClass[]
  } | undefined
}

const PREFIX = 'agent-claude-code-registry:'

/**
 * Build the seat source over a lookup of the bridge's row service.
 * @param rows - returns the bridge's `mailboxSeatRows` service, or `undefined` when none is mounted.
 * @returns the source the driver consults for seats its static config does not hold.
 */
export function createSeatSource(rows: () => SeatRowsService | undefined): ClaudeCodeSeatSource {
  return {
    resolve(request: SeatSourceRequest): SeatSourceResolution {
      const { binding } = request
      if (binding === undefined) {
        throw new Error(`${PREFIX} no seat binding on this create/resume; a Claude Code seat is opened only by the mailbox bridge, which resolves the registry row`)
      }
      const service = rows()
      if (service === undefined) {
        throw new Error(`${PREFIX} the mailboxSeatRows service is not available (mount the mailbox bridge); refusing to open seat "${binding.seat}" on an unverifiable row`)
      }
      if (seatRowHash(binding.row) !== binding.rowHash) {
        throw new Error(`${PREFIX} seat "${binding.seat}": the binding's row does not match its hash (forged or corrupted); refusing to open it`)
      }
      const current = service.current(binding.seat)
      if (current === undefined) {
        throw new Error(`${PREFIX} seat "${binding.seat}" has no current valid registry row; refusing to open it`)
      }
      if (current.rowHash !== binding.rowHash) {
        throw new Error(`${PREFIX} seat "${binding.seat}": the registry row changed since the bridge bound it (stale binding); the next delivery will bind the current row`)
      }
      if (binding.row.driver !== DRIVER_KEY) {
        throw new Error(`${PREFIX} seat "${binding.seat}": its registry row selects driver ${JSON.stringify(binding.row.driver ?? 'default')}, not "${DRIVER_KEY}"`)
      }
      return { seat: binding.seat, row: binding.row }
    },
    hasRow(seat: string): boolean | undefined {
      const service = rows()
      return service === undefined ? undefined : service.current(seat)?.driver === DRIVER_KEY
    },
  }
}

/** Whether a hop class is one the row's `admit_sender_classes` can name. */
function isSenderClass(value: string): value is SeatSenderClass {
  return (SEAT_SENDER_CLASSES as readonly string[]).includes(value)
}

/**
 * Build the admission hook over a lookup of the bridge's row service. Fails closed: no service, an unknown
 * seat, a mail naming no sender, or a hop class the registry has no name for all deny.
 * @param rows - returns the bridge's `mailboxSeatRows` service, or `undefined` when none is mounted.
 * @returns the admission check the driver runs on every send and steer.
 */
export function createAdmission(rows: () => SeatRowsService | undefined): MailAdmission {
  return (request: MailAdmissionRequest): MailAdmissionDecision => {
    const deny = (reason: string): MailAdmissionDecision => ({ allow: false, reason: `${PREFIX} ${reason}` })
    const service = rows()
    if (service === undefined) return deny('the mailboxSeatRows service is not available, so the seat\'s admission list cannot be read')
    const current = service.current(request.seat)
    if (current === undefined) return deny(`seat "${request.seat}" has no current valid registry row`)
    if (request.from === undefined) return deny('the mail names no sender, so it cannot be matched against admit_from')
    // Mail from a roster seat with no external hop is class `seat`; any hop class must be one the row can list.
    const classes = request.externalHops.length === 0 ? ['seat'] : request.externalHops
    const unknown = classes.find(senderClass => !isSenderClass(senderClass))
    if (unknown !== undefined) return deny(`sender class "${unknown}" is not a class a registry row can admit`)
    const verdict = admitsMail(current, { from: request.from, classes: classes as SeatSenderClass[] })
    return verdict.allow ? { allow: true } : deny(verdict.reason)
  }
}

/**
 * Provide `claudeCodeSeatSource` and `claudeCodeMailHooks`. The hooks object carries `admit` only: the mailbox
 * lease sink belongs to a later slice (S8), and an object with no `lease` key leaves the driver's own lease
 * handling untouched.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const rows = (): SeatRowsService | undefined => ctx.get('mailboxSeatRows') as SeatRowsService | undefined
  const hooks: ClaudeCodeMailHooks = { admit: createAdmission(rows) }
  ctx.provide('claudeCodeSeatSource', createSeatSource(rows))
  ctx.provide('claudeCodeMailHooks', hooks)
}
