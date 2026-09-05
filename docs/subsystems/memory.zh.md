# 持久项目记忆

[English](memory.md) | 中文

memory seam 为每个工作区存储持久化的纯 Markdown 笔记，由人和代理像普通文件一样共同编辑。内容只有在座位通过 `memory` 工具显式读取或搜索时才会进入模型上下文——记忆是一次工具调用，绝非后台注入。[`MemoryService`](../../packages/memory/memory/src/index.ts) 声明各操作，[`LocalMemoryProvider`](../../packages/memory/memory/src/local.ts) 在单一文件系统根上实现它们，包级 [README](../../packages/memory/memory/README.md) 负责存储布局与 Model Experience 细节。

## 项目作用域

每个操作都从调用方的绝对 `cwd` 解析其项目作用域：笔记属于检出（checkout）本身，从不属于某个会话、座位或进程。同一工作区在所有会话、重启和座位之间共享作用域，而两个检出之间从不共享笔记。[`projectSlug()`](../../packages/memory/memory/src/scope.ts) 以 `<清洗后的工作区 basename>-<解析后 cwd 的 sha256 的 6 个哈希字符>` 命名各作用域目录，因此同名检出也保持目录互异。

## 存储值

所有存储值均使用作用域相对的 POSIX 路径（正斜杠，无前导 `/`）：

```ts type-equiv
/** One stored memory entry as `list()` reports it. */
interface MemoryEntry {
  /** Scope-relative POSIX path with forward slashes (`todo/auth.md`). */
  readonly path: string
  /** UTF-8 byte size of the stored file. */
  readonly bytes: number
}
```

```ts type-equiv
/** One search hit inside the scoped tree. */
interface MemoryMatch {
  /** Scope-relative path of the matching entry. */
  readonly path: string
  /** 1-based line number of the first match on that line. */
  readonly line: number
  /** The matched line, trimmed and clipped to the excerpt budget. */
  readonly excerpt: string
}
```

```ts type-equiv
/** Result of one committed write. */
interface MemoryWriteResult {
  /** Scope-relative path written (normalized form of the requested path). */
  readonly path: string
  /** Stored UTF-8 byte size. */
  readonly bytes: number
}
```

