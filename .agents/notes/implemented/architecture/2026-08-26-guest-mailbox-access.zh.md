[English](2026-08-26-guest-mailbox-access.md) | 中文

# Agent Note：访客邮箱访问——宕机期存储接口与排水时治理

Status: implemented

## 问题

外部议事席恰恰因为 harness 出故障才被请来；在 2026-08-26 的 `dsh web` 宕机中，没有任何通往席位的通道——每条消息都由 Steve 人工搬运。桥接插件救不了这个场景：它会随故障的插件树一起死掉（自举悖论）。然而多进程 SQLite 存储在设计上本就是多写入者并发面；缺的只是访客的人体工学与治理。

## 决策

同一地址空间上的两条路径，按宿主健康度选择。路径 A（宿主在线）：已落地的 `mailbox.publish` RPC。路径 B（宿主宕机）：随 `@deepseek-ai/dsh-mailbox-local` 附带的新 `dsh-mailbox` 命令行，把写入者与 `SCHEMA_VERSION` 版本锁定在同一包内，不会漂移触发自己的兼容门禁。

- 访客永远可发布，并在到达时排空自己的收件箱（claim + 落定 `done`；`--peek` 退回 `pending`）。没有推送面：访客不是常驻进程。
- 首写者安全：文件创建（目录 `0700`／文件 `0600`）收拢到插件挂载与 CLI 共用的唯一入口 `openLocalMailbox`，宿主外的首次写入绝不回退到环境 umask；不存在会分叉的第二条复制粘贴创建路径。
- 排水时准入（`admitFromNamespaces`，默认空即 fail-closed）：外部写入者在构造上就绕过一切写侧检查，因此外来来源邮件的接受与否在路由前的 `deliverLease` 里裁决。不可解析的发送方一律关闭。chairs-only 由组合而非代码成立——只有主席桥选择加入 `['guest']`。
- payload 隔离前提（议事席发现的 DoS）：此前一条坏 payload 行会让所有地址的整个认领批次瘫痪。认领循环现在隔离这些行（以认领取得所有权、提交后落定 `failed/malformed-payload`），兄弟消息照常投递。

按议事席对照表否决：claudecode-bridge 插件（自举悖论）；对接 Claude Code 自带消息（传输不符且仅达活会话）；给 MailboxProvider 加 `peek()`/`list()`（claim+settle-pending 已表达非消费读——PR-B 契约保持冻结）；推送给访客（访客不可寻呼）；写时执法（构造上不可能）；独立 guest-mailbox 包（约两百行的仪式感）。

差异所及之处的勘误已记录：plan 配置字段是 `path`（→ `mailbox.db`）而非 `databasePath`（→ `.sqlite`）；席位约定为冒号形式 `<namespace>:<name>`（`gotham:alfred`），而非斜杠；包目录名与包短名的分歧已标注于计划包表。

## 验证

CLI 套件：payload 文件往返、`--peek` 不消费、响亮的 schema 版本拒绝、写入前文法拒绝、双 payload 来源冲突、POSIX 首写者权限、经执行守卫的真实 bin 管道 stdin。存储套件：坏 payload 行被隔离而同批兄弟照常投递（议事席测试 4）。桥套件：宕机引导（无宿主时 CLI 写入、挂载内联排水送达休眠席位）、准入门默认关闭、已准入访客投递、不可解析发送方关闭。组合套件（真实 Loader）：默认组合下访客邮件落定 `failed/sender-not-admitted`，花名册选择加入后端到端送达。

## 后果

议事席在其存在的唯一窗口内变得可达：harness 宕机之时。席位答复访客的方式是向无人服务的 `guest:<agent>` 地址发布——这是有意的「停放」地址、由带外排空；PR-F 的发送工具必须让停放目的地走普通 `ctx.mailbox.publish()`（绝不走 roster 门禁的 `publishAndWake`）。访客邮件的审计保留仍是开放策略；当前回执落定 `done` 并自然老化。
