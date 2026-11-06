# @deepseek-ai/dsh-agent-claude-code-bash

English | [中文](README.zh.md)

The **sandboxed `bash` tool** for [Claude Code coder seats](../agent-claude-code-driver/README.md). It is a cordis plugin that, once its start-up check passes, registers the `sandbox` readiness entry and a `bash` tool into the registries the [policy package](../agent-claude-code-tools/README.md) serves. Every command runs inside bubblewrap under a transient `systemd-run --user --scope` unit, with no network, a read-only view of the host and a writable view of the seat's clone only. The plan for that launch (the argument vector, the environment, the unit name, the stop command) is built by `@deepseek-ai/dsh-sandbox-local` (`planSeatLaunch`); this package decides when to launch, runs it, stops it, and turns the outcome into text for the model.

Founder rulings this package implements: **no network; any command, with no command list; if the sandbox cannot start the turn is refused; there is no native Bash fallback anywhere.**

## What it does

- **Mount.** `name: agent-claude-code-bash`, `inject: [claudeCodePolicyRegistries, subprocess]`, so it works whichever of it and the policy provider mounts first. It resolves its config, runs the start-up check, and only when the check passes registers, in this order, the tool template (`bash`), the tool contributor (roles `['coder']`, names `['bash']`) and the readiness entry (`id: sandbox-bwrap-seat`, `provides: 'sandbox'`). Readiness goes last because it is what unlocks the role. If the config turns the plugin off, no `bwrap` is found, or the check fails, **nothing is registered**, the reason is warn-logged, and a coder seat stays not-ready. The registries cannot unregister, so disposing the plugin makes the tool refuse every later call.
- **The coder is still refused after this plugin.** `canary` and `rules-hooks` belong to a later slice, so the readiness report is exactly `missing: canary, rules-hooks` and `extend()` for a coder still throws; tests pin both.
- **Start-up check (preflight).** The binaries exist (`/usr/bin/env`, `/usr/bin/prlimit`, bwrap, `systemd-run`, `systemctl`), `XDG_RUNTIME_DIR` is set, `systemctl --user show-environment` answers, bwrap is attested, and `true` runs through the full launch plan in a scratch clone and is stopped cleanly. Failures are typed (`binary-missing`, `xdg-runtime-dir`, `user-bus`, `plan-refused`, `launch-failed`, `cannot-stop`) with a remedy.
- **Degrade and recover.** A runner failure or a bwrap diagnostic marks the sandbox degraded and the next call re-runs the check; a pass clears it. A failed check is not retried inside five seconds, concurrent calls share one in-flight check, and a change in the bwrap identity, the kernel release or the two user-namespace sysctls re-runs it. The first call after each verdict also runs `true` through the real plan in the seat's own clone.
- **One command at a time per seat.** A second concurrent call is refused (a busy flag cleared in `finally`).
- **The call.** The command runs through `/bin/bash -c` with a deadline (default 120 s, the host ceiling 600 s). The tool returns a **sanitised, size-capped** result built in two blocks (see the model entry below).
- **Stopping.** The scope does not kill orphans when its leader dies, so the runner always runs the same ladder: SIGKILL the bwrap process group, `systemctl --user stop <unit>`, poll for the cgroup directory to disappear, classify with `classifyScopeStop`. Success is only a vanished cgroup; an unreachable bus is an environment failure and a stop that leaves the directory behind is a failure, both reported as `runner-failure`.
- **Disk watchdog.** While a command runs, free space under the clone is sampled every 250 ms and the command is killed with status `disk-floor` below the floor. (The planner owns the floor check at launch.)
- **Main thread only.** The launch is spawned from the host main thread because the sandbox's parent-death signal fires when the spawning *thread* exits.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers nothing. |
| `deadlineS` / `maxDeadlineS` | 120 / 600 | Default and ceiling for a call's `timeout_s`. |
| `memoryMaxBytes`, `tasksMax`, `minFreeBytes` | sandbox-local defaults | Resource limits of the unit. |
| `bwrapPath` | auto-detected | Absolute path of bwrap. |
| `nodeDir`, `nodeBinDir`, `corepackHome` | none | Extra read-only toolchain locations. Corepack is never auto-detected. |
| `roPaths`, `pathDirs`, `deniedPaths` | none | Extra read-only binds, `PATH` entries and masked paths. |
| `home`, `scratchDir` | the operator home, the system temp dir | Host facts for the profile and the start-up scratch clone. |

