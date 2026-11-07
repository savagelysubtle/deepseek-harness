# Agent Note: A harness seat may reply to an outside operator that wrote first

Status: implemented

English | [中文](2026-11-07-mailbox-reply-to-writing-guest.zh.md)

## Problem

A Claude seat reaches a harness seat through the guest CLI (`dsh-mailbox send`), which stores the sender as `guest:<name>`. The harness seat could not answer: `mailbox_send` refused any destination that is neither in the served roster nor an org registry seat, and the mailbox address grammar has no colon, so `guest:<name>` is not a valid destination.

## Decision

`mailbox_send` re-checks a refused destination in `isReplyToWritingGuest` (`packages/mailbox/tool-mailbox/src/tools.ts`). The send is admitted when the sender's own inbound rows (`lookupInboundSince` on the sender's address) include one from `guest:<destination>`. The reply is stored at the bare destination name, and the operator reads it with `dsh-mailbox inbox --address <name>`.

- Reply only: the row must already exist and must be addressed to the sending seat, so a seat cannot open a conversation and a guest that wrote to another seat does not qualify.
- Both refusal paths (served roster and org registry) pass through the same check.
- A guest named like a real seat gains nothing: a real seat name is admitted by the ordinary check before this exception runs.
- No provider, registry, edge rule, or address grammar changed.

## Not done

Mail to a bare guest name is drained only by the guest CLI inbox; nothing wakes the operator.
