# @deepseek-ai/dsh-agent-claude-code-bash

[English](README.md) | 中文

面向 [Claude Code coder 席位](../agent-claude-code-driver/README.md) 的**沙箱 `bash` 工具**。它是一个 cordis 插件:启动检查通过之后,把 `sandbox` 就绪项和 `bash` 工具注册进[策略包](../agent-claude-code-tools/README.md)提供的注册表。每条命令都在 bubblewrap 中运行,外层是临时的 `systemd-run --user --scope` 单元,没有网络,宿主文件系统只读,只有席位自己的克隆目录可写。该次启动的计划(参数向量、环境变量、单元名、停止命令)由 `@deepseek-ai/dsh-sandbox-local` 的 `planSeatLaunch` 生成;本包负责决定何时启动、运行、停止,并把结果转换成给模型看的文本。

本包落实的创始人裁定:**无网络;可运行任意命令,没有命令白名单;沙箱无法启动时拒绝该回合;任何地方都没有原生 Bash 回退。**

## 它做什么

- **挂载。** `name: agent-claude-code-bash`,`inject: [claudeCodePolicyRegistries, subprocess]`,因此与策略 provider 的挂载先后无关。它解析配置、运行启动检查,只有检查通过时才按以下顺序注册:工具模板(`bash`)、工具贡献者(角色 `['coder']`,名称 `['bash']`)、就绪项(`id: sandbox-bwrap-seat`,`provides: 'sandbox'`)。就绪项放在最后,因为正是它解锁该角色。配置关闭插件、找不到 `bwrap` 或检查失败时,**什么都不注册**,原因以 warn 日志记录,coder 席位保持未就绪。注册表不能反注册,所以插件被销毁后,该工具会拒绝此后的每次调用。
- **本插件之后 coder 仍被拒绝。** `canary` 和 `rules-hooks` 属于后续切片,所以就绪报告恰好是 `missing: canary, rules-hooks`,对 coder 调用 `extend()` 仍会抛错;测试固定了这两点。
- **启动检查(preflight)。** 二进制存在(`/usr/bin/env`、`/usr/bin/prlimit`、bwrap、`systemd-run`、`systemctl`),`XDG_RUNTIME_DIR` 已设置,`systemctl --user show-environment` 有响应,bwrap 通过验证,并且在临时克隆中通过完整启动计划运行 `true` 且被干净停止。失败有类型(`binary-missing`、`xdg-runtime-dir`、`user-bus`、`plan-refused`、`launch-failed`、`cannot-stop`)并附修复建议。
- **降级与恢复。** runner 失败或出现 bwrap 诊断信息会把沙箱标记为降级,下一次调用重新运行检查,通过则清除降级。失败的检查在五秒内不重试,并发调用共享同一个进行中的检查,bwrap 身份、内核版本或两个用户命名空间 sysctl 发生变化时会重新运行。每次结论之后的第一次调用,还会在席位自己的克隆中通过真实计划运行 `true`。
- **每个席位同一时间一条命令。** 并发的第二次调用被拒绝(忙标志在 `finally` 中清除)。
- **调用。** 命令经 `/bin/bash -c` 运行,带截止时间(默认 120 秒,宿主上限 600 秒)。工具返回**经过净化且限长**的结果,分为两个块(见下面的模型条目)。
- **停止。** 领导进程退出时 scope 不会杀死孤儿进程,所以 runner 总是执行同一阶梯:对 bwrap 进程组发送 SIGKILL,`systemctl --user stop <unit>`,轮询 cgroup 目录消失,再用 `classifyScopeStop` 分类。只有 cgroup 真正消失才算成功;总线不可达属于环境故障,停止后目录仍在属于失败,两者都报告为 `runner-failure`。
- **磁盘看门狗。** 命令运行期间每 250 毫秒检查克隆目录所在位置的剩余空间,低于下限时以状态 `disk-floor` 终止命令。(启动时的下限检查由规划器负责。)
- **仅主线程。** 启动必须在宿主主线程发起,因为沙箱的父进程死亡信号在发起*线程*退出时触发。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册任何内容。 |
| `deadlineS` / `maxDeadlineS` | 120 / 600 | 调用 `timeout_s` 的默认值与上限。 |
| `memoryMaxBytes`、`tasksMax`、`minFreeBytes` | sandbox-local 的默认值 | 单元的资源限制。 |
| `bwrapPath` | 自动探测 | bwrap 的绝对路径。 |
| `nodeDir`、`nodeBinDir`、`corepackHome` | 无 | 额外的只读工具链位置。corepack 从不自动探测。 |
| `roPaths`、`pathDirs`、`deniedPaths` | 无 | 额外的只读绑定、`PATH` 条目和被屏蔽的路径。 |
| `home`、`scratchDir` | 操作员主目录、系统临时目录 | 用于配置文件与启动检查临时克隆的宿主信息。 |

