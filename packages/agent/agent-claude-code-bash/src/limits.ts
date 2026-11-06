/**
 * Constants of the sandboxed `bash` tool: its name, the deadline bounds, the output caps and the status
 * marker the host writes. Nothing here depends on the host; the values the operator may change live in the
 * plugin config.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/limits
 */

/** Bare name of the tool; the model sees it as `mcp__dsh__bash`. */
export const BASH_TOOL = 'bash'

/** Readiness contributor id; it provides the `sandbox` requirement. */
export const READINESS_ID = 'sandbox-bwrap-seat'

/** Tool contributor id. */
export const TOOL_CONTRIBUTOR_ID = 'sandbox-bash'

/** Longest command the schema accepts, in UTF-16 code units. */
export const MAX_COMMAND_LENGTH = 16_000

/** Longest `cwd` argument the schema accepts. */
export const MAX_CWD_LENGTH = 4096

/** Default deadline of a call, in seconds. */
export const DEFAULT_DEADLINE_S = 120

/** Hard ceiling of the host maximum deadline, in seconds (the config may lower it, never raise it). */
export const HOST_MAX_DEADLINE_S = 600

/** Bytes kept per output stream (the tail); everything before is discarded while the command runs. */
export const TAIL_BYTES = 64 * 1024

/** Longest text the model receives in the output block, in code points (the scrub cap handed to the tools package). */
export const MAX_OUTPUT_CHARS = 65_536

/** How often the in-call disk watchdog samples free space. */
export const WATCHDOG_INTERVAL_MS = 250

/** How long a call waits for the process to be reaped after the group was killed. */
export const REAP_WAIT_MS = 5000

/** How long the unit stop command may run. */
export const STOP_TIMEOUT_MS = 15_000

/** How long the runner waits for the cgroup directory to disappear after a stop that reported success. */
export const CGROUP_GONE_WAIT_MS = 2000

/** Poll interval of the cgroup-gone wait. */
export const CGROUP_POLL_MS = 25

/** Deadline of the `true` command of the preflight and of the first-call re-test, in seconds. */
export const PROBE_DEADLINE_S = 30

/** Timeout of `systemctl --user show-environment`. */
export const BUS_PROBE_TIMEOUT_MS = 10_000

/** Grace the subprocess seam is given to drain collected pipes after exit. */
export const SPAWN_GRACE_MS = 200

/** Prefix of every host-written status line; program lines that start like this are escaped. */
export const STATUS_MARKER = '[dsh-bash'

/** Prefix that escapes a program line that looks like a host status line. */
export const ESCAPE_PREFIX = '\\'

/** After a preflight failure the host does not try again for this long (milliseconds), so a refused call is cheap. */
export const RECHECK_MS = 5000
