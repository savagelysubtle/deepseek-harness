# Agent Note：worktree 缝合——由 seam 铸造的 slug 与不可表达的 force

Status: implemented

[English](2026-08-31-worktree-capability-seam.md) | 中文

## Problem

并行 agent 回合需要彼此隔离的检出，但最直观的做法——让每个调用方自己执行 `git worktree add`、自己命名路径和分支——会把该命令本来就容忍的所有失败模式集中引爆：用 `-f` 强行复用脏路径、用 `-B` 静默覆盖分支、因为没人加锁而让正在工作的 seat 的 worktree 被外部 prune、以及新 worktree 缺少主检放在版本控制之外的凭据文件。这些失败没有一个会在 seat 还来得及反应的位置发声。

## Decision

`@deepseek-ai/dsh-worktree` 是一个 capability seam（Service Definition + provider 契约 + 本地 git provider 收在一个包里，沿用 `dsh-llm` 在关切尚未分裂时的先例），它的核心选择是 **slug 由 seam 铸造，调用方不命名任何东西**。调用方只提供 seat 与 intent；所有派生名——分支 `<seat>/<slug>`、会话 `<seat>.<slug>`、路径 `<worktreesRoot>/<seat>-<slug>`、锁理由 `<seat> <session>`——都是这两个字符串加一个计数器加随机尾巴的纯函数，因此并行回合在构造上不可能碰撞，调用方也无法操纵派生结果。

每一道围栏都在可能违反它的操作里强制执行，而不是靠约定：

- Force 是**不可表达的**，而不只是被禁止：provider 的任何方法都不接受 force 标志；force 本来要抹掉的两个状态（路径已占用、分支已存在）会在 provider 运行之前就被 provider 自有的 `pathExists`/`branchExists` 围栏大声拒绝。
- Spawn 以**加锁状态**创建 worktree（`git worktree add --lock --reason "<seat> <session>"`），外部进程无法在中途 prune 或劫持它；对加锁的 worktree 执行 remove 会被拒绝，错误信息携带现有锁理由；lock/unlock/remove 都要求非空 reason——不带理由的围栏变更正是本 seam 要消灭的静默围栏形态。
- 工作环境门（`DEEPSEEK_API_KEY` 在场检查）在任何 git 或文件系统变更之前运行，注定失败的 spawn 不产生任何东西。
- copy-list bootstrap（`.worktree-include`，gitignore 语法）把 `.env` 这类凭据相邻文件复制进新 worktree；v1 只认字面路径，对 glob、否定和缺失来源按行号大声拒绝，因为一次被静默跳过的复制是一道要在 seat 开工之后才倒掉的围栏。

Provider 机械操作藏在 `WorktreeProvider`（`add`/`lock`/`unlock`/`remove`/`pathExists`/`branchExists`/`list`）之后，本地 git 实现——它会从子进程环境中剥离 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`，因为 harness 自身常常就运行在它要 spawn 的那个仓库的 worktree 里——只是其中一个可替换的 provider，测试通过 fake 驱动每道围栏而不需要 git。

## Testing

- 包测试覆盖 spawn→list→lock→unlock→remove 全生命周期、并行 spawn 下的 slug 唯一性、每个禁操作拒绝及其理由、针对真实临时目录 fixture 仓库的 copy-list bootstrap、env 门、registry 行，以及镜像持久化（含损坏文件拒绝）。
- `tests/local-git.spec.ts` 对真实 git 路径做端到端演练（创建锁理由在 `git worktree list --porcelain` 中可见、`.env` 已复制、移除后从 git 自己的列表中消失）。

## Alternatives considered

- **让调用方命名路径与分支**——拒绝：这会重新制造每道围栏要消灭的失败模式。自由命名在并行回合间碰撞，`-f` 成为清理陈旧状态的例行逃生门，且没有任何单一组件能看到全部在用 worktree。把 slug 铸造收敛到一处，使命名从调用方契约变成派生事实。
- **用显式标志放行强制操作**——拒绝：force 正是把大声失败变成静默失败的手段。seam 拒绝 force 要抹掉的状态，而底层 git 的逃生门留给刻意绕过 seam 的操作者。
- **创建时不加锁、按需加锁**——拒绝：`add` 与 `lock` 之间的窗口正是其他进程可以 prune 或抢占 worktree 的窗口；出生即加锁、解锁作为带理由的刻意动作，才是封死竞态的方式。
- **现在就把 seam 拆成 definition/provider/consumer 三个包**——推迟：单一包符合 `dsh-llm` 对年轻关切的先例；provider 契约就是第二个后端（远程或池化 provider）到来时的拆分线。

## Consequences

- Registry 行是镜像，不是权威：磁盘上存在什么由 git 的 worktree 状态决定。在 seam 之外被移除的 worktree 会留下过期行，直到对账环节随 consumer 切片落地。
- `remove` 不删除分支。在这里删分支会静默销毁可能未合并的工作；分支清理保持为显式的独立操作。
- slug 计数器是进程内的；跨进程唯一性依赖随机尾巴。两个进程在同一毫秒铸造的碰撞概率极小，而且 branch-existence 围栏会把碰撞变成一次大声拒绝而不是腐化。
- seat 语法复述了 named-session 模式（`dsh-mailbox` 地址语法的先例），避免为一个正则引入依赖边；注释交叉引用了权威来源。
