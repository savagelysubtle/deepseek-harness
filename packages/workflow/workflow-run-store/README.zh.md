# @deepseek-ai/dsh-workflow-run-store

[English](README.md) | 中文

YAML 工作流运行的持久化磁盘存储（OP-240）：包含仅追加的记录日志、固定的工作流源文件、溢出的节点输出以及折叠索引，存放在 dsh 主目录下而非检出目录内。纯 Node I/O，仅依赖 [`@deepseek-ai/dsh-workflow`](../workflow/README.md) 的类型。包根目前导出 `WorkflowRunId` 类型与 `WORKFLOW_RUN_RECORD_VERSION`。

## 模型体验

无，因为本包只把运行记录持久化到磁盘，不向任何模型请求贡献内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **仅为脚手架** —— 写入锁、记录模式、输出溢出、保留策略与恢复尚未实现。
