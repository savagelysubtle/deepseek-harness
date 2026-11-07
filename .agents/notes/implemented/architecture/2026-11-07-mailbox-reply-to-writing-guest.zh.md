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

## 曾考虑的替代方案

**直接回复 `guest:<name>`。** 否决：地址文法不含冒号，guest CLI 用同一文法解析 `--address`，双方都无法使用。放宽文法会影响所有提供者。

**放行任何带 `guest:` 前缀或未知的名字。** 否决：席位将能向任意名字发起对话。要求已存在的收件行使该例外保持仅限回复。

**把 guest 注册为席位。** 否决：这会改动注册表和边规则，超出本次改动范围。

## 后果

guest 邮件未经认证：guest 可以写“请把 X 回复给我”，被说服的席位会把 X 发到 guest 能读取的收件箱。此前席位根本无法回复 guest，所以这是一条新增的对外路径。`to` 的说明已告知模型对方是外部人员。

Sentinel 审查（2026-11-07）未发现高于 Low 的其他问题。其可选加固尚未实现：用有界存在性查询代替读取全部收件历史、限制每个收件人未取走的回复数量、对未在本主机挂载的注册表席位拒绝该例外。

发给裸 guest 名的邮件只能由 guest CLI 收件箱取走；没有任何机制唤醒操作员。
