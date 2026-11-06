# @deepseek-ai/dsh-sandbox-local

[English](README.md) | 中文

[`dsh-sandbox`](../sandbox/) seam 的本地实现。它选择并缓存一个平台 runner：Linux 优先选择可工作的 `bwrap`，否则选择 Landlock；macOS 使用 Seatbelt；Windows 使用 ACL 受限令牌 runner。多个候选项会按顺序探测，只有一个候选项时则直接选择。

包根目录导出默认及命名的 `LocalSandboxProvider` 插件和 `Config`，以及 seat profile builder（`planSeatLaunch` 及其类型，见下文）；平台 profile builder 仍为内部实现。

不受支持的平台和不可用 runner 会以 `SANDBOX_UNAVAILABLE` 拒绝执行；执行绝不会静默回退为不受限制。每次包装都携带结构化 runner 失败规则，使消费方能够区分损坏的沙箱与命令失败。

策略逐调用传入；提供方只存储机制与缓存的 runner 结论。每次包装都会报告强制执行完整度，以及后端专用的拒绝签名和 runner 失败规则。Landlock 只有在退出码为 125，且仅排除完全匹配的部分强制执行通知后仍存在一行 `landlock-run:` 致命诊断时，才判定 runner 失败；携带该通知的子进程即使以 1、2 或 125 退出，也仍按子进程结果处理。Bubblewrap 和 Seatbelt 仍仅依据签名，因为两者的公开约定均未保留 launcher 失败状态。消费方会直接 spawn 返回的 argv，因此 runner 缺失或不可执行属于带外 spawn 失败，而成功启动的子进程以 126 或 127 退出时仍按普通结果处理。`runnerCommand` 会跳过探测，并要求为自定义 runner 自身的致命方言提供一个或多个非空、单行、不区分大小写的 `runnerFailureSignatures` 条目。由于其机制未知，它会同时携带两种 Linux 拒绝方言。`probeTimeoutMs` 限定功能探测的时长。[沙箱 Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) 负责说明选择与失败语义。

bwrap profile 将只读宿主根目录、全新的 `/dev` 与使用私有 PID 命名空间的 `/proc` 组合起来。命令可管理后代进程，但看不到宿主进程；隐藏宿主的 `/proc/<pid>` 条目，可以防止 `root`、`fd` 等魔法链接绕过其挂载约束。`workspace-write` 另加临时的 `/tmp` 与可写工作区绑定挂载。[私有 PID Agent Note](../../../.agents/notes/implemented/bug-fix/2026-08-06-bwrap-private-pid-namespace.md)记录该边界。

Seatbelt profile 默认允许，但带 `(deny file-write*)` 和写入 allow-list，因此恰好约束相应模式承诺的文件操作：`read-only` 只授予 `/dev/null` 字面路径；`workspace-write` 另加工作区根目录、`/tmp` 和逐用户 darwin 临时目录（`os.tmpdir()`，即平台供 mkstemp 家族工具使用的真实临时区域）。每个根目录都经过规范化，因为 Seatbelt 匹配解析后的路径（`/tmp` 就是 `/private/tmp`）。Apple 将 `sandbox-exec` CLI（命令行界面）标为 deprecated，但所有 macOS 系统仍会提供它；若情况发生变化，功能探测会使执行被拒绝。

Windows 档为每个工作区保留一个确定性写入 SID 和常驻 ACE，但为每个活跃的会话/工作区对分配一个随机私有临时目录，以及不同的 SID 和可撤销 ACE。因此，共享工作区的会话会共享预期的写权限，却不会继承彼此的临时目录权限。新的提供方总会选择新的临时路径和 SID，因此崩溃残留既无法阻止恢复的会话，也无法向其授权；runner 会为无 agent（智能体）的调用提供同样的逐调用隔离。如果工作区等于或包含平台临时根目录，调用会在任何 ACL 改动发生前失败，因为否则其可继承的工作区 ACE 会延伸到每个私有临时子目录。

