# Agent Note: dsh-worktree CLI — stateless shell access to the worktree seam

Status: implemented

[English](2026-08-31-worktree-cli.md) | 中文

## Problem

worktree seam 只能通过已挂载的服务访问:seat(或站在 harness 之外的运维者)没有任何 bash 可调用的方式去 spawn 一个 worktree、读取它的注册行或移动它的锁栅栏。现有的消费者面(host apiproxy 的 wire domain)是 live-only 的——只有 harness 运行时它才应答,而那恰恰是 seat 已经在 harness 内、不需要 shell 路径的场景。从 seat 的 shell、cron 包装器或故障时的运维会话驱动 worktree,完全没有可用面。

## Decision

`dsh-worktree` bin 随 `@deepseek-ai/dsh-worktree` 包本身发布,遵循与 `dsh-mailbox` 相同的先例:CLI 位于拥有该契约的包内,因此它与所驱动的 seam 契约版本锁定,不会漂移到调用已不存在的操作。它暴露 seam 的五个带栅栏的操作——`spawn`、`list`、`lock`、`unlock`、`remove`——每次调用执行一个操作,结果以 JSON 打印到 stdout,每个拒绝以 `<code>: <message>` 打印到 stderr 并以退出码 1 结束,message 逐字使用 service 自己的拒绝原因。

无状态由注册表镜像承载,而不是任何常驻进程:每次调用都以 `persist: true` 构造 service,因此 spawn 铸造的 slug 落入 `<worktreesRoot>/registry.json`,下一次调用(`unlock`、`lock`、`remove`)从那里寻址它。CLI 没有改变 seam 的权威划分——磁盘上存在什么仍由 git 的 worktree 状态说了算;镜像只在无状态的进程之间携带簿记行。

配置来自 CLI 标志,而不是运行中的 host:`--repo-root` 默认为当前目录,`--worktrees-root` 保留包的 `<basename>.worktrees` 兄弟目录默认值,两者都经由插件挂载所运行的同一个 `resolveConfig` 解析。local git provider 在调用内部注册到解析出的 repo root,并在退出前注销;需要其他 provider 的部署使用插件面,插件面按名称解析 provider。

## Alternatives considered

- **持有 service 的常驻守护进程** —— 否决:seam 的注册表从镜像重建的成本很低,而常驻进程需要自己的生命周期、发现和故障机制,这些在 harness 存在的地方本来就已由 harness 拥有。
- **围绕 `git worktree` 的薄 bash 脚本** —— 否决:它会在 seam 之外重新实现 slug 铸造、锁栅栏、env 门和 copy-list 引导,恰好是 seam 之所以存在的那个"政策的第二份拷贝"。
- **把 CLI 接入 host apiproxy 消费者** —— 否决:apiproxy 面是 harness 内路径;依赖运行中 host 的 CLI 恰恰在该命令为之存在的"无 harness"场景中不可用。

## Consequences

`package.json` 增加 `bin` 条目,并新增包级 `tsdown.config.ts`,在 root 与 invariant bundle 旁边构建 `lib/cli.js`。CLI 的注册表镜像写入意味着:对某仓库运行 `spawn` 的运维者会得到 `<worktreesRoot>/registry.json`,而此前仅有插件的面上不开 `persist` 时什么都不会创建——这是一个可见但属预期的副作用,因为无状态要求镜像存在。CLI 只挂载内置的 local git provider;多 provider 部署继续使用插件面。

## Testing

`packages/worktree/worktree/tests/cli.spec.ts` 钉住解析器(子命令、可选的 `--main-ref`/路径标志、`--help` 选择、对未知/缺失/畸形参数的响亮拒绝)、输出契约(stdout 上的 JSON 且退出码 0、恰好一个结尾换行的 usage、stderr 上的 `<code>: <message>` 拒绝且退出码 1)、跨调用的真实 git 生命周期(spawn → 重锁拒绝 → unlock → lock → 锁定态 remove 拒绝 → unlock → remove,行由注册表镜像在多次独立调用间携带)、env 门与配置拒绝,以及 bin 入口:解析符号链接的执行守卫,和经 tsx 以子进程运行真实源码入口。
