# Agent Note: headless 命名会话 —— 用派生代替映射存储

Status: implemented

[English](2026-08-25-headless-named-sessions.md) | 中文

## Problem

`dsh --profile headless` 过去每次调用都跑一个全新会话。把一项长任务拆分到多次调用上的自动化流程，没有办法在不自己铸造和追踪会话 id 的前提下，把每次运行落到同一个持久会话里。

## Decision

- `sessionId = SessionId('named-' + sha256(name).hex[0..32))`。这 32 位十六进制后缀同时充当锁文件的文件名部分，因此一次哈希同时服务于身份标识与加锁。
- 创建还是恢复的判断，经由 `sessionPersistence.list()` 的成员关系检查已持久化日志是否存在（与 API remote 解析器使用的是同一原语），再据此调用 `agents.resume({resumeSessionId})` 或 `agents.create({sessionId})`。日志存在但无法加载时，`resume` 会响亮拒绝；不会有任何东西悄悄在一份损坏日志之上重新创建。
- 互斥使用每个名字一个的锁文件，位于 `headless/locks/<hash>.lock`，以 `O_EXCL` 创建，携带 `{pid, createdAt}`。陈旧性判定看持有者 pid 是否存活（`ESRCH` ⇒ 已死亡 ⇒ 接管）；存活的持有者会以退出码 1 响亮失败。释放前会先校验该文件是否仍记录着正在释放的持有者，再执行 unlink，因此一个被接管的失败者绝不会删掉其继任者的锁。接管重试有上限（5 次），使两个竞争的获取方不会陷入活锁。
- 所有解析逻辑都收拢在 runner 里一个显式的 `resolveRunSpec()` 步骤中；`run()` 消费一个封闭联合类型（`one-shot | named`），而不是在内联处反复为配置字段重新取默认值。
- 在 json 模式下，runner 订阅 `session/event` 消防水管，作用域限定在 followup 记录之前的 `seq >= firstSeq`，为每个 `assistant/message` 流式输出一行 NDJSON。行的形状 `{"type":"text","sessionID":...,"part":{"type":"text","text":...}}` 沿用既有 SDK 文本分片词汇，而不是发明一套仅限 headless 使用的信封；该模式下会抑制纯文本摘要。

## Verification

单元测试套件覆盖派生的确定性与文法校验、锁的获取/释放/接管/存活持有者拒绝（注入存活探测）、创建/恢复分支判断、NDJSON 形状与 firstSeq 作用域、摘要抑制，以及失败路径上的锁释放。一个真实组合的 Loader 测试针对一个脚本化模型，在 JSONL 后端上把发布中的循环启动两次：第一次运行创建并流式输出结构良好的 NDJSON；第二次运行恢复该会话，其模型请求中包含此前的对话内容。

## Alternatives considered

- **在 harness home 下维护一个每次运行都要查阅的 name→id 映射存储**：否决。在本 bundle 关心的每一个维度上，映射都不如派生。映射意味着又多创建一份文件，会在 rename 与内容写入之间被 SIGKILL 撕裂，也会在两次调用为同一个名字竞争首次运行时损坏——而这恰恰是命名会话本该服务的那类并发场景。派生（`named-<sha256(name)[0..32)>`）改为让每个进程都计算出相同的答案，且不存在任何共享可变状态；没有什么需要创建、为自身完整性加锁，或需要清理。这一代价是刻意接受的：名字无法被枚举（调用方自己拥有名字映射），这作为一项已知限制被记录下来，而不是被隐藏。
- **把人类可读的名字记录在 `SessionHeader` 上，靠 header 查找来恢复**：否决。这会把会话格式和一个展示层关注点耦合在一起。给 header 加一个字段，会波及 `SESSION_FORMAT_VERSION`、两个持久化后端各自的校验，以及每一个投影消费方——为了一项可选的便利性而带来版本号上调压力。而且它仍然需要一个针对 header 的查找索引来把 name 解析为 id，在更差的分层位置重新引入了映射问题。如果未来某个表面确实需要头等公民的名字，那应该是会话格式自身的一次变更所决定的事，而不是某个 bundle 的补丁。

## Consequences

命名会话可以跨进程工作，除了文件系统之外不需要任何协调者。调用方自己拥有名字枚举，而 pid 存活判定的陈旧性规则接受一个狭窄的接管竞态（pid 复用或同时接管），已记录在 README 的已知限制中。
