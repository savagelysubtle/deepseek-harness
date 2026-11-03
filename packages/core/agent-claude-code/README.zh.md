# @deepseek-ai/dsh-agent-claude-code

[English](README.md) | 中文

**Claude Code 席位驱动**包:席位保留自己的名称、邮箱、注册表条目与日志,只有"思考"改由官方 Agent SDK 在操作者自己的登录下运行未经修改的 `claude` 程序。与 [`agent-loop`](../agent-loop/README.md) 一样,该驱动是独立的包,通过 [`dsh-agent`](../agent/README.md) 中带键的 agent 工厂接缝注册;核心不依赖它。

本切片**只交付持久记录层**:事件词汇、脱敏记录器与不变量伴随插件。SDK 运行时位于 [`agent-claude-code-driver`](../../agent/agent-claude-code-driver/README.md);本包的 `apply` 保持惰性。

## 持久事件

十四个仅写日志的事件(无 surface,永不进入模型上下文),均带 `version: 1`。浏览器安全的 `@deepseek-ai/dsh-agent-claude-code/types` 子路径拥有载荷类型与 `SessionEventMap` 声明;生成的[持久化目录](../../../docs/persistence-catalog.md)列出了它们。

| 事件 | 写入时机 | 主要字段 |
|---|---|---|
| `claude-code/session-bound` | 席位首个提示之前,使崩溃不会丢失绑定 | dsh `sessionId`、`sdkSessionId`、`model`、`driver: 'claude-code'`、`at` |
| `claude-code/turn-completed` | 一轮的 SDK `result` 消息 | `turnIndex`、`outcome`(`success` 或 SDK 错误子类型)、`isError`、`numTurns`、`durationMs`、`durationApiMs`、`estimatedCostUsd`、`usage`、按模型的 `modelUsage`、可选 `stopReason` |
| `claude-code/steer` | 推送、中断后推送或恢复对席位进行了转向 | `kind`、经脱敏的简短 `reason`(最多 200 字符)、`at` |
| `claude-code/compact` | Claude 侧的 `compact_boundary` | `preTokens`、可选 `postTokens`、`trigger`(`auto` 或 `manual`)、`at` |
| `claude-code/rate-limited` | 观察到速率限制 | `source`(`sdk` 或 `http`)、可选 `retryAfterMs`、`breakerTripped`、`at` |
| `claude-code/resume-failed` | 恢复时找不到可读的 Claude 转录;席位需要明确的重新播种 | `sdkSessionId`、`reason`(`transcript-missing`、`transcript-unreadable`)、`at` |
| `claude-code/paused` | Claude 订阅窗口拒绝了工作(限流或用量耗尽):单席位暂停信号 | `reason`(`rate-limit`、`usage-exhausted`)、可选 `until`(纪元毫秒)、`at` |
| `claude-code/fleet-refused` | 队列限流器拒绝了一轮 | `reason`(`concurrency`、`turns-per-hour`、`breaker`、`founder-reserve`)、`limit`、`observed`、`at` |
| `claude-code/tool-call` | 一次工具调用结束(流映射器) | `name`、`ok`、`ms`、`argDigest`(大小或带密钥的摘要,绝不含参数或结果)、`at` |
| `claude-code/thinking` | 一个助手思考块 | 仅 `length`、`at` |
| `claude-code/unmapped` | 映射器不认识的流消息类型 | `type`、`at` |
| `claude-code/mail-claimed` | 认领了一条邮箱消息,在其提示之前已刷盘 | `messageId`、`tainted`、`at` |
| `claude-code/mail-outcome` | 已认领的邮箱消息结束 | `messageId`、`outcome`(`settled`、`failed`、`paused`)、`reason`、`at` |
| `claude-code/refused` | 一个回合或消息在运行前被拒绝 | `reason`(`admission`、`kill-switch`、`call-window`、`duplicate-in-flight`)、可选 `messageId`、`detail`、`at` |

`estimatedCostUsd` 是 SDK 给出的名义成本;在订阅下它只是用量信号,不是账单。

## 记录器

`recordClaudeCodeEvent(session, type, data, warn?)` 是唯一的写入者。它从不抛出异常,并返回事件是否已追加:

- 载荷由**具名字段重建**(白名单),因此未知字段、提示文本、工具结果正文、响应正文与响应头都无法夹带进去。速率限制响应中只保留 `retryAfterMs`。
- 自由文本(转向原因、outcome、停止原因)会去除控制字符、**脱敏令牌**(`sk-ant-…`、其他 `sk-…`、GitHub 令牌、Slack `xox*-`、AWS `AKIA…`、JWT、bearer,以及 `token`/`secret`/`password`/`api_key` 赋值(含带引号的 JSON 值),另加任何 40 个以上字符的类令牌串)、**脱敏路径**(以 `/` 或 `~` 开头且至少两段;日期、`a/b/c` 与 URL 尾部保持不变)并截断(500 字符;转向原因 200 字符)。标识符字段(`sessionId`、`sdkSessionId`、`model`)跳过长串与路径规则,因为带 cwd 盐的会话 id 本就可能超过 40 字符。
- 缺失、为负或非有限的 SDK 数值记录为 `0`。
- 追加前先把结果快照为无损 JSON;循环引用、恶意或无法记录的输入会丢弃该事件而不是让该轮失败。可选的 `warn` 接收一行丢弃原因(记录器自身没有日志器)。

## 不变量

`@deepseek-ai/dsh-agent-claude-code/invariant` 注册包伴随插件。冷加载与每次实时追加都要求:`version: 1`;各事件必需字段与枚举;`turn-completed`、`steer`、`compact`、`resume-failed` 之前必须已有 `session-bound`;`turnIndex` 严格递增。允许重复的 `session-bound`(重新绑定)。`rate-limited`、`fleet-refused` 与 `refused` 可以早于绑定出现,因为拒绝可能发生在会话开始之前;一次性的 `turn-completed`(带 `throwaway: true`,为被污染邮件的回合而写)从不需要绑定。它尚未挂入任何 bundle;组合随驱动一起落地。

## Known Limitations and Deferred Work

- **此处无运行时** — 基于 SDK 的 `Agent` 位于 [`agent-claude-code-driver`](../../agent/agent-claude-code-driver/README.md);工具策略、事件映射器与队列限额属后续切片。本包只记录它们上报的内容。
- **`turnIndex` 在每个 Session 内严格递增** — 若驱动在同一 Session 内重新编号,将被不变量拒绝。
- **脱敏基于形态** — 不匹配任何已知形态的凭据(例如没有键名的裸短密钥、被拆成多行的 PEM 块、短于 40 字符的 base64 串)不在范围内、无法被识别,因此正文与提示从不被记录。
- **S4 要求:恢复时播种 `turnIndex`** — 冷恢复或崩溃回退时,驱动必须以该 Session 最后一个 `claude-code/turn-completed` 的 `turnIndex` 加 1 作为起点;在已有 Session 内从 1 重新编号会被不变量拒绝。
