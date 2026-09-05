/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * Debounce window, after a `tools/change` notification, before re-verifying
 * the live tool assembly against the set the session's last dispatched
 * request actually carried (see `ReactLoopAgent`'s `scheduleToolSnapshotRecheck`
 * / `recheckToolSnapshot` in `./agent.ts`).
 *
 * Built-in tool plugins can register in a burst as their own injected
 * services settle, each registration firing its own `tools/change`; this
 * coalesces that burst into one recheck instead of one per registration.
 */
export const TOOL_SNAPSHOT_SETTLE_MS = 250
