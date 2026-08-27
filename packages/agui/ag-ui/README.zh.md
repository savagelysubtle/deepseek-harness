[English](README.md) | 中文

# @deepseek-ai/dsh-ag-ui

[AG-UI](https://docs.ag-ui.com) 出站适配器：订阅持久化会话事件与实时 agent 失败，经严格白名单翻译后以 Server-Sent Events 供出，外部仪表盘由此观察 agent 运行。只读——挂载不注册任何工具、提示或模型可见内容。

端点运行在本插件**自己的 `node:http` 监听器**上，绝不挂在 Web-GUI 服务器上：后者按约定仅服务浏览器、绑定回环且不认证，而本表面暴露会话内容，自带 bearer 认证。挂载是可选的；部署时请置于终结 TLS 的网关之后。

## 端点

`POST /ag-ui/:threadId` → `200 text/event-stream`

- `threadId` 即会话 id（AG-UI 的 thread）。未知 id → `404`；格式非法 → `400`。
- 请求体为可选 JSON 对象 `{ "runId": string }`（1..256 字符），提供该连接的 run-id 基值；空体则自动生成。
- 帧格式为 `event: <TYPE>\ndata: <json>\n\n`。新建连接先收到 `MESSAGES_SNAPSHOT`（由已提交日志投影），若已有开启的 turn 则紧跟合成的 `RUN_STARTED`，随后为实时帧。
- 每 turn 的 run id 为 `<base>-<turn>`，同一连接上的先后 turn 由此区分。
- 每 `keepAliveMs` 写一条 `: ping` 注释保活。

## 事件映射

| dsh 事件 | AG-UI 帧 |
|---|---|
| `turn/start` | `RUN_STARTED {threadId, runId}` |
| `assistant/chunk` text-delta | `TEXT_MESSAGE_START`（首个）+ `TEXT_MESSAGE_CONTENT {delta}` |
| `assistant/chunk` tool-call-delta | `TOOL_CALL_START {toolCallId, name}`（首个）+ `TOOL_CALL_ARGS {delta}` |
| `assistant/message` | 关闭未决的 `TEXT_MESSAGE_END` / `TOOL_CALL_END` 括号 |
| `tool/call`（未经流式的调用） | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` 三帧 |
| `tool/result` | `TOOL_CALL_RESULT {toolCallId, content}` |
| `turn/end` completed | `RUN_FINISHED` |
| `turn/end` error，或运行中 `agent/error` | `RUN_ERROR {message}` |
| `approval/asked` | `CUSTOM {name: "dsh.approval.requested"}`（仅展示） |
| 其余一切 | 丢弃，并在每连接一条调试日志中计数 |

**白名单契约**：每个映射类型都是显式 `switch` 分支。未映射的事件类型与 chunk 子类型递增 `BracketState.droppedUnmapped` 且不产生任何帧——插件合并的词汇必须先在此显式登记，才允许跨越本包的信任边界。

## 配置

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `host` | string | `"127.0.0.1"` | 监听绑定地址。 |
| `port` | number | 必填 | TCP 端口；`0` 表示临时端口。 |
| `bearerToken` | string | 必填 | 至少 8 字符；加载时校验（配置错误即刻失败）。经 SHA-256 摘要用 `timingSafeEqual` 比较。 |
| `keepAliveMs` | number | `15000` | 保活注释间隔。 |
| `maxBufferedEvents` | number | `256` | 每连接队列上限；溢出时该流以终止 `RUN_ERROR` 帧优雅收尾，同线程其他连接不受影响。 |

认证失败在路由之前应答 `401` 与 `WWW-Authenticate: Bearer`，未认证探测因此探不到任何路径信息。

## 扩展点

无对外扩展点。帧流的消费者实现任意 AG-UI 客户端即可；协议要求容忍未知事件类型，而本服务器从不发送上述并集之外的类型。

## Model Experience

无——没有任何内容进入模型请求。投影只读日志、只写套接字。

#### KV Cache 效应

无。

## Known Limitations and Deferred Work

- 无 TLS：请在本监听器之前的网关终结 TLS。
- 仅观察：审批以仅展示的 `CUSTOM` 转发；转向、注入与运行触发留在其他表面（ACP、CLI）。中断往返推迟到仪表盘需要时再做。
- 运行中接入的连接可见已提交历史加合成括号；开启步骤的在途 chunk 增量仅在接入后开始的步骤中出现。
- 组装 SSE 转录的无密钥快照场景尚未接入 `test:snapshot`；单元与组合覆盖见 `tests/`。
