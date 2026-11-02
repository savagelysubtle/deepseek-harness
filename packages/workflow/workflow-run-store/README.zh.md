# @deepseek-ai/dsh-workflow-run-store

[English](README.md) | 中文

YAML 工作流运行的持久化磁盘存储（OP-240）：包含仅追加的记录日志、固定的工作流源文件、溢出的节点输出以及折叠索引，存放在 dsh 主目录下而非检出目录内。纯 Node I/O，仅依赖 [`@deepseek-ai/dsh-workflow`](../workflow/README.md) 的类型。目录布局位于 `<dsh-home>/workflow-runs/<sha256(realpath(workspace))[0:16]>/`：`runs.jsonl`（每行一条 `v: 1` 的 JSON 记录：run、node、gate、approval、end）、`<runId>/source.yaml`（固定的源文件）、`<runId>/<nodeId>.out`（超过 64 KB 的输出）、`index.json`（折叠摘要，缺失、过期或损坏时由日志重建）以及 `writer.lock`。目录权限为 0700，文件权限为 0600。

包根导出 `openStore`、`workflowStoreDir`、`WorkflowRunStore`（`startRun`、`recordNode`、`recordGate`、`recordApproval`、`decideApproval`、`endRun`、`listRuns`、`getRun`、`readSource`、`readOutput`、`acquireWriter`、`releaseWriter`、`sweepInterrupted`、`prune`）、`WorkflowStoreError`、`writeFileAtomic`、`LIMITS`、各记录类型以及 `WORKFLOW_RUN_RECORD_VERSION`。

单写者锁通过临时文件加 `link()` 发布，并记录 pid、进程启动时间与启动 id；只有该三元组证明持有者已不存在时才会接管。第二个写者会被 `WRITER_BUSY` 拒绝，并指明持有者。未知的记录或索引版本会被拒绝，绝不猜测。

## 模型体验

无，因为本包只把运行记录持久化到磁盘，不向任何模型请求贡献内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有脱敏环节** —— 命令输出、输入、审批文本与固定的 `source.yaml` 均原样存储（文件 0600、目录 0700）。宿主必须让读取方法（`getRun`、`readOutput`、`readSource`）仅限回环地址，不暴露到局域网。
- **仅限支持硬链接的本地文件系统** —— 锁依赖 `link()` 与 proc 文件系统。来自其他主机名的锁绝不接管（错误信息会指明在该主机已不存在时应删除的文件）。没有 `/proc` 时，启动时间退化为简单的 `kill(pid, 0)` 存活检查；存在 pid 命名空间限制：同一主机上位于另一个 pid 命名空间（容器）中的持有者会被误判为已死亡，因此不要跨 pid 命名空间共享同一个 dsh 主目录。
- **每个工作区每个进程一个句柄** —— 只打开一次存储并共享；同一进程中的第二个句柄会被视为另一个写者并以 `WRITER_BUSY` 拒绝。一个句柄同一时间只运行一个 run。
- **剩余的小范围锁窗口** —— 接管过期锁由 `writer.lock.takeover` 串行化，过期的互斥文件通过先重命名再核验所移动内容的方式回收。仍存在一个竞争：在接管者证明锁已死亡与删除它之间的瞬间，若原持有者释放且新持有者建立了新锁，该新锁可能被删除；被取代的持有者会在下一次写入时发现（`NOT_WRITER`）并明确失败，而不会损坏记录。种类与结果（`nodeKind`、`gateKind`、`outcome`）必须是简短的小写标记，自由文本会被拒绝。
- **孤儿子进程** —— 清扫崩溃的运行时只会记录其命令可能仍在运行，存储无法停止它们。
- **尚无迁移** —— 版本 1 是唯一模式；更新版本的索引或记录一律明确拒绝。
