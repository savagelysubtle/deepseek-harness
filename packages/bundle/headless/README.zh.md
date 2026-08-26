# `@deepseek-ai/dsh-headless`

[English](README.md) | 中文

dsh 一次性任务组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.md) 之上：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 Code Mode 的 worker 作为核心执行能力挂载，并插入本包的 `headless-runner` 插件（配置为 `{task}`，从注入的 `headlessStartup` 提供方解析）。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

Loader 结算后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md)，通过 `ctx.agents` 创建或恢复一个持久化 Agent（智能体），将任务作为普通用户消息提交，并等待完全停稳。它对 Session 执行 flush 后再汇总自身持有的持久化事件区间，按请求的输出格式报告 assistant 输出，再经启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.md)）请求退出（最终 `turn/end` 完成 → 0，否则为 1）。最终结束原因为 `error` 时，还会将 code 与 message 写入 stderr；成功运行时 stderr 保持为空。进程不会打开监听端口。

任务文本与输出旗标就是这个应用的命令行：普通 `headless-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)），解析 `dsh --profile headless [flags] "task"`、打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再从惰性配置中解析（[`src/index.ts`](src/index.ts) 中的 `resolveRunSpec()`）。缺失或只有空白的任务会在 runner 激活前被拒绝。

## 旗标

| 旗标 | 效果 |
| --- | --- |
| `--session-name <name>` | 定位于一个具名持久会话，而不是全新的一次性会话。任务位置参数仍然必填。 |
| `--format <text\|json>` | 输出格式；默认为 `text`。未知值是用法错误（退出码 1）。 |

## 具名会话

传入 `--session-name <name>` 时，会话 id 从名称确定性地派生：`named-<sha256(name) 的前 32 个十六进制位>`（[`@deepseek-ai/dsh-named-sessions`](../../session/named-sessions/README.zh.md)）。不存在需要创建或损坏的「名称→id」映射存储——每个进程对同一名称计算派生都会得到同一个持久 id。若该 id 下没有已持久化的日志，runner 调用 `agents.create`；若已存在，则调用 `agents.resume`。「日志存在但无法加载」时会大声抛出持久化后端的错误，而不是悄悄重建。名称必须匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`，因为它要作为磁盘上的文件名组成部分；非法名称是用法错误（退出码 1）。

同一名称的并发调用通过 `<home>/headless/locks/<hash>.lock`（`DSH_HOME`，默认 `~/.dsh`）的每名称锁工件互斥。该工件以 `O_EXCL` 创建，内容为 `{pid, createdAt}`。持有进程 pid 已死（`ESRCH`）即视为过期并接管其工件；持有进程仍存活则调用大声失败：`session "<name>" is active in another process`（退出码 1）。锁在本次运行落定后释放，包括失败路径。

### 输出格式

- `text`（默认）：打印本次运行区间内最后一条非空 assistant 消息。
- `json`：对本次运行区间内的每个 `assistant/message` 事件流式输出一行 NDJSON，形状精确为：

```json
{"type":"text","sessionID":"<id>","part":{"type":"text","text":"<拼接后的文本块>"}}
```

  早于本次运行首个 seq 的事件绝不输出，纯文本摘要被抑制。

## 模型体验

无影响，因为 runner 把任务作为普通用户消息提交；提示词与工具由 base 和 headless 组合包中的相应条目提供。

#### KV Cache 影响

无；runner 不向请求前缀添加任何内容。

## 已知限制与暂缓事项

- **只提交一个任务**：runner 没有用于交互式后续输入的 surface；它会等待 Agent 在返回 idle 前完成的所有工作，并报告该区间内最后一条非空 assistant 消息。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 headless profile 会在激活时明确报错，直到宿主提供该退出请求。
- **无法枚举名称**：派生方案不依赖映射存储，harness 无法列出已存在的会话名称；名称映射由调用方自行维护。
- **锁接管的窄竞态窗口**：过期判定基于持有进程的 pid 存活性，因此 pid 复用或两个获取进程之间的接管竞态可能在极窄窗口内把锁交给错误的进程。
