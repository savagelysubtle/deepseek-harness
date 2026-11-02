# Gate hooks

English | [中文](README.zh.md)

An opt-in overlay that binds a model running inside dsh to the same rule gates a Claude Code session has. It mounts the [Claude hook bridge](../../packages/hooks/hooks-claude-code/README.md) with three control-plane scripts from `~/.agents/hooks/`:

| Event | Script | What it does |
|---|---|---|
| `PreToolUse` (file edits) | `plan-gate.sh` | Refuses a file edit on a ticket branch (`OP-<id>`, `SWD-###`, `#<id>`) whose ticket has no attached plan. A branch with no ticket reference is allowed with a warning. |
| `PreToolUse` (file edits) | `screenshot-gate.sh` | Refuses an edit to a UI path (matched by `GATE_UI_GLOBS`) until a screenshot proof is attached. |
| `Stop` | `done-evidence.sh` | Refuses to let the turn end on a completion claim that carries no gate result, forcing another step. |

The `PreToolUse` matcher is `^(Edit|Write|MultiEdit|NotebookEdit|edit|write|str_replace_editor)$`: the Claude Code names plus the harness tools `edit`, `write`, and `str_replace_editor`. Completion evidence rides the `Stop` hook because the harness `SubagentStop` cannot refuse.

Files:

- `gate-hooks.cordis.yml`: the overlay (inserts one `@deepseek-ai/dsh-hooks-claude-code` row).
- `gate-hooks.settings.json`: the hook config the bridge reads. Commands use `"$HOME/.agents/hooks/..."`; hook commands run through a shell, so `$HOME` expands. Edit the paths if the scripts live elsewhere.

## Apply

Apply it to a dshTest throwaway profile only, never to a live seat or the stable host:

```sh
dsh web --patch examples/hooks/gate-hooks.cordis.yml
```

`configPath` is process-level and resolves from the launch directory, so run from the repository root, or set `DSH_GATE_HOOKS_SETTINGS` to an absolute path of a settings file. A missing or unreadable file logs a warning and registers no hooks, so confirm the gates fired by looking for `hook/invoked` and `hook/result` events in the session log.

## What the bridge sends

Each `PreToolUse` payload carries `tool_name` (the harness tool name, for example `edit`), `tool_input`, `tool_use_id`, `cwd` (the session workspace; the scripts read the ticket from the git branch there), `session_id`, and `transcript_path`. `edit` and `write` name their target `file_path`; `str_replace_editor` names it `path`, so the bridge adds `file_path` to `tool_input` as an alias (the original `path` stays). `Stop` carries `last_assistant_message` and `stop_hook_active`. Only exit code 2 denies; any other non-zero exit lets the call proceed.

## Limits

- Reminder strength. These gates check that an artifact exists and are not a security fence: a model with a shell can still write files around them. Real containment is ticket #166.
- The config is read once at load and applies to every session in the process; there is no per-session hook config.
- The Codex-dialect bridge (`dsh-hooks-codex`) sends only the shell `command` for tool calls, so `screenshot-gate.sh` has no file path there and cannot match UI globs. Use the Claude-dialect bridge, as this overlay does.
- A missing or non-executable gate script exits 126 or 127, which does not deny, so that gate silently stops enforcing; the bridge logs a warning ending "this gate is NOT enforcing" naming the event and command, so look for it in the host log after applying the overlay.
- Each refusal is shown to the model as the tool error or the next-step steering text. The `Stop` hook is capped at 8 consecutive forced continuations, after which the agent may stop.
