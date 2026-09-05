# Worktree

[English](worktree.md) | 中文

worktree seam 铸造按 seat（席位）划分作用域的 git worktree，让并行的 agent（智能体）回合各自拿到独立检出，不会在路径、分支或会话名上相互冲突。Service Definition、provider 约定与本地 git provider 全部归于同一个包——[dsh-worktree](../../packages/worktree/worktree)（`ctx.worktrees`）——沿用 `dsh-llm` 对尚未拆分关注点的先例；目前尚无面向模型的 Consumer，因此调用方直接注入 `ctx.worktrees`，而不经由工具 schema。设计依据见 [worktree-capability-seam Agent Note](../../.agents/notes/implemented/architecture/2026-08-31-worktree-capability-seam.md)。

源码：[`packages/worktree/worktree/src/types.ts`](../../packages/worktree/worktree/src/types.ts)

## slug 铸造每一个名字，调用方不选择任何名字

`WorktreeSlug` 是 seam 铸造的带品牌标识符——`<base36 纪元毫秒>-<base36 计数器>-<8 位十六进制随机数>`——绝不由调用方选择。每个派生名字都是调用方 `seat` 加上这个 slug 的纯函数：分支 `<seat>/<slug>`、会话 `<seat>.<slug>`、路径 `<worktreesRoot>/<seat>-<slug>`、锁定原因 `<seat> <session>`。进程内的单调计数器把同一毫秒内的并行铸造区分开来；随机尾段把跨进程重启的铸造区分开来。`seat` 遵循会话名文法（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，不引入依赖边界、从 `@deepseek-ai/dsh-named-sessions` 原样复述，沿用 `dsh-mailbox` 地址文法的先例），因此分支名始终对文件系统安全、对 git 合法。

## Spawn：请求、结果与 row

`spawn(request, providerName?)` 解析出一个 provider、校验 seat 与 intent、检查工作环境、铸造 slug、拒绝 force 本会掩盖的两种状态、以**锁定**状态创建 worktree、运行 copy-list 引导流程,并发布该 row。引导流程失败时，半成品 worktree 会先回滚（先解锁再移除）再让错误冒出；若回滚本身也失败，原始错误与回滚失败会一并以 `AggregateError` 的形式抵达调用方。

```ts type-equiv
/**
 * Request to create one seat-scoped worktree. The caller supplies ownership
 * and intent; the seam mints the slug and derives every name from it.
 */
interface WorktreeSpawnRequest {
  /**
   * Seat that will work inside the worktree. Uses the session-name grammar
   * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, from `@deepseek-ai/dsh-named-sessions`):
   * filename-safe and valid inside a git branch name.
   */
  readonly seat: string
  /** Short caller intent, recorded on the row as the spawn's `lastReason`. */
  readonly intent: string
  /** Explicit ref to branch from; omitted resolves to `Config.mainRef`. */
  readonly mainRef?: string | undefined
}
```

```ts type-equiv
/** Published result of one successful spawn. */
interface WorktreeSpawnResult {
  /** Seam-minted slug behind every derived name. */
  readonly slug: WorktreeSlug
  /** Seat the worktree was spawned for. */
  readonly seat: string
  /** New branch the worktree checked out: `<seat>/<slug>`. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree: `<seat>.<slug>`. */
  readonly session: string
  /** Absolute worktree path: `<worktreesRoot>/<seat>-<slug>`. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Reason the creation lock carries: `<seat> <session>`. */
  readonly lockReason: string
  /** Repo-root-relative files the copy-list bootstrap placed into the worktree. */
  readonly copied: readonly string[]
}
```

`list()` 与 `row(slug)` 读取存活中的注册表——每条存活分支对应一行 `WorktreeRow`，在 spawn 时发布，由 lock/unlock 原地更新，由 remove 删除：

