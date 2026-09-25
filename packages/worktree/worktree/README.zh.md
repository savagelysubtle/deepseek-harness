[English](README.md) | 中文

# @deepseek-ai/dsh-worktree

worktree 能力 seam：为并行 agent 回合提供按席位划分作用域的 git worktree。本包把该 seam 的三种角色作为同一个关注点全部收拢在一起——**Service Definition**（`ctx.worktrees`、slug 铸造、门禁、注册表行）、**provider 约定**（`WorktreeProvider`）与**本地 git provider**（`LocalGitWorktrees` / `LocalGitWorktreeProvider`）。消费方（seat-spawning 切片）注入该服务，从不直接碰 git。

## Service API (`ctx.worktrees`)

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 以自己的名字接纳一个后端；重复名字响亮失败；返回取消注册的 disposer（fiber 销毁时触发）。 |
| `getProvider(name)` / `listProviders()` | 精确名字查找 / 按注册顺序列出名字。 |
| `spawn(request, providerName?)` | 校验工作环境、铸造 slug、拒绝已存在的路径与分支、以**锁定**状态创建 worktree（`git worktree add --lock -b <branch> <path> <main-ref>`，原因为 `<seat> <session>`）、运行 copy-list 引导流程，并发布该行。引导流程失败时，会在错误冒出之前把该 worktree 回滚。 |
| `list()` / `row(slug)` | 存活中的注册表行——每条存活分支一行——按 spawn 顺序 / 按 slug 取得。 |
| `lock(slug, reason)` / `unlock(slug, reason)` | 以必填的原因移动 git 锁；每次状态变更都会落到该行与一个事件上。对已锁定的 worktree 再次加锁，会带着既有原因响亮拒绝。 |
| `remove(slug, reason)` | 移除一个**已解锁**的 worktree，并删除其行。已锁定的 worktree 会带着其锁定原因拒绝——需先解锁。分支在移除后仍然保留。 |

## 约定

- **seam 铸造 slug；调用方绝不选择 slug。** 每个名字都由 seat 加 slug 派生：分支 `<seat>/<slug>`、会话 `<seat>.<slug>`、路径 `<worktreesRoot>/<seat>-<slug>`。同一并行回合内的唯一性来自一个单调计数器；随机尾段则把跨进程重启的铸造区分开来。
- **force 无法被表达。** `git worktree add -f` 从不会被构造出来：force 本会掩盖的两种状态——已被占用的目标路径、已存在的分支——会在 provider 运行之前就被响亮拒绝，且没有任何 provider 方法接受 force 标志。移除同样绝不会被强制执行；存在未提交改动的 worktree 会直接冒出 git 自身的拒绝。
- **绝不使用静默门禁。** spawn 出生即处于锁定状态，原因为 `<seat> <session>`；lock、unlock 和 remove 都要求非空原因；每条拒绝信息都会点名既有门禁的原因，或缺失的前置条件。
- **工作开始前的 env 门禁。** `spawn` 会在任何 git 或文件系统变更之前检查 `DEEPSEEK_API_KEY`（纯空白值也算缺失），并以点名该变量的方式拒绝。
- **copy-list 引导流程。** 仓库根目录下的 `.worktree-include`（gitignore 语法；跳过空行与 `#` 注释）列出会被复制进每个新建 worktree 的、相对仓库根目录的文件；v1 版本仅支持字面量文件路径，遇到 glob、取反和目录条目会连同出错行号一起拒绝。清单列出但缺失的文件会响亮失败。没有清单文件时不复制任何东西——这是文档记录的默认行为。
- **注册表持久化是一面镜子。** 启用 `persist` 后，行存放在 `<worktreesRoot>/registry.json`（原子式 tmp-rename 写入、按版本门控加载、文件损坏时在挂载阶段响亮失败）。磁盘上究竟存在什么，仍然由 git 自身的 worktree 状态说了算。

## 配置

| 字段 | 类型 | 默认值 | 语义 |
|---|---|---|---|
| `repoRoot` | string | — | 主检出的绝对路径；挂载时必须存在，否则响亮失败。 |
| `worktreesRoot` | string? | `<basename(repoRoot)>.worktrees` 兄弟目录 | worktree 在其下创建的绝对目录（按需创建）。 |
| `mainRef` | string? | `master` | 请求未指定时，新 worktree 分支所基于的 ref。 |
| `persist` | boolean? | `false` | 把注册表行镜像到 `<worktreesRoot>/registry.json`，并在挂载时加载它们。 |