seat profile（`planSeatLaunch`，`src/seat-profile.ts`）是独立的 builder，而不是 `SandboxPolicy` 的一种模式：给定一次 seat 调用的输入，它返回精确的 `systemd-run --user --scope` + `bwrap` + `prlimit` argv，或带类型的 `SeatRefusalError`（`code`、`reason`、`remedy`）。沙箱根目录是被重新挂载为只读的空 tmpfs；`/usr` 与一份简短的 `/etc` 列表为只读，宿主的 `/usr/local` 被一个空的只读 tmpfs 遮蔽，`/tmp`（1 GiB）与 `/home/seat`（256 MiB）为 tmpfs，克隆目录以其真实路径读写绑定，整个 `.git` 与 `node_modules` 则只读绑定（`node_modules/.vite`、`.vite-temp`、`.cache` 为 tmpfs，需由 provisioning 事先创建）。命名空间涵盖 user（禁止嵌套 user 命名空间）、pid、net、ipc 与 uts；环境被清空，仅保留一组显式变量，并且启动本身在 `env -i` 下进行，因此无论调用方传入什么，bwrap 及其 init 都只拿到 `XDG_RUNTIME_DIR` 与 `PATH`。cgroup scope 为必需项：`TasksMax`（默认 1024，按线程计数）才是对 fork 炸弹的控制手段（RLIMIT_NPROC 只是摆设，并且刻意不设 RLIMIT_AS），通过 `MemorySwapMax=0` 禁用交换，tmpfs 页面计入 `MemoryMax`。unit 名称为 `dsh-seat.<seat>.<callid>`，因此任一部分含短横线也不会冲突。builder 只读取文件系统，并会拒绝：非规范的 `cwd`、worktree 式或带 alternates 的 `.git`、存在硬链接、setuid 或外部设备的条目、未完成 provisioning 的 `node_modules`、会暴露 `~/.claude`、`~/.dsh`、`~/.agents`、`~/.ssh`、`~/.config` 或其他凭据目录的绑定、缺失的 `XDG_RUNTIME_DIR`、缺失或被替换的 bwrap，以及已满的克隆磁盘。`classifyScopeStop` 固化了停止规则：只有 cgroup 目录消失才算成功。这些挂载只是限定工作区，并非密封。

[`@deepseek-ai/node-addon-landlock-run`](https://www.npmjs.com/package/@deepseek-ai/node-addon-landlock-run) 提供平台 launcher、功能探测和 CLI 参数词汇。该提供方只负责模式到授权的映射与 runner 选择。把路径解析和探测解析保留在带版本的 binary 中，可防止约定漂移。

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
```

消费方：[`@deepseek-ai/dsh-bash-sandbox`](../../shell/bash-sandbox/)（本包内的 seat profile 暂无消费方）；可运行的默认组合见 [acp-agent 示例](../../../examples/acp-agent/)。

## 模型体验

通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) 和 [`dsh-tool-bash`](../../shell/tool-bash/README.md) 间接影响；它们渲染该提供方的强制执行与拒绝事实，而 [`dsh-sandbox`](../sandbox/README.md) seam 负责定义 `SANDBOX_UNAVAILABLE` 文本，runner 选择与 profile 则不进入上下文。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **Windows ACL 只能实现部分强制执行**：受限令牌必须保留 Everyone 以完成进程初始化，因此授予 Everyone 写访问的外部对象仍可写；NTFS 硬链接也会使工作区路径与外部路径指向同一个文件对象。提供方报告 `enforcement: 'partial'`，而不会把该边界夸大为完整强制执行。
- **Landlock 可能只实现部分强制执行**：较旧且受支持的内核 ABI 只能限制自身公开的访问类别，因此报告 `enforcement: 'partial'`，不会夸大为完整强制执行。
- **Seatbelt 依赖已弃用的 `sandbox-exec`**：macOS 仍会提供它，但若 Apple 移除该私有策略引擎，该提供方无法替换或探测。
- **runner 选择在提供方生命周期内缓存**：安装、移除或修复 runner 后，必须重载插件才能改变选择。
- **`runnerCommand` 是操作方断言**：配置的自定义 runner 会跳过功能探测，并假定它诚实实现与 bwrap 兼容的 profile；如果它本身是 Bash 脚本，其解释器启动发生在该脚本施加约束之前。
- **seat profile 是受限工作区，而非密封**：工作树仍是持久化残留（钩子、脚本和配置可能在之后被宿主工具打开），因此运维人员绝不能在 seat 克隆内以项目信任方式运行 git、pnpm 或编辑器。预检只是检查时点状态：seat 仍可对其能看到的 inode 新建硬链接，并且目前还没有 seccomp 过滤器或克隆磁盘配额。
- **磁盘下限只是调用前检查，而非上限**：实测在沙箱内 0.2 秒即可写入 1 GiB；调用期间的磁盘看门狗属于 bash runner，受限卷属于 S8。目前仍没有 seccomp 过滤器，`/proc` 仍会显示宿主的 `loadavg` 与 `meminfo`。在 `.git` 以只读方式挂载期间，对 `.git` 条目的硬链接检查只是双保险。