```ts type-equiv
/**
 * One registry row: seat → worktree path → branch → session name. Exactly one
 * row exists per live branch; removal deletes it.
 */
interface WorktreeRow {
  /** Seam-minted slug; the row's stable identity across lock state changes. */
  readonly slug: WorktreeSlug
  /** Seat the worktree belongs to. */
  readonly seat: string
  /** Branch the worktree checked out. */
  readonly branch: string
  /** Session name reserved for the seat's work in this worktree. */
  readonly session: string
  /** Absolute worktree path. */
  readonly path: string
  /** Ref the branch was cut from. */
  readonly branchRef: string
  /** Epoch milliseconds at which the seam published the row. */
  readonly createdAt: number
  /**
   * Reason the current git lock carries; `undefined` while unlocked. A row is
   * born locked (spawn creates the worktree under lock) and removal refuses
   * while this is set.
   */
  readonly lockReason?: string | undefined
  /** Reason attached to the most recent mutation (spawn intent, lock, or unlock). */
  readonly lastReason?: string | undefined
}
```

## 门禁：force 无法被表达

没有任何 provider 方法接受 force 标志。`git worktree add -f` 本会掩盖的两种状态——已被占用的目标路径、已存在的分支——在 `add` 真正运行之前，就由服务经 provider 的 `pathExists`／`branchExists` 门禁响亮拒绝；remove 同样绝不会被强制执行，因此一个存在未提交改动的 worktree 会直接冒出 git 自身的拒绝，而不会被销毁。`lock`／`unlock`／`remove` 都要求调用方提供非空原因——不带原因的门禁变更正是本 seam 要杜绝的静默门禁——每条拒绝信息都会点名既有门禁的原因或缺失的前置条件。`WorktreeError` 携带下列某个稳定的 `WorktreeErrorCode`：

| 代码 | 拒绝条件 |
|---|---|
| `SEAT_INVALID` / `INTENT_INVALID` | spawn 请求的 `seat` 不满足文法，或 `intent` 为空。 |
| `ENV_MISSING` | 工作环境缺少 `DEEPSEEK_API_KEY`（纯空白值也算缺失）。 |
| `PATH_EXISTS` / `BRANCH_EXISTS` | 目标路径或分支已存在——正是 force 本会掩盖的状态。 |
| `ALREADY_LOCKED` / `NOT_LOCKED` | 对已锁定的 row 调用 `lock`，或对未锁定的 row 调用 `unlock`。 |
| `LOCKED` | 对仍带锁定原因的 row 调用 `remove`。 |
| `REASON_INVALID` | `lock`／`unlock`／`remove` 被传入空白原因调用。 |
| `NO_ROW` | 该 slug 未指向任何存活 row。 |
| `NO_PROVIDER` / `DUPLICATE_PROVIDER` | 没有 provider 能唯一解析，或某个名字被注册了两次。 |
| `GIT_FAILED` | 本地 provider 的 git 调用以非零状态退出；错误信息携带 git 自身的 stderr。 |
| `COPY_LIST_UNSUPPORTED` / `COPY_SOURCE_MISSING` | `.worktree-include` 使用了不支持的语法，或列出了仓库根目录下不存在的文件。 |
| `REGISTRY_CORRUPT` | 持久化的 `registry.json` 在加载时未通过版本或结构校验。 |

## 环境门禁与 copy-list 引导流程

`spawn` 在任何 git 或文件系统变更之前检查 `DEEPSEEK_API_KEY` 是否存在，因此注定失败的 spawn 不会创建任何东西。worktree 一旦存在，copy-list 引导流程会把工作会话所需的仓库根目录文件——v1 版本内置 `.env`——复制到新 worktree 下同样的相对路径。清单存放于仓库根目录的 `.worktree-include`（gitignore 语法；跳过空行与 `#` 注释）；v1 版本仅支持字面量相对文件路径，遇到 glob、取反、目录条目、绝对路径或 `..` 片段会连同出错行号一起响亮拒绝，而不是悄悄复制得比清单承诺的更少。清单列出但缺失的源文件会响亮失败（`COPY_SOURCE_MISSING`）。没有清单文件时不复制任何东西——这是文档记录的默认行为，不是被跳过的条目。

