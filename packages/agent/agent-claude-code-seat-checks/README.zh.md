# @deepseek-ai/dsh-agent-claude-code-seat-checks

[English](README.md) | 中文

[Claude Code coder 席位](../agent-claude-code-driver/README.md)的**席位检查**。它是一个 cordis 插件：先运行两项启动证明，然后把 `canary` 与 `rules-hooks` 就绪条目以及每次查询都会执行的**克隆钩子检查**注册进[策略包](../agent-claude-code-tools/README.md)提供的注册表。再加上 [bash 包](../agent-claude-code-bash/README.md)的 `sandbox` 条目，coder 就具备了被服务的全部条件，所以解除 coder 拒绝的正是本包。本包没有任何第三方依赖。

## 它做什么

- **挂载顺序，在同一个 try 块内。** `name: agent-claude-code-seat-checks`，`inject: [claudeCodePolicyRegistries, claudeCodeGuardProbe]`，因此与策略提供者的挂载先后不受限制。主体依次运行（1）守卫探测，（2）检查器自测，然后才在同步、没有任何 `await` 的情况下注册（3）克隆检查（id 为 `clone-hooks-check`，角色 `['coder']`），（4）`rules-hooks` 就绪贡献者，（5）`canary` 贡献者，最后一项仅在探测结果明确为 `{ ok: true }` 时注册。注册之前出现任何失败都不会注册任何东西，所以不会出现只注册了一半的状态。
- **失败是响亮的，并且对本进程是最终的。** 任何被捕获的错误都会以 error 级别记录 `agent-claude-code-seat-checks: canary FAILED <code>`（外加一行原因），把简短代码记为就绪备注（未就绪错误会显示它），并且不注册任何东西。由于注册表不能注销、也没有重试循环，coder 会一直被拒绝，直到宿主重启。第二次挂载会在注册任何东西之前抛出错误（`already mounted`）。
- **与强制执行耦合。** 策略包中的 `extend()` 对 coder 的处理是：除非已为 coder 注册了 id 为 `clone-hooks-check` 的克隆检查，否则一律抛出错误，与就绪报告无关，所以仅靠一个伪造的 `rules-hooks` 注册者什么也解除不了。
- **卸载。** 释放插件会设置一个标志；之后已注册的检查对每次查询都以代码 `disposed` 拒绝。

## 守卫启动 canary

探测属于策略包（`claudeCodeGuardProbe`，由与真实策略相同的已解析选项构建）。它为保留的合成席位 `dsh-canary-probe` 生成一份真实的 coder 策略，经 `/bin/sh` 运行完全相同的钩子命令，并要求：未知工具被拒绝（退出码 2，`seat-guard: denied:`，"is not granted"）；对 `<cwd>/.git/config` 的 `Edit` 以受保护位置的理由被拒绝；一次已授权的 `Read` 被**允许**（负向对照）；并且运行结束后 node 二进制、守卫副本与策略文件仍保持其已证明的哈希。本包以每次运行的超时 `canaryTimeoutMs` 调用它，把拒绝（reject）映射为代码 `error`，并且仅在 `ok: true` 时注册 `canary`。失败代码：`attest`、`timeout`、`exit`、`reason`、`control`、`changed`、`spawn`、`error`。

**canary 通过并不证明什么。** 它证明的是生成的命令经 `/bin/sh` 运行时会拒绝。它**不**证明 Claude CLI 会调用该钩子或遵守退出码 2（CLI 语义与版本漂移）。这一点只能由策略包的 `scripts/live-probe.mjs` 在 S8 演练中、在任何 coder 席位承担真实工作之前证明；没有人应该把"canary 通过"理解成更多的含义。

**对威胁模型的坦白。**

- 以相同 uid 运行的非席位进程可以替换 node 二进制或守卫，并重写权限为 0700 的策略文件。证明（attestation）无法防御这一点。
- 每次查询的重新证明（大小、mtime、ctime、inode）把窗口缩小到一个回合。
- 负向对照（已授权的 `Read` 必须以 0 退出）能够识破只会打印拒绝文字的"永远拒绝"伪守卫。
- 就绪状态以 `provides` 字符串为键，因此任何进程内插件都可以注册 `canary`；同进程插件本来就是完全受信任的。上面的耦合意味着仅靠一个伪造的 `rules-hooks` 无法解除强制执行。

