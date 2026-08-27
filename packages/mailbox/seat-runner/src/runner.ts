/**
 * The seat-runner daemon: the wake-on-arrival executor that runs BESIDE the
 * web host, never inside it. Every turn a mail message triggers goes through
 * the same headless entrypoint and the same per-name lock a human's terminal
 * command uses — the one-writer rule (`docs/architecture.md` § "Session
 * log") — so the daemon contains no seat logic at all: it discovers
 * claimable work in the mailbox store, resolves the seat through the org
 * registry, and shells out to the standard command.
 *
 * Failure handling reuses the proven contended-lock behavior: when a human
 * or another run already holds the seat's lock, the wake run exits nonzero,
 * the mail stays pending, and the seat's next attempt waits out an
 * exponential backoff — the same shape that fixed the 156-kick freeze.
 *
 * @module @deepseek-ai/dsh-seat-runner/runner
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { MailboxProvider, OrgRegistry } from '@deepseek-ai/dsh-mailbox'
import { parseMailboxAddress, resolveSeatCwd } from '@deepseek-ai/dsh-mailbox'
import type { MailboxClock } from '@deepseek-ai/dsh-mailbox-local'
import { resolveMailboxPath } from '@deepseek-ai/dsh-mailbox-local'

/**
 * The task text a wake run executes. The backlog drain ahead of this turn is
 * automatic (`serveMailboxBacklog`), so the text only has to direct the seat
 * to handle what was admitted and stop.
 */
export const WAKE_TASK_TEXT = 'You have new mail. Use the mailbox tool to drain your inbox, handle each message, then stop.'

/** Default staleness bound for discovery; mirrors the headless backlog drain's bound. */
export const DEFAULT_STALE_CLAIM_MS = 120_000

/** Daemon configuration; every field is validated at the resolve step. */
export interface SeatRunnerConfig {
  /** Org registry file to read the roster and topology from. Default: `<dsh home>/org/registry.yml`. */
  readonly registryPath?: string
  /** Mailbox SQLite database to poll. Default: `<dsh home>/mailbox/mailbox.db`. */
  readonly storePath?: string
  /** Milliseconds between discovery ticks. Default 5,000. */
  readonly pollIntervalMs?: number
  /** Age bound under which an in-flight claim still hides its message from discovery. Default 120,000. */
  readonly staleClaimMs?: number
  /** Base for the exponential wake backoff, in milliseconds. Default 2,000. */
  readonly backoffBaseMs?: number
  /** Cap on the backoff exponent, so a stuck seat retries slowly instead of never. Default 6. */
  readonly maxBackoffExponent?: number
  /** The command a wake run shells out to; resolved through PATH. Default `dsh`. */
  readonly entrypoint?: string
  /** Task text the wake run executes. Default {@link WAKE_TASK_TEXT}. */
  readonly wakeTask?: string
}

/** Validated daemon configuration; the only shape the loop accepts. */
export interface SeatRunnerResolvedConfig {
  readonly registryPath: string
  readonly storePath: string
  readonly pollIntervalMs: number
  readonly staleClaimMs: number
  readonly backoffBaseMs: number
  readonly maxBackoffExponent: number
  readonly entrypoint: string
  readonly wakeTask: string
}

/**
 * One wake the daemon issues: exactly the command a human runs by hand,
 * parameterized by the registry-resolved seat.
 */
export interface WakeRequest {
  /** Seat name, for logs and backoff bookkeeping. */
  readonly seat: string
  /** Namespace half of the seat's address. */
  readonly namespace: string
  /** Name half of the seat's address; also the wake run's `--session-name`. */
  readonly name: string
  /** Absolute workspace the wake run executes in. */
  readonly cwd: string
  /** Command to execute. */
  readonly entrypoint: string
  /** Task text the run executes. */
  readonly task: string
}

/** Collaborators of the tick loop, narrowed for substitution in tests. */
export interface SeatRunnerDeps {
  /** Mailbox store polled for claimable work. */
  readonly store: Pick<MailboxProvider, 'claimableAddresses'>
  /** The parsed org registry resolving addresses to seats. */
  readonly registry: OrgRegistry
  /** Issues one wake; resolves on a clean exit, rejects on a nonzero exit or spawn failure. */
  readonly wake: (request: WakeRequest) => Promise<void>
  /** Epoch-millisecond source for backoff accounting. */
  readonly clock: MailboxClock
  /** Human-facing log sink; one line per observable event. */
  readonly log: (line: string) => void
}