## provider 约定：`WorktreeProvider`

provider 机制可在同一份约定背后互换；`registerProvider` 以自己的名字接纳一个实现（重复名字会响亮拒绝），并返回 fiber 销毁时会触发的取消注册函数。

```ts type-equiv
/**
 * One worktree backend. Force is unrepresentable: no method accepts a force
 * flag, and the service refuses — before calling the provider — the two
 * states force would paper over (an existing target path, an existing
 * branch). Removal is likewise never forced; a dirty worktree surfaces git's
 * refusal instead of being destroyed.
 */
interface WorktreeProvider {
  /** Registry-unique provider name. */
  readonly name: string

  /**
   * Create the worktree at `spec.path` on the new branch `spec.branch` cut
   * from `spec.mainRef`, created locked with `spec.lockReason` — the exact
   * `git worktree add --lock -b <branch> <path> <main-ref>` contract for the
   * local provider.
   * @param spec - fully resolved spawn input; the service has already refused existing paths and branches.
   */
  add(spec: WorktreeAddSpec): Promise<void>

  /**
   * Lock an existing worktree with a reason.
   * @param path - absolute worktree path.
   * @param reason - reason recorded with the git lock.
   */
  lock(path: string, reason: string): Promise<void>

  /**
   * Remove an existing lock. Git records no unlock reason; the service keeps
   * the caller's reason on the row.
   * @param path - absolute worktree path.
   */
  unlock(path: string): Promise<void>

  /**
   * Remove the worktree's admin metadata and directory. Refuses (via git)
   * when the worktree is locked or dirty — force-removal is unrepresentable.
   * @param path - absolute worktree path.
   */
  remove(path: string): Promise<void>

  /**
   * Whether the target path already exists in the provider's filesystem —
   * the fence that makes force-spawning (`git worktree add -f`)
   * unrepresentable before `add` runs.
   * @param path - absolute candidate worktree path.
   * @returns true when something already occupies the path.
   */
  pathExists(path: string): Promise<boolean>

  /**
   * Whether a local branch with this exact name already exists — the fence
   * that makes branch reuse impossible before `add` runs.
   * @param branch - full branch name.
   * @returns true when the branch exists.
   */
  branchExists(branch: string): Promise<boolean>

  /**
   * Enumerate the repository's worktrees as git sees them — the reconciliation
   * view tests and operators read rows against.
   * @returns one entry per worktree git reports, in git's order.
   */
  list(): Promise<readonly WorktreeListEntry[]>
}
```

`add` 接受一个完全解析好的 `WorktreeAddSpec`——等到某个 provider 看到它时，服务早已拒绝了已存在的路径与分支：

```ts type-equiv
/** Fully resolved spawn input handed to a provider's {@link WorktreeProvider.add}. */
interface WorktreeAddSpec {
  /** Absolute target worktree path. */
  readonly path: string
  /** New branch to create and check out. */
  readonly branch: string
  /** Ref to branch from. */
  readonly mainRef: string
  /** Reason the creation lock carries. */
  readonly lockReason: string
}
```

`list()` 按 provider 后端自身的顺序，为其报告的每个 worktree 返回一条 `WorktreeListEntry`：

```ts type-equiv
/** One entry of the provider's worktree listing. */
interface WorktreeListEntry {
  /** Absolute worktree path. */
  readonly path: string
  /** Checked-out branch, without the `refs/heads/` prefix; absent for detached worktrees. */
  readonly branch?: string | undefined
  /** Whether the worktree is currently locked. */
  readonly locked: boolean
  /** Reason the lock carries, when locked and reported by git. */
  readonly lockReason?: string | undefined
}
```

## 本地 git provider

