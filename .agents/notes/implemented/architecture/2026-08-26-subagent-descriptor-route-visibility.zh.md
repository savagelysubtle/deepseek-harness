# Agent Note：通过一次性描述符 v3 实现 subagent 路由可见性

状态：已实现

[English](2026-08-26-subagent-descriptor-route-visibility.md) | 中文

## 问题

扩展持久化目录决策（[2026-07-22-durable-subagent-catalog-and-list-agents](../feature/2026-07-22-durable-subagent-catalog-and-list-agents.md)）与其引入的身份投影（[2026-08-06-subagent-list-identity-projection](2026-08-06-subagent-list-identity-projection.md)）；两者均不被取代。审计发现的缺口：`listChildren()` 名册携带模式／标签／计时，却从不显示 child 跑在哪个模型上——一次性描述符甚至根本没有记录它（见 `interagentstuff/plans/background-lifetime-findings-2026-08-26.md` §2.6），因此一次性 child 的按次模型归因无从谈起，可继续 child 的归属也无法暴露。

## 决策

刻意的描述符版本升级 v2→v3：为 ONE-SHOT 分支增加可选的 `agentProvider`／`agentModel`，在唯一的 `start()` 快照点按可继续分支已有的方式解析（声明覆盖项，否则沿用父级路由）。身份投影在两个分支上都携带这两个可选字段（schema 与 `stateVersion` 一同升级，使陈旧检查点强制重折），枚举行原样透传，三个读取面按数据原样消费——`list_agents` 在状态之后渲染 ` model=<provider>/<model>`，浏览器目录在 mode 之前显示 `provider/model`，api-proxy 的 wire 行增加可选字段。未知键严格性与首事件胜出折叠均未触动；旧日志只是不渲染路由。effort 级别明确不在范围内：树中没有任何地方持久化 effort。token 用量归因继续延后（usage 块位于 child 日志中，需要独立的投影决策）。

## 备选方案

- 从独立的会话事件投影 provider／model，而非扩展现有描述符——否决：描述符已拥有"child 声明组合"这一职责，第二个来源需要为 fork 种子另建一套重置／折叠机制。
- 必填路由字段并做 v4 式硬升级——否决：路由今天是真实可选的（存在不带 options 的最小 agent）；可选性让旧日志仍可分类。
- token 用量投影并入本次变更——延后：usage 块需要新的单元设计；混入版本升级会放大一次本属增量的变更的影响面。

## 后果

只要记录性描述符带有路由，每个被枚举的 child 行都会显示其模型；Steve 的指定升格策略由此在名册层面变得可审计。

验证随扩展后的 service／list／control 套件运行，另加一条真实 spawn 断言端到端钉住渲染出的路由（`model=mock/mock`）。