/** Per-seat bookkeeping between ticks. */
export interface SeatRunnerState {
  /** Consecutive wake failures per seat; reset by a clean exit. */
  readonly attempts: Map<string, number>
  /** Epoch-ms before which a seat's next wake is deferred (backoff). */
  readonly eligibleAt: Map<string, number>
  /** Seats with a wake currently running; at most one per seat, ever. */
  readonly inFlight: Set<string>
  /** Addresses already warned as unroutable; each warns once, not every tick. */
  readonly unroutableWarned: Set<string>
}

/** Create the empty per-run bookkeeping. */
export function createSeatRunnerState(): SeatRunnerState {
  return {
    attempts: new Map(),
    eligibleAt: new Map(),
    inFlight: new Set(),
    unroutableWarned: new Set(),
  }
}

/**
 * Resolve raw config into the validated shape, failing loud on any field the
 * loop could not honor — a daemon misconfigured at boot beats one that
 * silently polls at 0ms.
 * @param config - the raw deployment config.
 * @returns the validated configuration with defaults applied.
 * @throws when any present field is outside its valid range.
 */
export function resolveSeatRunnerConfig(config: SeatRunnerConfig = {}): SeatRunnerResolvedConfig {
  return {
    registryPath: resolveNonEmpty(config.registryPath, dshHomePath('org', 'registry.yml'), 'registryPath'),
    storePath: resolveNonEmpty(config.storePath, resolveMailboxPath(), 'storePath'),
    pollIntervalMs: resolvePositive(config.pollIntervalMs, 5_000, 'pollIntervalMs'),
    staleClaimMs: resolvePositive(config.staleClaimMs, DEFAULT_STALE_CLAIM_MS, 'staleClaimMs'),
    backoffBaseMs: resolvePositive(config.backoffBaseMs, 2_000, 'backoffBaseMs'),
    maxBackoffExponent: resolvePositive(config.maxBackoffExponent, 6, 'maxBackoffExponent'),
    entrypoint: resolveNonEmpty(config.entrypoint, 'dsh', 'entrypoint'),
    wakeTask: resolveNonEmpty(config.wakeTask, WAKE_TASK_TEXT, 'wakeTask'),
  }
}

/**
 * Run one discovery tick: read claimable addresses, resolve each to a
 * registry seat, and issue the wakes that are neither backing off nor
 * already in flight. Wake promises settle independently of this tick; a
 * still-running wake blocks only its own seat, never the loop.
 * @param deps - collaborators (store, registry, wake issuer, clock, log).
 * @param config - the validated configuration.
 * @param state - per-run bookkeeping, mutated in place.
 * @param signal - cancellation owning this tick's discovery read.
 */