## 克隆钩子检查（`rules-hooks`）

目的，直截了当地说：**配置卫生与漂移检测，是守卫与沙箱之后的纵深防御，不是安全边界。** coder 克隆不得带有任何宿主可执行的 git 钩子状态：整个 `.git` 在沙箱内是只读的，宿主 git 也在禁用钩子的情况下运行，所以这里没有什么需要围栏，检查所断言的是"不存在"。它既不安装也不强制 `reference-transaction` 围栏；那只属于 `~/.agents`。任何地方都不使用网络。

- **节奏。** 每次查询都会计算一个指纹（对 `.git`、`.git/config`、必须不存在的条目、`.git/hooks` 及每个钩子条目做 `lstat`：模式、inode、链接数、大小、mtime、ctime；约十几次调用，不启动进程）。git 解析只在某席位的第一次查询、工作目录变化、或指纹变化时运行。拒绝从不被记住。缺失的条目有稳定的标记；无法读取的条目会得到一个永不重复的标记，所以它是"指纹已变化"，绝不是通过。
- **状态检查。** `.git` 是真正的目录。必须**不存在**：`.git/commondir`、`.git/gitdir`、`.git/dsh-hooks`、`.git/config.worktree`、`.git/worktrees`、`.git/objects/info/alternates`、`.git/objects/info/http-alternates`。`.git/hooks` 是真正的目录（或不存在），且只包含名为 `*.sample` 的普通文件。`.git/config` 经 `lstat` 为普通文件、只有一个链接、不是符号链接、不超过 64 KiB，并且在启动 git **之前**检查（恶意配置可能把 `core.hooksPath` 埋在被截断的读取之后）。
- **配置由 git 读取。** `git config --file <cwd>/.git/config --list -z --no-includes`，使用绝对路径的 git，cwd 为 `/`，环境为 `PATH=/usr/bin:/bin`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`HOME=/nonexistent`、`LC_ALL=C`，不继承任何其他变量，超时 5 秒，输出上限 256 KiB。记录只在第一个换行处拆分；键以小写且锚定的方式匹配。
- **名称从不按原样打印。** 钩子文件名和配置子节名由席位控制。仅由 `A-Za-z0-9._/@+=:-` 组成的名称原样打印；其他任何名称都打印为 `<unprintable name, N bytes, hex ...>`，并提示使用补救办法中的 `find` 命令而不要粘贴，换行符也绝不会进入日志行。
- **允许清单。** `core.repositoryformatversion`、`core.filemode`、`core.bare`（必须为 false）、`core.logallrefupdates`、`core.ignorecase`、`core.precomposeunicode`、`core.symlinks`、`remote.<n>.url`（同时受 `remoteUrlAllow` 约束）、`remote.<n>.fetch`、`branch.<n>.remote`、`branch.<n>.merge`、`user.name`、`user.email`、`init.defaultbranch`。其余一律拒绝，并指出其键名。远程 url 必须是绝对本地路径、`https://`、`ssh://` 或 scp 风格，任何包含 `::` 的值都被拒绝（远程助手会运行程序）。`branch.<n>.remote` 必须是普通名称。
- **失败即关闭。** 仅当 spawn 没有返回错误、没有信号、状态为 0、stderr 为空，且 stdout 以 NUL 结尾并被完整解析时才放行。其余情况一律抛出 `CloneCheckError`，策略包会把它转为一条已记录的拒绝和一个带类型的回合错误，其中指出键或路径以及补救办法。

拒绝代码：`remote-url-not-allowed`、`git-missing`、`timeout`、`enobufs`、`eacces`、`enoent`、`parse`、`config-too-large`、`config-not-regular`、`config-key`、`config-value`、`git-not-directory`、`forbidden-entry`、`hook-entry`、`fs-error`、`git-error`、`git-signal`、`git-exit`、`git-stderr`、`disposed`。每条拒绝文字都带有清理命令（在任何席位之外删除所指出的路径或键，或用 `pnpm install --offline --ignore-scripts --config.package-import-method=copy` 配置一个全新的克隆）。