`LocalGitWorktreeProvider`（以 `local-git` 注册）把每个方法都实现为面向已解析 `repoRoot` 的一次 git 调用：`add` 执行 `git worktree add --lock --reason <lockReason> -b <branch> <path> <mainRef>`；`lock`／`unlock`／`remove` 直接映射到各自的 `git worktree` 子命令；`branchExists` 使用 `git rev-parse --verify --quiet refs/heads/<branch>`，把退出码 1 当作"不存在"，任何其他退出码都会冒出 git 的诊断信息；`list` 解析 `git worktree list --porcelain` 的输出。每次调用都会从子进程环境中剔除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`,因为 harness 自身常常就运行在它正要 spawn 进去的那个仓库的某个 worktree 内部，继承来的位置变量会把子进程的 git 重定向到调用进程的检出，而非 `repoRoot`。非零的 git 退出码会被包进携带 git 自身 stderr 的 `WorktreeError`（`GIT_FAILED`），绝不会悄悄消失。`LocalGitWorktrees` 是可挂载的服务形式：它针对已挂载 `WorktreeService` 解析出的 `repoRoot` 注册一个 `LocalGitWorktreeProvider`，并在 fiber 销毁时取消注册，因此消费方应把它与 worktree 服务一起挂载，而不是直接构造 provider 类。

## 注册表持久化

在 `Config` 中启用 `persist` 后，每次发布 row 的变更都会把存活注册表镜像写入 `<worktreesRoot>/registry.json`——原子写入（先写临时文件再改名），因此写入过程中崩溃绝不会留下截断的文件——下一个进程的构造过程会把它重新加载回来。文件携带显式的版本标记；版本不匹配或任何一行格式错误都会响亮失败（`REGISTRY_CORRUPT`），而不是合并一份一知半解的注册表。磁盘上实际存在什么，权威始终是 git 自身的 worktree 状态——该文件只记住 seam 的记账信息，任何在 seam 之外被移除的 worktree 都不会被自动核对。

## Config

| 字段 | 类型 | 默认值 | 语义 |
|---|---|---|---|
| `repoRoot` | string | — | 主检出的绝对路径；构造时必须存在，否则响亮失败。 |
| `worktreesRoot` | string? | `<basename(repoRoot)>.worktrees` 同级目录 | worktree 创建于其下的绝对目录（按需创建）。 |
| `mainRef` | string? | `master` | 请求未指定时，新 worktree 分支所依据的 ref。 |
| `persist` | boolean? | `false` | 把 registry 的 row 镜像写入 `<worktreesRoot>/registry.json`，并在构造时加载它们。 |

## 事件

每一次提交的注册表变更——spawn、lock、unlock、remove——都会发出对应的 `worktree/*` 事件（见[事件目录](#cordis-surface)），携带已提交（对 remove 而言是已删除）的 row 及变更原因。这些都是只读的数据快照：监听者拿到的是 row 和原因，绝不是能回过头去操作注册表的可变句柄，因此它自己无法执行 lock、unlock 或 remove。

## 服务

`WorktreeService` 拥有 provider 注册表、slug 铸造、带门禁的 spawn/lock/unlock/remove 操作，以及内存中（可选持久化）的 row；`LocalGitWorktreeProvider`／`LocalGitWorktrees` 拥有某一个 provider 自身的 git 机制。目前尚无消费方包注册面向模型的工具——今天想使用 worktree 的调用方需要注入 `ctx.worktrees`，并且通常会把 `LocalGitWorktrees` 与它一起挂载。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Registry over the process's worktree providers plus the fenced lifecycle operations. Registering the same provider name twice fails loud; the returned disposer unregisters exactly that contribution.

```ts cordis-catalog
/**
 * Register one worktree provider under its own name.
 * @param provider - the provider implementation to admit.
 * @returns the disposer that unregisters this provider; fiber disposal triggers it.
 * @throws WorktreeError with code `DUPLICATE_PROVIDER` when a live provider already holds the name.
 */
registerProvider(provider: WorktreeProvider): () => void

/**
 * Look up one registered provider by exact name.
 * @param name - the provider's registry name.
 * @returns the provider, or undefined when the name is not live.
 */
getProvider(name: string): WorktreeProvider | undefined

