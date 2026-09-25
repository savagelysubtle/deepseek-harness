[English](README.md) | 中文

# worktree/ — 按席位划分作用域的 git worktree 家族

为并行 agent 回合提供隔离的 git worktree：seam 铸造 slug、派生分支/会话/路径名字、以响亮原因为门禁约束每一次状态变更，并用仓库的 copy-list 为新建的 worktree 引导初始文件。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`worktree/`](worktree/README.md) | Service Definition + provider 约定 + 本地 git provider：slug 铸造、注册表行、锁门禁、copy-list 引导、env 门禁 | `ctx.worktrees` |

规划中的角色：seat-spawning 消费方（把该 seam 挂载进运行时）和一套针对 `git worktree list` 的注册表对账流程。