export async function runSeatRunnerTick(
  deps: SeatRunnerDeps,
  config: SeatRunnerResolvedConfig,
  state: SeatRunnerState,
  signal?: AbortSignal,
): Promise<void> {
  const addresses = await deps.store.claimableAddresses({ staleClaimMs: config.staleClaimMs }, signal)
  const now = deps.clock()
  for (const address of addresses) {
    const request = resolveWakeRequest(deps, state, address, config)
    if (request === undefined) continue
    if (state.inFlight.has(request.seat)) continue
    const eligibleAt = state.eligibleAt.get(request.seat)
    if (eligibleAt !== undefined && eligibleAt > now) continue
    state.inFlight.add(request.seat)
    deps.log(`wake ${request.seat} (${request.namespace}:${request.name}) in ${request.cwd}`)
    void deps.wake(request).then(
      () => {
        state.inFlight.delete(request.seat)
        state.attempts.delete(request.seat)
        state.eligibleAt.delete(request.seat)
        deps.log(`wake ${request.seat} exited clean`)
      },
      (error: unknown) => {
        state.inFlight.delete(request.seat)
        const attempts = (state.attempts.get(request.seat) ?? 0) + 1
        state.attempts.set(request.seat, attempts)
        const exponent = Math.min(attempts - 1, config.maxBackoffExponent)
        state.eligibleAt.set(request.seat, deps.clock() + config.backoffBaseMs * 2 ** exponent)
        deps.log(`wake ${request.seat} failed (attempt ${attempts}): ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }
}

/**
 * Start the daemon's interval loop. The first tick fires immediately with
 * the same bookkeeping the interval reuses, so a wake issued at boot is
 * visible to later backoff and in-flight checks. A tick that throws is
 * logged and the loop continues — a transient store fault must not end
 * wake-on-arrival.
 * @param deps - collaborators.
 * @param config - the validated configuration.
 * @returns a handle whose `stop()` ends the loop; in-flight wakes keep running.
 */
export function startSeatRunner(deps: SeatRunnerDeps, config: SeatRunnerResolvedConfig): { stop(): void } {
  const state = createSeatRunnerState()
  const tick = (): void => {
    void runSeatRunnerTick(deps, config, state).catch((error: unknown) => {
      deps.log(`seat-runner tick failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  tick()
  const timer = setInterval(tick, config.pollIntervalMs)
  return { stop: () => clearInterval(timer) }
}

/**
 * Resolve one pending address to a wake request through the registry, or
 * undefined when the address has no routable seat. An unroutable address
 * warns once per daemon run, not once per tick.
 * @param deps - collaborators; carries the log sink.
 * @param state - per-run bookkeeping carrying the warned-unroutable set.
 * @param address - the pending address from the store.
 * @param config - the validated configuration.
 * @returns the wake request, or undefined when the address cannot route.
 */
function resolveWakeRequest(
  deps: SeatRunnerDeps,
  state: SeatRunnerState,
  address: string,
  config: SeatRunnerResolvedConfig,
): WakeRequest | undefined {
  const { registry } = deps
  let namespace: string
  let name: string
  try {
    const parsed = parseMailboxAddress(address)
    const separatorAt = parsed.indexOf(':')
    namespace = parsed.slice(0, separatorAt)
    name = parsed.slice(separatorAt + 1)
  } catch (error: unknown) {
    return warnUnroutable(deps, state, address, error instanceof Error ? error.message : String(error))
  }
  const seat = registry.seats[name]
  if (seat === undefined) {
    return warnUnroutable(deps, state, address, `no registry seat named "${name}"`)
  }
  if (seat.namespace !== namespace) {
    return warnUnroutable(deps, state, address, `registry seat "${name}" answers namespace "${seat.namespace}", not "${namespace}"`)
  }
  return {
    seat: name,
    namespace,
    name,
    cwd: resolveSeatCwd(registry, name),
    entrypoint: config.entrypoint,
    task: config.wakeTask,
  }
}

/**
 * Log an unroutable address exactly once per daemon run and return
 * undefined, so ticks stay quiet and the caller's flat skip reads honestly.
 * @param deps - collaborators; carries the log sink.
 * @param state - bookkeeping carrying the warned set.
 * @param address - the address that could not route.
 * @param reason - why it could not route.
 * @returns undefined, always.
 */
function warnUnroutable(deps: SeatRunnerDeps, state: SeatRunnerState, address: string, reason: string): undefined {
  if (!state.unroutableWarned.has(address)) {
    state.unroutableWarned.add(address)
    deps.log(`pending address ${address} is unroutable: ${reason}`)
  }
  return undefined
}

/**
 * Resolve an optional string to a validated non-empty value or its default.
 * @param value - the configured value, if any.
 * @param fallback - the default when absent.
 * @param label - the field name, for the error message.
 * @returns the validated value.
 */
function resolveNonEmpty(value: string | undefined, fallback: string, label: string): string {
  if (value === undefined) return fallback
  if (value.trim().length === 0) throw new Error(`seat-runner ${label} must be a non-empty string`)
  return value
}

/**
 * Resolve an optional number to a validated positive value or its default.
 * @param value - the configured value, if any.
 * @param fallback - the default when absent.
 * @param label - the field name, for the error message.
 * @returns the validated value.
 */
function resolvePositive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`seat-runner ${label} must be a positive integer`)
  }
  return value
}
