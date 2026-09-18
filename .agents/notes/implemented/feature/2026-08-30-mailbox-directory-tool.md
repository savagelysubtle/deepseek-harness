# Agent Note: mailbox_directory — seat discovery for the mailbox tools

Status: implemented

English | [中文](2026-08-30-mailbox-directory-tool.zh.md)

## Problem

The mailbox seam addressed seats by bare name, and nothing told a seat which names existed. `list_agents`-style registries list subagents, not coworkers; the org registry file held the roster but sat behind raw file access no model-facing tool exposed. A seat told to "mail the department lead" had to be told the name by Steve in conversation, every time — discovery was the missing primitive that made the other three tools unusable on their own.

## Decision

`mailbox_directory` is the fourth tool on the same mount, built by the same pattern as its siblings. It takes no argument and no identity — the directory is org knowledge, not per-seat data, so it works on anonymous runs whose identity only exists at send time. It merges this host's served roster (`Config.addresses`) with the org registry (`Config.orgRegistryPath`, defaulting to the harness home's `org/registry.yml` — the same file and default the bridge reads), marks each seat `served`, `lead`, and `test`, and sorts alphabetically.

The org registry loads per call and is mtime-cached by the loader. A registry that fails to load degrades the result to the served roster with `orgRegistry: 'unavailable'` stated in the result — the directory is informational while `mailbox_send` enforces topology and admission regardless, so a degraded listing never widens what a seat can actually mail. Test seats render only in the never-mail group even when this host serves them: inviting mail to a test seat under "served" would steer the model into a guaranteed refusal.

## Alternatives considered

- **Roster-only listing (no org registry read)** — rejected: roles are what let a model pick the right recipient ("the department lead"), and the registry is already the seam's authoritative roster.
- **Residency/live-state in the listing** — deferred: live state lives in the bridge, and injecting it would couple the tool to the bridge's service for a nice-to-have. Who exists is the requirement; who is awake is not.

## Consequences

The tool schema grew a fourth entry (catalog regenerated), and `tool-mailbox` gained a `dsh-home-paths` dependency for the registry-path default. A deployment that points the bridge at a non-default `orgRegistryPath` should point the tools at the same file, so directory and bridge describe one org. The listing is read-only and identity-free, so it neither widens what a seat can mail nor leaks per-seat state.

## Testing

`packages/mailbox/tool-mailbox/tests/tool-mailbox.spec.ts` pins the zero-parameter schema and description contract, the roster-plus-registry merge with `served`/`lead`/`test` marks and alphabetical order, the render grouping (a served TEST seat renders only in the never-mail group), the registry-unavailable degradation to roster-only with the stated caveat, and anonymous-run use without identity.