## 扩展点

Provider 实现 [`WorktreeProvider`](./src/provider.ts)——`add`/`lock`/`unlock`/`remove`/`pathExists`/`branchExists`/`list`——并通过 `ctx.worktrees` 注册。将内置的本地 provider 与 `LocalGitWorktrees` 服务一起挂载在 worktree 服务旁边；它会以 `local-git` 之名注册到该服务已解析出的 `repoRoot` 上，并在 fiber 销毁时注销。

## CLI（`dsh-worktree` bin）

本包附带一个可从 bash 调用的 CLI，让席位和运维者从 shell 驱动 worktree——不需要 harness，不依赖 MCP，也没有常驻进程。每次调用都从 CLI 标志构造一个 `WorktreeService` 加本地 git provider，执行恰好一个操作，把结果以 JSON 形式打印到 stdout，并以 0 退出。它被构建为自己的 bundle（`lib/cli.js`），并在 `package.json` 的 `bin` 中声明；在没有 host 运行的纯 Node 环境下即可运行。

```
dsh-worktree spawn  --seat <name> --intent <text> [--main-ref <ref>]
dsh-worktree list
dsh-worktree lock   --slug <slug> --reason <text>
dsh-worktree unlock --slug <slug> --reason <text>
dsh-worktree remove --slug <slug> --reason <text>
```

| 关注点 | 语义 |
|---|---|
| 无状态调用 | 每个进程执行一个操作；命令背后没有常驻 agent。spawn 打印完整的 spawn 结果，lock/unlock 打印已提交的行，`list` 打印行数组，`remove` 打印 `{ "removed": "<slug>" }`。 |
| 来自标志的配置 | `--repo-root`（默认：当前目录）和 `--worktrees-root`（默认：`<basename(repoRoot)>.worktrees` 兄弟目录）喂给插件挂载所运行的同一个 `Config` 解析；`--main-ref` 按请求覆盖 `master` 这一 spawn 默认值。 |
| 无状态性与持久化 | 每次调用都以 `persist: true` 运行，把行镜像到 `<worktreesRoot>/registry.json`；下一次调用会加载它们，因此早前调用铸造出的 slug 仍可寻址（`dsh-worktree spawn … && dsh-worktree unlock --slug <minted> …`）。磁盘上究竟存在什么，仍然由 git 自身的 worktree 状态说了算。 |
| 拒绝 | `WorktreeError` 拒绝会把 `<code>: <message>` 打印到 stderr 并以 1 退出——message 就是 seam 自己的拒绝原因（锁门禁、未知 slug、env 门禁），绝不会被改写转述。用法错误与解析错误不带 code 前缀打印，同样以 1 退出。 |
| env 门禁 | `spawn` 要求环境中存在 `DEEPSEEK_API_KEY`（对应 seam 的 `ENV_MISSING` 拒绝）；其余命令不做此要求。 |
| 帮助 | `--help` / `-h` 把用法文本打印到 stdout 并以 0 退出。 |

## Model Experience

### worktree 生命周期，当某个消费方挂载该 seam 时

#### 模型看到的内容

直接来说什么都没有：`ctx.worktrees` 不注册任何自己的提示词、工具或 schema，行与事件只会经由某个消费方表面把 worktree 状态渲染进对话，才会抵达模型请求。

#### Token 影响

本 Service Definition 本身零直接 token 开销；任何历史开销都属于那个把 worktree 行、名字或事件渲染进对话的消费方表面。

#### KV Cache 影响

seam 本身不产生影响：worktree 名字只在某个消费方组装它们时才进入请求，因此复用行为取决于该表面自身的前缀结构。

## 已知限制与暂缓事项

- CLI 只挂载内置的本地 git provider；需要注册其他 provider 的部署要走插件面，插件面按名字解析 provider。
- 目前还没有消费方发布：把该 seam 挂载进运行时的 seat-spawning 切片是另一项独立改动；在那之前，已发布的默认配置中没有任何东西会驱动它。
- copy-list v1 只复制字面量文件；glob、取反和目录条目会响亮拒绝，而不是半途将就地兑现。
- `remove` 会留下分支；分支删除是另一个显式操作，而不是悄悄销毁可能尚未合并的工作。
- 注册表行不会自动对照 `git worktree list` 做对账：在 seam 之外移除的 worktree，会一直保留为一条陈旧的行，直到对账切片上线。
