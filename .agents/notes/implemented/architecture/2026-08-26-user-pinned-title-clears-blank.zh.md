# Agent Note: 用户钉住的标题清除会话 blank 位

Status: implemented

[English](2026-08-26-user-pinned-title-clears-blank.md) | 中文

## Problem

`SessionSummary.blank` 此前只从单一事实推导：日志中没有 `turn/start`。以编程方式创建并在首个轮次之前命名的会话——dsh web GUI 中的代理创建具名席位，即持久议事席位的常设工作流——始终保持 `blank: true`。所有客户端都会把这类会话从列表中隐藏，并可能把该行再次当作 workspace 的临时 New Session 目标发出；于是一个已创建、已命名的席位在被发送第一条消息之前始终不可见。隐藏规则本身（「blank 即占位符」）是对的；错的是它背后的存在性判定过窄。

## Decision

用户来源的 `session/title` 事件现在与 `turn/start` 一样证明存在性。一个谓词驱动此前重复轮次检查的全部三处推导：附加摘要的日志折叠、增量式 `sessionListMetadata` 投影，以及冷会话小工件探测。自动标题（内建回退或提供方）仍然不清除 blank——元数据噪音不得翻转可见性；只有显式的人工重命名才断言身份。

一个被有意接受的副作用：`agentPreset.select` 从重命名时刻起锁定，而不是首个轮次，因为它复用同一谓词。标题事件不携带任何工具历史，所以该锁定偏保守而非正确性所必需；具名席位的组合自命名起即视为已提交。

## Alternatives considered

**客户端豁免：显示带有缓存标题投影的 blank 行。** 否决：每个界面（列表、搜索、New Session 复用、fork 树）都要重新推导该规则，而且冷行在检查点持久化之前完全没有缓存标题——恰恰是本修复要解决的「刚重命名」场景。

**在 `blank` 之外增加第二个服务端比特（`titled`）。** 否决：用两个比特回答一个问题（「该会话是否已成为真实存在？」）会把变更波及 wire schema、projection cache 和每个客户端谓词，而「两者永不同真」的不变量只能靠约定而非构造来维护。

## Consequences

具名席位一经重命名即在所有客户端可见，先于任何轮次；New Session 复用自然跳过它们，因为它们不再是 blank；内容搜索在其有标题后即纳入。未受影响的部署看不到任何变化：无人重命名的会话保持旧行为，且有界冷探测的成本只增长于那些事件本来就小到足以读取的日志。

## Related

[有界冷空白验证](../bug-fix/2026-08-13-bounded-cold-blank-verification.md) 拥有冷探测的资格阈值与安全方向；该探测运行的精确折叠现在携带此处决定 user-title 子句。
