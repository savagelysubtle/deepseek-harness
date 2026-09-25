[English](README.md) | 中文

# UI 参考截图

正在运行的 web UI 的截图，留存下来是为了让接手前端工作的任何人在改动之前
能看清现状。截取自一个真实运行的 host，不是 mock 出来的。

**这些截图是一条基线，不是一个目标。** 它们记录的是截取当天 UI 的样子。当 UI
发生有意的改动时，新增一个带日期的文件夹，而不是覆盖旧的——文件夹之间的差异
才是有用的产物。

## 这些截图是如何截取的

`playwright-cli` 对准 `http://127.0.0.1:3080` 上一个真实运行的 host，视口
1280×720：

```bash
playwright-cli open http://127.0.0.1:3080
playwright-cli click <ref>          # refs come from `playwright-cli snapshot`
playwright-cli screenshot
```

`playwright-cli find "<text>"` 在无障碍快照中搜索，并返回匹配节点及其
ref——比读取完整快照更快，下方侧边栏树条目就是这样定位到的。

## 2026-08-28

在修复 workspace 分组、构建席位招募工具期间截取。UI 与已发布构建相比没有
变化；各张截图之间只有内容不同。

| 文件 | 展示内容 |
|---|---|
| `01-sidebar-workspaces-empty-state.png` | 左侧边栏显示 11 个已注册 workspace，没有展开任何会话。"Into the Unknown" 空态、workspace 选择器、模式选择器、模型选择器、composer。 |
| `02-session-chat-tt-lead.png` | 一个在 Chat 标签页打开的会话：用户轮次、三行上下文注入、一行 Think、助手回复、消息操作，以及统计脚注（轮次数 · 步骤数 · LLM 耗时 · TTFT · token 数）。 |
| `03-session-chat-with-tool-call.png` | 相同布局，另加一行 `Tool call · memory · write`——展示工具调用如何内联渲染在流程中。 |
| `04-sidebar-sessions-grouped.png` | 修复分组后，会话嵌套在各自的 workspace 下。展示自动派生标题（"dshTest"）与已固定标题混杂的样子。 |
| `05-session-titled-by-agent.png` | 一个通过 `session_title` 工具为自己会话改名的席位——侧边栏显示 `tt-pong`，聊天记录中失败的 host-API 尝试出现在成功的工具调用之上。 |

## 编辑前值得了解的结构性说明

- **侧边栏是一棵 workspace 树，每个 workspace 持有若干会话。** 一个 workspace
  就是一个已注册的项目目录；面板标题可重命名，且与路径无关。没有 workspace
  的会话落入 `Ungrouped`。
- **会话标题有三种来源**，这也是为什么 `04` 中的列表看起来不一致：从首个
  提示词自动生成（`fallback`）、显式重命名（`user`，已固定——自动生成随之
  停止），以及在两者都还没有缓存时使用的确定性兜底。
- **composer 是一个接管选举槽位。** `conversation.composer` 是一条替换默认
  `InputBar` 的链，接管**隐藏而非卸载**它。这就是为什么一个被围栏的会话曾经
  渲染成*彻底的空白*而不是一个禁用态方框——见
  `packages/client/ui-conversation/src/client/input/blocks.ts` 中的
  `ComposerBlocks` registry，这才是让输入以可见理由归于失效的正确方式。
