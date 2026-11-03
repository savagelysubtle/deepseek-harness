# @deepseek-ai/dsh-workflow-yaml

[English](README.md) | 中文

Workflows 功能（OP-240）使用的纯 YAML 工作流定义包：负责 `.workflows/<name>.yaml` 文件的解析、校验、图编译与布局。本包不做任何 I/O，也不注册 Cordis 服务，因此 Host 工具、Host Remote 服务与浏览器编辑器共用同一实现。唯一的运行时依赖是 [`yaml`](https://eemeli.org/yaml/)。

## 公开 API

- `analyze(text, options?)` 解析（仅核心模式，拒绝锚点、别名与标签）、校验并描述工作流文件，返回 `{ ok, diagnostics, doc?, graph?, manifest?, locations?, hash }`；`hash` 是原始 UTF-8 字节的 SHA-256。超过 256 KiB 的文本会以诊断拒绝（此时不返回 `hash`）。`options.checkModel(model, { nodeId }) => string | undefined` 供宿主追加按目录解析后的模型检查：返回拒绝原因即拒绝该模型。
- `Diagnostic` 是统一的定位错误结构（1 起始的 `line` 与 `column`、`code`、`severity`、`nodeId?`、`path`）；`when` 表达式与 `$ref` 模板内的错误会映射到 YAML 标量内部。
- `compile(doc, { promptFiles? })` 返回 `{ meta, script, manifest, promptFiles, maxTotalAgents? }`：供 worker-thread 工作流引擎运行的纯 JS 脚本体。用户文本在脚本中只以 JSON 字符串字面量出现，节点输出以 `WF_*` 环境变量传给 `bash`，绝不拼入命令文本。`COMPILED_SCRIPT_CONTRACT` 列出脚本使用的钩子与选项。
- `describeGraph(doc)` 与 `layout(graph, { xGap, yGap, nodeW, nodeH })` 提供展示图和确定性的分层布局（重心排序，不依赖外部布局库）。
- `checkModelId`、`checkTierTable`、`checkRelativePath`、`checkEnvName` 是静态的拒绝名单与路径约束检查；`describeTrustFacts(doc)` 列出工作流将执行的内容以供信任提示；`sha256Hex` 是同步、浏览器可用的哈希。

所有导出均为纯函数：无 I/O、无仅限 Node 的 API，因此浏览器编辑器可直接链接本包。

## 模型体验

无，因为本包只解析和校验工作流文件，不向任何模型请求贡献内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **会改动检出内容的 prompt 节点必须有验证** —— 当 `prompt` 节点可能修改检出内容（默认如此）且其后没有任何门禁时，`no-verify-step` 为错误。解决办法：设置 `mutates_checkout: false`，添加 `done_when`，或在其后放置带门禁的 bash、approval、verifier 或 loop 节点。
- **仅支持版本 1** —— 必须声明 `version: 1`；`evidence`、`on_error` 与 `workflow`/`include`（含 `kind: workflow`）会被拒绝，`context: {resume}` 与 `fresh_context: false` 暂不支持。
- **静态检查不是安全边界** —— Fable 文本检查以及路径、环境变量检查只拒绝明显的形态；解析后的模型与符号链接检查由宿主在运行时负责（`analyze` 为前者提供 `checkModel` 钩子）。
- **字符串拒绝名单可能误伤** —— 忽略分隔符的匹配可能拒绝恰好包含 `fable` 字母序列的无关标识。
- **节点之间传递的输出是数据而非指令** —— prompt 中的 `$node.output` 会被包装为带标签的数据，这能降低但不能消除节点间的提示注入风险。