来源：[`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## 上限与路径隔离

[`packages/memory/memory/src/scope.ts`](../../packages/memory/memory/src/scope.ts) 提供纯函数形式的界限助手；每个提供方都在任何文件系统调用之前应用它们：

- `MAX_ENTRY_PATH_LENGTH` —— 允许的最长相对条目路径，按字符计（200）。
- `MAX_ENTRY_BYTES` —— 单个条目的最大可存储体积，作用于完整 UTF-8 值（256 KiB = 262,144 字节）。
- `MAX_LIST_ENTRIES` —— `list()` 输出整体结果上限（1,000 个条目）。
- `DEFAULT_SEARCH_LIMIT` —— 一次 `search()` 默认返回的最大匹配数（50）。
- `MAX_SEARCH_LIMIT` —— `search()` 结果的硬性上限，无论请求传入多大 limit（200）。

`jailedScopePath()` 在任何 I/O 之前对模型或调用方提供的相对路径做隔离检查：绝对路径、`\` 或 NUL 字节、任一段落中的 `..` 穿越、空路径以及超长名称都会带出错输入响亮拒绝——静默改写路径会把内容写到调用方并未要求的位置。合法路径会被规范化（`a//b/.` 折叠为 `a/b`）。

## 服务操作

[`MemoryService`](../../packages/memory/memory/src/index.ts) 是发布为 `ctx.memory` 的抽象 Service Definition；提供方在同一存储根上实现四个操作，每个都以自己的 `cwd` 参数解析项目作用域：

- `read(cwd, path)` 原样返回一个条目的完整文本，frontmatter 一并包含。
- `write(cwd, path, content)` 创建或完整替换一个条目并按需创建缺失目录；结果报告规范化路径与写入字节大小。
- `list(cwd)` 递归遍历作用域，返回按路径排序、附带字节大小的全部条目。
- `search(cwd, query, limit?)` 对作用域内条目的各行执行大小写不敏感的子串扫描，返回先按路径、再按行号排序的匹配；空查询拒绝，结果从不超过 `MAX_SEARCH_LIMIT`，超大或不可读条目被静默跳过。

本地提供方附加保证：写入经由同目录临时文件改名落盘，共同编辑者看到的要么是旧文件要么是新文件，绝无残缺中间态；读取缺失条目时会点名项目 slug 和路径响亮失败；作用域缺失意味着零个条目而非错误；`list()` 跳过点文件和临时文件。

## `memory` 工具

[`tool.ts`](../../packages/memory/memory/src/tool.ts) 消费方向宿主工具注册表的预设层注册以动作区分的 `memory` 工具 `{action:"read"|"write"|"list"|"search", path?, content?, query?}`，注册返回注册表 disposer。调用时它严格用 `ctx.get('memory')` 解析服务——提供方未挂载时就地点名补救方式失败，而不是降级运行。read/write 要求非空的作用域相对 `path`，write 还要求完整的替换用 `content`，search 要求非空 `query`。项目作用域仅来自调用代理会话头中的 `cwd`：没有会话 cwd 时调用直接拒绝，绝不回退到服务器启动目录。可选配置钳制 `searchLimit`（校验范围 1–200，默认 50）限制每次调用返回的匹配数，仍受服务自身硬上限约束。

## 组合与挂载

提供方发布 `ctx.memory`，因此组合层把它挂载到入口本地 realm 中，并让工具共享该 realm 以看到实例；没有显式调用就不会有任何内容进入提示词。标准预设在其 `memory` 分组中固定了这一形状，见 [`apps/cli/config/agent-presets/standard/agent.cordis.yml`](../../apps/cli/config/agent-presets/standard/agent.cordis.yml)，profile 补丁层复用同一分组形状。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Abstract memory service. Providers implement the four operations over one storage root; every operation resolves the project scope from the caller's absolute `cwd` through the project anchor, so two repositories never share notes, every worktree of one repository shares one scope, and the scope persists across every session, restart, and seat.

```ts cordis-catalog
/**
 * Read one entry's full text.
 * @param cwd - absolute working directory naming the project scope.
 * @param path - scope-relative POSIX path; jailed before any I/O.
 * @returns the file content verbatim, frontmatter included.
 */
abstract read(cwd: string, path: string): Promise<string>

/**
 * Create or replace one entry atomically enough for human co-editors:
 * temp-file plus rename inside the target directory, so a reader never sees
 * a torn write.
 * @param cwd - absolute working directory naming the project scope.
 * @param path - scope-relative POSIX path; missing directories are created.
 * @param content - complete replacement text (UTF-8).
 * @returns the normalized path and stored byte size.
 */
abstract write(cwd: string, path: string, content: string): Promise<MemoryWriteResult>

/**
 * List every entry in the project scope, recursive, sorted by path.
 * @param cwd - absolute working directory naming the project scope.
 * @returns all entries with their byte sizes.
 */
abstract list(cwd: string): Promise<MemoryEntry[]>

/**
 * Case-insensitive substring search across the scoped entries' lines.
 * Empty files and oversized skips are silent; results are bounded by
 * {@linkcode MAX_SEARCH_LIMIT} regardless of the requested limit.
 * @param cwd - absolute working directory naming the project scope.
 * @param query - substring to find; empty queries reject.
 * @param limit - maximum matches to return (default {@link DEFAULT_SEARCH_LIMIT}).
 * @returns ordered by path, then line number.
 */
abstract search(cwd: string, query: string, limit?: number): Promise<MemoryMatch[]>
```

Source: [`packages/memory/memory/src/index.ts:39`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
