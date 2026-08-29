# UI reference captures

Screenshots of the running web UI, kept so anyone picking up front-end work can
see what exists before changing it. Captured from a live host, not mocked.

**These are a baseline, not a target.** They record what the UI looked like on the
capture date. When the UI changes deliberately, add a new dated folder rather than
overwriting — the diff between folders is the useful artifact.

## How these were captured

`playwright-cli` against a live host on `http://127.0.0.1:3080`, viewport 1280×720:

```bash
playwright-cli open http://127.0.0.1:3080
playwright-cli click <ref>          # refs come from `playwright-cli snapshot`
playwright-cli screenshot
```

`playwright-cli find "<text>"` searches the accessibility snapshot and returns
matching nodes with their refs — faster than reading a full snapshot, and it is
how the sidebar tree items below were located.

## 2026-08-28

Captured while fixing workspace grouping and building the seat-hiring tools. The
UI is unchanged from the shipped build; only its contents differ across shots.

| File | What it shows |
|---|---|
| `01-sidebar-workspaces-empty-state.png` | Left sidebar with 11 registered workspaces, no sessions expanded. "Into the Unknown" empty state, workspace picker, mode selector, model selector, composer. |
| `02-session-chat-tt-lead.png` | A session open on the Chat tab: user turn, three context-injection rows, a Think row, the assistant reply, message actions, and the stats footer (turns · steps · LLM time · TTFT · tokens). |
| `03-session-chat-with-tool-call.png` | Same layout including a `Tool call · memory · write` row — how tool invocations render inline in the flow. |
| `04-sidebar-sessions-grouped.png` | Sessions nested under their workspace after grouping was fixed. Shows the mix of auto-derived titles ("dshTest") and pinned ones. |
| `05-session-titled-by-agent.png` | A seat that renamed its own session via the `session_title` tool — sidebar shows `tt-pong`, and the chat shows the failed host-API attempt above the successful tool call. |

## Structural notes worth knowing before editing

- **The sidebar is a tree of workspaces, each holding sessions.** A workspace is a
  registered project directory; the panel title is renameable and independent of
  the path. Sessions with no workspace land under `Ungrouped`.
- **Session titles have three sources**, which is why the list looks inconsistent
  in `04`: automatic generation from the first prompt (`fallback`), an explicit
  rename (`user`, pinned — automatic generation stops), and a deterministic
  fallback used when neither is cached yet.
- **The composer is a takeover-election slot.** `conversation.composer` is a chain
  whose entries replace the default `InputBar`, and a takeover **hides rather than
  unmounts** it. That is why a fenced session once rendered as *nothing at all*
  rather than a disabled box — see `packages/client/ui-conversation/src/client/input/blocks.ts`
  for the `ComposerBlocks` registry, which is the correct way to make input inert
  with a visible reason.
