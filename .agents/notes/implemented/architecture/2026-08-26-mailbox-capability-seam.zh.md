# Agent Note: mailbox 能力 seam —— 跨进程的持久化 agent 消息传递

Status: implemented

[English](2026-08-26-mailbox-capability-seam.md) | 中文

## Problem

harness 的驻留按设计是进程本地的：可继续子 agent 的 Activation 与收件箱不会跨进程协调（`subagent` README，已知限制）。要从外部寻址长期存活 agent 的自动化——Slack 机器人、舰队调度器、另一个仓库里的 agent——恰好只有两个选择：调用 headless 运行（在命名会话落地之前，调用之间是无状态的），或者直接伸手进持久化内部实现。两者都不提供消息持久性、投递状态追踪，或跨项目寻址。opencode fork 里对应的功能发布了一个 peer-mailbox 工具，其后端是一张它自己的发送路径从不写入的表（`session_peer_message`，0 行）——有持久化的寻址，却没有持久化的投递。

## Decision

一个新的 `mailbox` 能力组，遵循 Service Definition / Provider / Consumer 模式：

- `dsh-mailbox`（本次改动）定义了带品牌的 `MailboxAddress`/`MailboxMessageId`、`MailboxState` 状态机（`pending|claimed|done|failed`）、`MailboxProvider`（publish/claim/settle）、`ctx.mailbox` 注册表服务、`<namespace>:<name>` 地址文法（预留了一个 chair-to-chair 解析扩展点，供跨 temple 路由策略使用），以及可合并扩展的 `mailbox` 消息来源种类。
- Provider 拥有传输与租约。队列认领是 STORE 拥有的条件更新（`pending`→`claimed`，附带陈旧认领的回收）；会话驻留仍然是来自 `dsh-named-sessions` 的 pid 存活锁。这两种互斥是刻意区分开的，绝不能被混为一谈。
- 一个桥接插件（后续改动）把已认领的消息排空进已寻址的 Agent：存活的 agent 收到 `followup()` 轮次；休眠的 agent 先冷恢复。投递完成意味着**收件箱已准入**，绝不是轮次的结果；结果作为新的出站消息传播。投递是至少一次；来源信息携带 store 的 id，使接收方能识别出崩溃窗口内的重复。
- 送达的内容是一个携带 `{ kind: 'mailbox' }` 来源信息的普通 user 角色轮次——是事实，不是指令；接收方 agent 对 mailbox 输入进行推理，绝不会自动执行它。没有新增事件种类；日志版本不升级。
- 认证通过 credentials seam 面向每个消费方各自的 `sb_secret_*` 密钥，并由 store 端 RLS 强制执行；自定义 JWT 铸造在非对称密钥的 Supab 项目上被实测证明已经失效，只作为遗留/自托管兜底路径保留。

## Verification

单元测试套件覆盖地址文法的往返转换与校验、重复 provider 注册拒绝（响亮失败）、认领过滤器不变量拒绝，以及消息来源种类的折叠。真实组合的覆盖随桥接切片一起到来（针对一个脚本化模型、经 Loader 的产品可见投递），依据面向产品可见插件的测试策略执行。

## Alternatives considered

- **把子 agent 续行管理器扩展到跨进程**：否决。驻留的所有权关系图是刻意做成进程本地的；在其内部再放一个协调状态机，会把每一条拆卸顺序规则都翻倍。
- **把名字记录在 `SessionHeader` 上**：否决。这会把会话格式重新耦合到一个展示层关注点——见 named-sessions 笔记。
- **在队列存储里使用 pid 产物**：否决。崩溃的持有者会卡死租约，而陈旧时间戳回收机制本可以直接化解这个问题。

## Consequences

Agent 现在可以跨进程、跨仓库地被稳定的名字从外部寻址，同时会话格式保持不变。地址目录归 store 所有，这让一个舰队状态视图之后可以被派生出来，而不违反命名会话不可枚举的原则。未知地址会按消息各自响亮失败，而不是被悄悄排入队列。崩溃窗口内的跨进程重复投递仍然可能发生——这是被接受的，会在各 provider 的 README 落地时逐一记录。
