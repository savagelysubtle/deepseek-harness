/**
 * The seat-runner daemon: polls the mailbox store for claimable work and
 * wakes seats through the standard headless entrypoint, beside the host and
 * under the same per-name lock any human run takes.
 *
 * @module @deepseek-ai/dsh-seat-runner
 */

export {
  createSeatRunnerState, DEFAULT_STALE_CLAIM_MS, resolveSeatRunnerConfig,
  runSeatRunnerTick, startSeatRunner, WAKE_TASK_TEXT,
} from './runner.ts'
export type {
  SeatRunnerConfig, SeatRunnerDeps, SeatRunnerResolvedConfig, SeatRunnerState, WakeRequest,
} from './runner.ts'
