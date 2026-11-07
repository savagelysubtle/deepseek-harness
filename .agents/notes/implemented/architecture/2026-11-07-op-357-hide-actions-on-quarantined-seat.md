# Agent Note: The board hides Remove seat and Change served status on a quarantined seat

Status: implemented

English | [中文](2026-11-07-op-357-hide-actions-on-quarantined-seat.zh.md)

## Problem

The detail panel of a quarantined seat still showed Remove seat and Change served status. The host refuses both writes for a quarantined row, so the operator pressed a button and received a refusal (OpenProject #357).

## Decision

`OrgBoard.tsx` renders the two buttons only when the selected row has no `invalid` field. The Close button, the quarantine reason and the other read-only rows stay. The host's refusal is unchanged and remains the enforcement.

## Alternatives considered

**Show the buttons disabled.** Rejected: a disabled button on a row the operator cannot repair from the board invites the question of what to do; the quarantine reason row already names the file to fix.

**Remove the host's refusal.** Rejected: out of scope, and the refusal protects the registry file from a rewrite that would drop the quarantined row.

## Consequences

A quarantined seat is read-only in the panel, matching what the host accepts. A seat whose row is repaired in the file shows the buttons again after the next refresh.
