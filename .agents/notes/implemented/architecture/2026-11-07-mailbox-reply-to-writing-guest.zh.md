# Agent Note：harness 席位可以回复先来信的外部操作员

状态：已实现

[English](2026-11-07-mailbox-reply-to-writing-guest.md) | 中文

## 问题

Claude 席位通过 guest CLI（`dsh-mailbox send`）联系 harness 席位，CLI 把发件人存为 `guest:<name>`。harness 席位无法回复：`mailbox_send` 会拒绝既不在服务名册中、也不是组织注册表席位的目的地，而邮箱地址文法不含冒号，所以 `guest:<name>` 不是合法目的地。

## 决定

`mailbox_send` 在目的地被拒绝时，用 `isReplyToWritingGuest`（`packages/mailbox/tool-mailbox/src/tools.ts`）再检查一次。若发送席位自己的收件行（对发送者地址调用 `lookupInboundSince`）中有一行来自 `guest:<目的地>`，则放行。回复存入裸目的地名，操作员用 `dsh-mailbox inbox --address <name>` 读取。

- 仅限回复：该行必须已存在，且必须发给发送席位本身；因此席位不能主动开启对话，写给其他席位的 guest 也不符合条件。
- 服务名册和组织注册表两条拒绝路径都经过同一检查。
- 与真实席位同名的 guest 得不到任何额外权限：真实席位名在此例外之前已由常规检查放行。
- 提供者、注册表、边规则和地址文法均未改动。

## 未做

发给裸 guest 名的邮件只能由 guest CLI 收件箱取走；没有任何机制唤醒操作员。