Out-of-range numbers and non-absolute or non-normalised paths throw `BashConfigError` at mount.

## Tests

Unit specs run against a fake world (a fake spawn seam, filesystem and clock) and hold 100% per-file coverage. `tests/result.spec.ts` pins the imported bwrap failure rule to the real `LocalSandboxProvider`'s own. `tests/integration.spec.ts` is one `describe.skipIf` block: it is skipped unless bwrap, the systemd user bus and user namespaces all work, and otherwise runs the real tool on a real `git clone --no-hardlinks` clone (output and exit code, deadline kill, no orphan behind `setsid`, a write outside the clone fails, no network).

## Model Experience

### The `bash` tool

#### What the model sees

The coder sees one extra tool, `mcp__dsh__bash`, whose description says there is no network, that any command is allowed, that `.git` and `node_modules` are read-only, the deadline and kill behaviour, the 64 KiB output cap, to run `vitest` from the clone root, and that commands run one at a time; its input is a strict object of `command` (1 to 16000 characters), optional `cwd` and optional `timeout_s`, and its result is a host-written status block (every line begins `[dsh-bash`) followed by the sanitised `[dsh-bash stdout]` and `[dsh-bash stderr]` text, where any program line that imitates the marker is escaped with a leading backslash.

#### Token effect

One tool description of a few hundred tokens is added to the coder's tool list, and each call returns at most 65536 characters of output plus the status block, so a noisy command costs up to that much context until the model redirects output to a file as the description advises.

#### KV Cache effect

The tool description is a fixed string for a given config (`deadlineS` and `maxDeadlineS` are the only variables), so it is a stable part of the prefix; only the per-call result text varies, and it is appended after the prefix.

## Known Limitations and Deferred Work

- **`canary` and `rules-hooks` are not provided here.** A coder is still refused after this slice; the later slice registers them.
- **The bwrap failure rule is imported.** `RUNNER_FAILURE_RULES` is exported by `@deepseek-ai/dsh-sandbox-local` and this package uses its `bwrap` entry directly (an import-equality test pins it). The second rule, a first stderr line starting `Failed to ` with a non-zero exit (`systemd-run` could not create the scope), lives here, because the sandbox seam's own runner is bwrap, not `systemd-run`.
- **Corepack and pnpm under a read-only home.** Corepack is not auto-detected and pnpm may try to write under the home; the operator provides `corepackHome` or a writable cache path through config until a follow-up decides the default.
- **The MCP call timeout is not raised.** The 600 s deadline ceiling plus the stop ladder can exceed the SDK's default MCP request timeout; raising it (to roughly 650 s) is a follow-up in the driver.
- **No `pids.peak` reporting.** The unit's task limit is enforced, but the peak count is not read back into the status block.
- **The start-up check blocks mount.** `systemctl` calls and a probe launch run at mount and on each recheck; a hung user bus is cut off by a ten-second timeout rather than waiting.
- **Per-seat serialisation only.** Different seats run in parallel; a seat that needs concurrent commands must chain them in one `command`.
- **Output beyond 64 KiB is discarded, not stored.** The runner keeps only the tail of each stream; the description tells the model to redirect large output to a file in the clone.
- **A reload fails loud and leaves the old tool behind.** Mounting twice throws `already registered`, and because the registries cannot unregister, the old host's tool stays registered and refusing until the host process restarts. Unloading the plugin aborts every in-flight call (the stop ladder ends its sandbox) and refuses the rest.
- **A program can force a re-check.** The launcher rule is a heuristic: a command that prints `bwrap: ` or a first line `Failed to ` (case-sensitive) to stderr and exits non-zero is classified as a launcher failure, marks the sandbox degraded and makes the next call re-run the start-up check (about 100 ms). The check is shared, so a hostile seat can make other seats wait briefly on it; the verdict is "the command may not have run", never a claim about the command.
- **The disk watchdog samples every 250 ms**, so the overshoot below the floor scales with write speed (about 130 MB was measured on NVMe); the 1 GiB floor is the margin.
- **A cut cannot unescape a forged status line.** The output is cut to its tail first, then sanitised and escaped as a whole, so the first retained line is always treated as a line start.
