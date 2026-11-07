# Agent Note: The org board cannot delete or rename a claude-code seat

Status: implemented

English | [中文](2026-11-07-op-296-b2-claude-code-seat-delete-refusal.zh.md)

## Problem

`org.write` already refuses a save that drops the `claude-code` driver from a row that is still present under the same name. A save that deletes the row, or renames it (which reaches the host as a delete plus an add), passed that check because it only looks at rows kept under the same name. The ticket (OpenProject #296, item 7) records that a claude-code seat could be removed from the board silently.

## Decision

`org.write` (`packages/host/apiproxy/src/api-proxy.ts`) also refuses a document that omits an on-disk row whose driver is `claude-code`. The refusal code is `org-registry-rejected` with a message starting `org-registry-driver-seat-removed:`. It names the seat, says the board cannot recreate the on-disk driver settings, and gives the remedy: edit the registry file by hand and restart the host. Nothing is written. Ordinary default-loop seats can still be deleted from the board.

## Alternatives considered

**A confirm step in the board.** Rejected: the write API has no confirmation channel, and a client-side confirm would not stop another caller of `org.write`.

**Allow the delete and warn.** Rejected: a claude-code row holds driver settings that the board cannot recreate, since the board cannot set the driver, so the delete loses state the board cannot restore.

## Consequences

An operator who really wants a claude-code seat gone edits the registry file by hand. The refusal is visible in the board's save error, with the remedy in the same message.