**检查器自测。** 注册之前，插件在临时目录中构建一次性克隆，并要求检查对干净的克隆放行、对每个恶意克隆以预期代码拒绝：`core.hooksPath`、过滤器驱动、`include.path`、`remote.o.uploadpack`、`core.bare = true`、`ext::` url、可执行的 `pre-commit`、`reference-transaction`、`config.worktree`，以及符号链接的配置。因此 `rules-hooks` 贡献者的含义是"检查器可用"；对克隆本身的裁决在每次查询时执行。

## 对克隆执行宿主侧 git

本包导出 `assertCloneHookState(cwd)`（相同的检查，不缓存，抛出 `CloneCheckError`）。在对 coder 克隆执行**每一条宿主侧 git 命令之前**都要调用它，并且这些命令要写成 `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat ...`，同时设置 `GIT_CONFIG_NOSYSTEM=1`。绝不要在克隆里执行 `git add -A`：席位可以写入嵌套的 `sub/.git/config`，宿主一旦添加 `sub`，`git status` 就会运行其中的 `core.fsmonitor`。没有使用 `--ignore-scripts` 配置的克隆会通不过检查，因为根目录的 postinstall（`install-lefthook`）会把 `core.hooksPath`、`.git/config.worktree` 和 `.git/dsh-hooks` 写进克隆。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册任何东西并发出警告；coder 席位保持未就绪。 |
| `gitPath` | `/usr/bin/git`、`/usr/local/bin/git` 中第一个存在的 | git 的绝对且规范化的路径。找不到 git 时 canary 以代码 `git-missing` 失败。 |
| `canaryTimeoutMs` | `20000` | 守卫探测每次钩子运行的超时，范围 1 到 300000。 |
| `remoteUrlAllow` | `[]` | 克隆可以带有的远程 url：完整值，或以 `/` 结尾的前缀。未被覆盖的 url 以 `remote-url-not-allowed` 拒绝。**空列表会拒绝所有远程 url**（失败即关闭），所以配置克隆时必须把它设为源仓库；列表为空时挂载会发出警告。形式检查（绝对路径、`https://`、`ssh://`、scp 风格、不含 `::`）仍先执行。 |

无效的 `gitPath` 或超时会在挂载时抛出 `SeatChecksConfigError`。没有快照文件，也没有快照路径。

## 测试

规格保持每个文件 100% 覆盖率，并且 canary 与克隆检查的每条错误路径都有各自的测试：git 缺失、`EACCES`、超时、`ENOBUFS`、信号、非零状态、stderr 输出、无法解析的输出、过大/符号链接/硬链接/缺失的配置、每一个必须不存在的条目、每种钩子形态以及每个恶意键。它们在一次性配置上运行真实的 git（不使用网络），并包含一次针对真实策略提供者与真实构建的守卫的端到端挂载。

## 已知限制与延后工作

- **卸载与重新挂载。** 释放插件后其就绪条目仍然保留，克隆检查对每次查询都拒绝（`disposed`）；在宿主进程重启之前再次挂载会抛出错误，因为注册表不能注销。这只影响可用性，不影响安全。
- **`assertCloneHookState` 目前没有宿主调用方。** 宿主侧 git 守卫已导出，但在 S8 把它接到对克隆执行宿主侧 git 之前，没有任何东西调用它。
- **性能。** 任何 git 写入都会移动 `.git` 目录的 mtime，所以对活跃克隆的大多数查询都会重新运行 git 解析。`spawnSync` 每次解析最多阻塞宿主 5 秒（超时），并且同样存在 lstat 到启动之间的间隙：在大小检查与 git 打开文件之间被替换是可以接受的，因为这是漂移检测而不是安全边界。
- **在查询时强制执行，而非创建时。** 克隆路径只有在查询时才知道，所以在坏克隆上的 coder 回合会以带类型原因和补救办法的回合错误失败，而不是创建时的拒绝。
- **只覆盖克隆本地状态。** 宿主用户的全局与系统 git 配置由上述操作规则覆盖，不在本检查范围内。
- **检查用 TypeScript 编写。** 以后可以与守卫的移植一起，在同一接缝后改用 Rust 实现；这里没有任何东西依赖它。
- **canary 失败需要重启。** 没有重试循环，并且同进程插件仍可凭字符串注册 `canary`。
- **后续事项，本次未关闭。** `extend()` 中针对每个席位的证明仍会使第一次查询阻塞最多 15 秒；启动 canary 不能取代它，因为证明的键包含每个席位的策略哈希。
