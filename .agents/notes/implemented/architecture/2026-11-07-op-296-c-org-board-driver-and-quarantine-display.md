# Agent Note: The org board shows quarantined rows and driver fields

Status: implemented

English | [中文](2026-11-07-op-296-c-org-board-driver-and-quarantine-display.zh.md)

## Problem

The org registry parser quarantines a seat row it cannot accept and reports the reason as a read-only `invalid` field on the view. Rows can also select the `claude-code` driver with `admit_from` and `admit_sender_classes`. The board rendered none of these, so a quarantined seat looked like a healthy one and only the save refusal told the operator (OpenProject #296, item 8).

## Decision

The board renders these fields read-only, from the view it already receives. No wire, store, or write path changed.

- **Seat node.** `seatBadges` (`packages/client/ui-org-board/src/client/derive.ts`) adds an `invalid` badge (error colour, with a red node border, like an unserved seat; the served dot is not drawn for a quarantined seat) and a `driver` badge (neutral outline) for `driver: claude-code`. Both appear in the legend row.
- **Detail panel.** `OrgBoard.tsx` shows `Driver`, `Admits mail from`, `Admitted sender classes`, and `Quarantined (read-only)` with the parser's reason, each only when the row has the field.
- **Item 9 (guest senders).** No change: `admit_sender_classes` is displayed as stored, and guest senders stay out of claude-code seats until the S8 lease sink.

## Alternatives considered

**Editable driver fields on the board.** Rejected: the board's document is the already-parsed view and cannot carry quarantined keys; slice B2 and the dropped-driver refusal keep the driver off the board's write path.

**Only a badge, with the reason in a tooltip.** Rejected: a tooltip is not available on touch screens, and the reason is the part the operator needs to fix the file.

## Consequences

An operator sees a quarantined seat and its reason without saving. The new strings are in the `orgBoard` locale namespace (English and Chinese).