/**
 * Enumerate the live provider names in registration order.
 * @returns fresh provider names.
 */
listProviders(): string[]

/**
 * Spawn one seat-scoped worktree: verify the working environment, mint the
 * slug, refuse the states force would paper over, create the worktree
 * locked, run the copy-list bootstrap, and publish the row. No mutation
 * happens before every check passes; a bootstrap failure rolls the
 * worktree back before the error surfaces.
 * @param request - seat, intent, and optional main ref.
 * @param providerName - provider to use; omitted resolves the single registered provider and refuses ambiguity.
 * @returns the published spawn result.
 */
async spawn(request: WorktreeSpawnRequest, providerName?: string): Promise<WorktreeSpawnResult>

/**
 * Enumerate the live registry rows in spawn order — one row per live branch.
 * @returns fresh row snapshots.
 */
list(): readonly WorktreeRow[]

/**
 * Look up one registry row by slug.
 * @param slug - the seam-minted slug.
 * @returns the row, or undefined when no live branch carries it.
 */
row(slug: WorktreeSlug): WorktreeRow | undefined

/**
 * Lock an unlocked worktree with a reason.
 * @param slug - the worktree's slug.
 * @param reason - why the worktree is being locked; carried on the row, the git lock, and the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 * @returns the committed row.
 */
async lock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow>

/**
 * Remove an existing lock, recording why.
 * @param slug - the worktree's slug.
 * @param reason - why the fence is coming down; carried on the row and the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 * @returns the committed row.
 */
async unlock(slug: WorktreeSlug, reason: string, providerName?: string): Promise<WorktreeRow>

/**
 * Remove an unlocked worktree and delete its row. A locked worktree refuses
 * with its lock reason — the caller must unlock with a reason first. The
 * branch itself survives removal; reusing its name stays forbidden.
 * @param slug - the worktree's slug.
 * @param reason - why the worktree is being removed; carried on the event.
 * @param providerName - provider to use; same resolution as {@link spawn}.
 */
async remove(slug: WorktreeSlug, reason: string, providerName?: string): Promise<void>
```

Source: [`packages/worktree/worktree/src/index.ts:175`](../../packages/worktree/worktree/src/index.ts)

<a id="worktree-events"></a>

### `worktree/*` events

<a id="worktreelocked--emit"></a>

#### `worktree/locked` — emit

A worktree was locked with the carried reason.

```ts cordis-catalog
/**
 * A worktree was locked with the carried reason.
 * @mode emit
 * @param payload - the committed row and the lock reason.
 */
'worktree/locked'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:152`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreeremoved--emit"></a>

#### `worktree/removed` — emit

A worktree was removed and its registry row deleted; the branch itself survives removal.

```ts cordis-catalog
/**
 * A worktree was removed and its registry row deleted; the branch itself
 * survives removal.
 * @mode emit
 * @param payload - the deleted row and the removal reason.
 */
'worktree/removed'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:166`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreespawned--emit"></a>

#### `worktree/spawned` — emit

A worktree was created, locked at birth with reason `<seat> <session>`, its copy-list bootstrap finished, and its registry row published.

```ts cordis-catalog
/**
 * A worktree was created, locked at birth with reason `<seat> <session>`,
 * its copy-list bootstrap finished, and its registry row published.
 * @mode emit
 * @param payload - the committed row and the spawn's reason.
 */
'worktree/spawned'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:146`](../../packages/worktree/worktree/src/index.ts)

<a id="worktreeunlocked--emit"></a>

#### `worktree/unlocked` — emit

A worktree's lock was removed; the committed row's `lockReason` is undefined.

```ts cordis-catalog
/**
 * A worktree's lock was removed; the committed row's `lockReason` is
 * undefined.
 * @mode emit
 * @param payload - the committed row and the unlock reason.
 */
'worktree/unlocked'(payload: WorktreeEventPayload): void
```

Source: [`packages/worktree/worktree/src/index.ts:159`](../../packages/worktree/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