超出范围的数字,以及非绝对或未规范化的路径,会在挂载时抛出 `BashConfigError`。

## 测试

单元测试在伪造的环境(伪造的 spawn 接缝、文件系统和时钟)上运行,每个文件保持 100% 覆盖率。`tests/result.spec.ts` 把导入的 bwrap 失败规则与真实 `LocalSandboxProvider` 自己的规则固定为同一条。`tests/integration.spec.ts` 是一个 `describe.skipIf` 块:除非 bwrap、systemd 用户总线和用户命名空间都可用,否则跳过;可用时在真实的 `git clone --no-hardlinks` 克隆上运行真实工具(输出与退出码、截止时间终止、`setsid` 后没有孤儿、克隆目录之外写入失败、无网络)。

## Model Experience

### The `bash` tool

#### What the model sees

The coder sees one extra tool, `mcp__dsh__bash`, whose description says there is no network, that any command is allowed, that `.git` and `node_modules` are read-only, the deadline and kill behaviour, the 64 KiB output cap, to run `vitest` from the clone root, and that commands run one at a time; its input is a strict object of `command` (1 to 16000 characters), optional `cwd` and optional `timeout_s`, and its result is a host-written status block (every line begins `[dsh-bash`) followed by the sanitised `[dsh-bash stdout]` and `[dsh-bash stderr]` text, where any program line that imitates the marker is escaped with a leading backslash.

#### Token effect

One tool description of a few hundred tokens is added to the coder's tool list, and each call returns at most 65536 characters of output plus the status block, so a noisy command costs up to that much context until the model redirects output to a file as the description advises.

#### KV Cache effect

The tool description is a fixed string for a given config (`deadlineS` and `maxDeadlineS` are the only variables), so it is a stable part of the prefix; only the per-call result text varies, and it is appended after the prefix.

## Known Limitations and Deferred Work

- **本包不提供 `canary` 和 `rules-hooks`。** 本切片之后 coder 仍被拒绝;后续切片负责注册它们。
- **bwrap 失败规则是导入的。** `RUNNER_FAILURE_RULES` 由 `@deepseek-ai/dsh-sandbox-local` 导出,本包直接使用其中的 `bwrap` 条目(由一个导入相等测试固定)。第二条规则,即 stderr 第一行以 `Failed to ` 开头且退出码非零(`systemd-run` 无法创建 scope),放在本包中,因为沙箱接缝自己的 runner 是 bwrap 而不是 `systemd-run`。
- **只读主目录下的 corepack 与 pnpm。** corepack 不自动探测,pnpm 可能尝试写入主目录;在后续工作确定默认值之前,由操作员通过配置提供 `corepackHome` 或可写的缓存路径。
- **MCP 调用超时没有调高。** 600 秒的截止上限加上停止阶梯可能超过 SDK 默认的 MCP 请求超时;调高(约 650 秒)是 driver 的后续工作。
- **不报告 `pids.peak`。** 单元的任务数上限会被强制执行,但峰值没有回读到状态块。
- **启动检查会阻塞挂载。** `systemctl` 调用和探测启动在挂载及每次重检时运行;卡住的用户总线由十秒超时切断,而不是无限等待。
- **只做每席位串行。** 不同席位并行运行;需要并发命令的席位必须把它们串在同一个 `command` 中。
- **超过 64 KiB 的输出被丢弃而不是存储。** runner 只保留每个流的尾部;描述告诉模型把大量输出重定向到克隆目录中的文件。
- **重新加载会明确失败并留下旧工具。** 挂载两次会抛出 `already registered`;由于注册表不能反注册,旧宿主的工具会一直保持已注册并拒绝调用,直到宿主进程重启。卸载插件会中止所有进行中的调用(停止阶梯会结束它们的沙箱),并拒绝其余调用。
- **程序可以强制重新检查。** 启动器规则只是启发式判断:向 stderr 打印 `bwrap: ` 或以 `Failed to ` 开头(区分大小写)的第一行并以非零码退出的命令,会被归类为启动器故障,把沙箱标记为降级,并使下一次调用重新运行启动检查(约 100 毫秒)。该检查是共享的,因此恶意席位可以让其他席位短暂等待;结论是"命令可能没有运行",绝不是对命令本身的断言。
- **磁盘看门狗每 250 毫秒采样一次**,因此低于下限的超出量与写入速度成正比(在 NVMe 上实测约 130 MB);1 GiB 的下限就是余量。
- **截断无法使伪造的状态行失去转义。** 输出先截取尾部,再对整段做净化和转义,因此保留下来的第一行总是被当作行首处理。
