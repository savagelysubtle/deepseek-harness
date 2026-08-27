[English](README.md) | 中文

# agui/ — AG-UI 对外投影族

将会话活动以只读方式投影到 [AG-UI 协议](https://docs.ag-ui.com)，外部仪表盘据此渲染 agent 运行，无需触及 harness 核心。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`ag-ui/`](ag-ui/README.md) | 持有自有 `node:http` 监听器，把 `session/event` 翻译为 AG-UI 帧的 SSE 端点。 | （不注册 ctx 服务） |

适配器是白名单翻译器：未映射的会话事件一律丢弃、绝不转发，插件合并的事件词汇因此不会泄漏到对外线路。会话日志始终是事实来源；本族只做投影。
