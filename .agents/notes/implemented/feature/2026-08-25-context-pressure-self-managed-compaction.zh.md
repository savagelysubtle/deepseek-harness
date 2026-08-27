# Agent Note: 上下文压力警告与模型发起的延迟压缩

Status: implemented

[English](2026-08-25-context-pressure-self-managed-compaction.md) | 中文

## 问题

模型看不到自身上下文窗口的压力。压缩仅在纯后端阈值（`compaction-basic`，当时为窗口的 0.8）处自动触发，没有任何模型可见的用量通告，因此模型无法规划 token 开销、无法根据剩余预算安排繁重工作、也无法选择何时凝缩对话历史。人类拥有 `/compact`；模型既没有等价物，也没有信号。

## 决策

两个可选插件为模型提供了信号与执行器：

- [`@deepseek-ai/dsh-context-pressure`](../../../../packages/context/context-pressure/README.md) 监听 `agent/pre-step`，通过 `ctx.tokenMeter` 计量用量；当测得总量越过路由模型窗口的某个阈值时，追加一条插件来源的 user 消息，说明已用百分比、总 token 数与剩余 token 数。阈值默认 `[0.25, 0.5, 0.75]`，校验升序、唯一、位于 (0,1)，加载时快速失败。每个压缩代内每个阈值只告警一次；出现更新的 `compaction/end` 时全部阈值重新武装；已告警状态由日志扫描推导，重启不会重复告警。没有新增 `SessionEventMap` 事件：警告就是一条普通的可持久化 `user/message`，带插件来源，经由 time-context 模式满足 model-visible⟺logged。
- [`@deepseek-ai/dsh-tool-compact`](../../../../packages/compaction/tool-compact/README.md) 注册无参数的 `compact` 工具。调用即武装进程内待处理状态并立即返回；代理下次进入 idle 时，运行器消费该武装并在引擎现有的维护认领与 `compaction/start` 锁内调用 `ctx.compaction.compactNow()`。被唤醒发送赢得边界竞争时表现为 `ManualCompactionError('busy')`，运行器重新武装该调度以等待下一边界。这有意反转了先前记录在 [command-compact](../../../../packages/compaction/command-compact/README.md) 的仅限人类命令策略；压缩现在拥有两个 Consumer——人类的 `/compact` 命令（立即）与模型的 `compact` 工具（延迟到 idle）。

`compaction-basic` 的 `DEFAULT_THRESHOLD_RATIO` 由 0.8 调至 0.95：阈值警告负责早期规划，95% 是硬性兜底，提供方确认的溢出重试路径仍是最后手段。

本设计扩展了[排队手动压缩](2026-07-30-queued-manual-compaction.md)拥有的准入规则：该工具不添加第二个队列、不添加额外互斥锁，唤醒提示的 FIFO 优先权依然赢下每一次边界竞争。

## 已考虑的替代方案

- **为警告与准入新增 `SessionEventMap` 事件。** 否决：`SurfaceEventType` 是封闭联合，新事件类型需要改动 core/session、token-meter 折叠与 deriveMessages，还会复制持久化 user 消息已承载的事实——同一事实两个家。插件来源消息可重建且零格式变更、版本稳定。
- **在工具调用内同步压缩。** 否决：`compactNow` 在步骤中途按构造即抛出 busy，且在活动回合下变更消息表面会与循环对进入请求的所有权相冲突。
- **为模型请求建第二条准入队列。** 否决：提示优先于直接控制，与收件箱平行的队列会重现排队压缩决策已解决的优先级倒置；经由普通 idle 认领做延迟保持单一 FIFO。
- **自动刷新保持在 0.8。** 产品负责人否决：警告自 25% 起开始规划后，80% 的强制刷新让模型没有余地执行自己的调度；95% 恢复了该余地，而溢出重试约束了尾部风险。

## 后果

所得：模型看到真实预算数字并能据此排序工作；每条警告约六十 token，每个压缩代内每阈值一次，且文本字节稳定利于 KV 复用。所失：武装的调度只存在于进程内存，崩溃即丢失，模型在观察到无检查点后会重新调用；最后一条警告与强制刷新之间的区间的配置而非代码，偏好旧有静默 0.8 行为的操作者必须显式固定 `thresholdRatio`。记录的坑：schemastery 在 schema 创建时就把省略的数组配置物化为 `[]`，因此数组默认值必须在 schema 字段上用 `.default([...])` 声明，否则永不生效。

## 测试

`context-pressure` 的 Loader 组合测试驱动真实发行版代理循环越过阈值，逐字固定警告文本，断言跨回合单次触发去重，并通过 `deriveMessages()` 证明模型可见。`tool-compact` 套件覆盖调度 → idle 运行、同步与异步 busy 重武装、处置静默（含重武装后处置，经变异验证）及其不变量伴随件。`jsonrpc-agent` 示例组合两个插件；其无钥匙冒烟断言装配后的工具清单，其快照场景干净回放。
