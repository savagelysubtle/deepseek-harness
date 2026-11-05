# @deepseek-ai/dsh-agent-claude-code-tools

English | [中文](README.zh.md)

The **permission policy core** for [Claude Code seats](../agent-claude-code-driver/README.md). It turns host-private inputs (the host seat's policy fields, the working directory, the seat name; never a registry row) into the rulebook one seat runs under: permission rules, a second-layer `PreToolUse` hook, and the file that hook reads. It is pure policy code with no cordis plugin of its own; the provider that serves it to the driver as `ctx.claudeCodePolicy` is a later part of the same slice. The contract types it implements live in the driver (`policy-contract.ts`).

## What it generates

- **Rules** (`generateRules`). Claude Code path rules are gitignore-style: `//abs` is an absolute path, `/abs` is project-relative, so every rule here is emitted as `//` followed by the path without its leading slash (for example `Read(//home/steve/x/**)` for the cwd `/home/steve/x`; never `///`, and the `~/` form is not used). Each protected directory gets both the bare entry and the `/**` entry, because a worktree's `.git` is a file. Only `Read(...)` and `Edit(...)` are real path specifiers (`Read` covers Grep and Glob; `Edit` covers Write, MultiEdit and NotebookEdit), so no `Write(...)` or `Grep(...)` rule is emitted. Every role gets the same deny set: `~/.claude/**`, `~/.claude.json`, `~/.ssh/**`, `~/.config/gh/**`, `~/.dsh/**`, `~/.agents/**`, and inside the cwd `.git/**`, `.claude/**`, `.mcp.json`, `.husky/**`. A `coder` also gets `Read` and `Edit` allow rules for `//<cwd>/**`; a `lead` gets no native tool at all.
- **A cwd or home that cannot be written into a rule is refused** (`UnsafePathError`): not absolute or not normalised, the filesystem root, containing any of `* ? [ ] ! # { } \ ( )`, whitespace or a control character, not equal to its own realpath, not a directory, or (for the cwd) inside one of the protected home locations.
- **Settings** (`generateSeatPolicy`): `{settings, allow, disallowedTools, tools, fences}` where `settings` holds the guard hook plus `permissions.deny`, `allow` holds `mcp__dsh__<name>` entries (and the cwd `Read`/`Edit` rules for a coder), and `fences` repeats `dontAsk`, `settingSources: []`, `strictMcpConfig: true`. Only the SHA-256 of the result (`settingsSha256`) is meant to be logged. There is no `canUseTool`: it is never called under `dontAsk`, so the hook is the second layer.
- **Tools.** The lead template is exactly `mailbox_send` and `mailbox_directory` (as `mcp__dsh__mailbox_send` and `mcp__dsh__mailbox_directory`). The host seat's `tools` list cuts the template down; a seat left with no tool throws `SeatMutedByPolicyError` from the driver contract. Later slices append names and hook groups through `ContributorRegistry.registerToolContributor` and `registerHookContributor` without editing this package.
- **Readiness** (`ReadinessRegistry`). `lead` is servable as soon as the policy service exists. `coder` is servable only when contributors providing `sandbox`, `canary` and `rules-hooks` have all registered; `missing` names what is absent.

## The seat-guard hook

`src/bin.ts` is a thin reader, bundled with the guard modules into one plain-JavaScript file, `lib/seat-guard.js`, that ships in the package (`guardScriptPath()` returns it; Node refuses to strip TypeScript under `node_modules`, so the `.ts` source is only usable inside the workspace and `buildHookCommand` rejects it unless `allowSourceGuard` is set). `verifyGuardCommand(command)` runs the exact generated command with a payload the policy must refuse and requires exit code 2 with the guard's own `seat-guard: denied` reason; call it before a seat's first query. The host writes `<policyDir>/<seat>.json` atomically (temp file in the same directory, fsync, rename; `writePolicyFile`) and gets back the SHA-256 of the exact bytes. The hook command line is built by `buildHookCommand`:

```
env -u NODE_OPTIONS <attested node> <attested guard script> --policy <path> --sha256 <hex> --seat <name>
```

Every value is checked against a strict grammar (seat `^[a-z][a-z0-9-]{0,31}$`; paths absolute, canonical, no shell metacharacters) and single-quoted; the timeout is 60 seconds. `attestFile` verifies the node binary and the guard script before the command is built: regular files, owned by the operator or root, not group- or world-writable, in a directory chain nobody else can write, SHA-256 pinned. It mirrors the driver's `attestClaudePath` rules because that function refuses script extensions and is not parameterised; the hash helper is the driver's own.

The hook reads the `PreToolUse` JSON on stdin and checks `tool_input.file_path`, `path`, `notebook_path`, the Glob `pattern` and the Grep `glob`. For every candidate it resolves the real path (parent plus basename for a new file, nearest existing ancestor for a deeper one) and requires it to sit inside the policy's roots by whole path segments (`/a/b` is not inside `/a/bb`), outside the protected prefixes, and not an existing file with more than one hard link. `..` anywhere, a leading `~`, symlink escapes, dangling symlinks and absolute paths outside are denied. The policy file is read only if it is a regular file of at most 64 KiB and the hook payload is capped at 1 MiB. Glob and Grep patterns may not start a new path inside a brace or extglob group (`{/etc/x,y}`, `@(/etc/x|y)`) nor hold a `/` inside one. Unless the policy sets `denyDirsContainingProtected: false` (an optional flag on the v1 file, default on), a Grep or Glob whose effective search directory lies above an existing protected location (so `Grep` over the cwd of a git checkout) is denied: search a subdirectory. A tool outside the policy's `tools` list is denied, and an `mcp__` tool must be named in it.

**The hook only ever denies.** A deny is exit code 2 with a one-line reason on stderr. A pass is exit code 0 with no output at all; the hook never prints an allow decision, and a static test asserts the hook sources contain no such output path. It also denies when the policy file is missing, unreadable, corrupt, has `v` other than 1, names another seat, or its SHA-256 differs from the one on the command line. The matcher string in the generated hook entry (`Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|mcp__dsh__.*`) is covered by a unit test against every native file tool.

## Tests

`tests/` uses real temporary directories (symlink out of the cwd, hard link, `..`, `/a/b` against `/a/bb`, glob-character cwd, new-file parent checks) and runs the hook as a child process on stdin fixtures. Per-file 100% coverage is enforced by the repository coverage gate.

## Known Limitations and Deferred Work

- **The hook fails open on a crash, timeout or missing node.** Only exit code 2 blocks a call in Claude Code. The guard catches everything it can and exits 2, but a killed or absent process cannot; the boot canary of a later slice (S7) is the structural catch, which is why `coder` stays refused until it exists.
- **A Rust port of the guard** (compiled, no Node startup cost per tool call) is a tracked follow-up; today it is Node running `lib/seat-guard.js`.
- **Hook-to-tool race.** The check-then-use window between the hook and the tool is inherent to hooks, and hard-link detection only sees links that already exist.
- **Symlink-following by the tools.** Whether ripgrep and the glob tool follow a symlink planted inside the cwd (for example a pattern `lnk*/*`, which the guard judges only by its static prefix) is pinned by the live probe, not by unit tests.
- **Provisioning is part of the trust boundary.** The clone a coder works in must be provisioned by the host; a coder can still edit files that run later (`package.json` scripts, `lefthook.yml`), which lands on human review.
- **Contributor hook groups are not validated.** `ContributorRegistry.extraHookGroups` returns whatever S6/S7 contributors register; those slices must audit what they add.
- **Case-insensitive filesystems are refused** when a protected entry also answers to its upper-case name, and a cwd equal to the home directory or inside a protected home location is refused.
- **Rule matching is not provable offline.** The SDK exports no permission evaluator, so the generated rule strings are proven against the real CLI only by the live probe of the slice; the hook is the layer unit tests can fully exercise.
- **A path guard cannot see the shell.** Native `Bash` is disallowed; the shell sandbox is a later slice.
- **Pattern characters in a cwd are refused, not escaped.** Move the work to a path without them.
