# @deepseek-ai/dsh-memory

[English](README.md) | 中文

DeepSeek Harness 的项目级持久记忆：以纯 Markdown 文件存储的笔记，跨会话、跨重启、跨席位持久存在，人类与 agent（智能体）在同一份真实文件上共同编辑。记忆是 TOOL 形态的——内容只在席位通过 `memory` 工具显式读取或搜索时才进入模型；不会有任何后台注入。

## 布局

本地提供方把笔记存放在单一存储根下（默认 `<harness home>/memory/`，即 `$DSH_HOME` 或 `~/.dsh`），每个项目一个目录：

```
memory/
  deepseek-harness-1v55erz/     ← scope slug: <project-name>-<6 hash chars of the project anchor>
    federation-org-model.md     ← topics at the top level
    todo/auth-notes.md          ← nested subdirs emerge organically (todo/, done/, spec/, …)
```

后缀对项目锚点做哈希——cwd 属于某个 git 仓库时取 git 公共目录，否则取解析后的 cwd——因此同一仓库的每个 worktree 共享同一个 scope（笔记跟随仓库而非 checkout），而两个同名的仓库仍然彼此区分。条目是普通 Markdown 文件；frontmatter 可选且逐字节保留。

## 插件

| 导出 | 角色 |
|---|---|
| `.` | `MemoryService` 服务定义（`ctx.memory`），以及 slug／jail 辅助函数与类型 |
| `./local` | `LocalMemoryProvider`——文件系统提供方插件（`name: memory-local`） |
| `./tool` | `memory` 消费方工具插件（`name: tool-memory`，注入 `tools`） |
| `./invariant` | 包 invariant 伴随插件 |

在 agent preset 上同时挂载提供方与工具即可为该 preset 的 agent 开启记忆；除 `ctx.tools` 外不消费任何宿主面注册表。

## 服务面（`ctx.memory`）

- `read(cwd, path)` 原样返回条目；缺失路径快速失败并给出 slug 与路径。
- `write(cwd, path, content)` 完整替换，隐式创建目录；写入经同目录临时文件改名落盘，协作读者永远不会看到写了一半的文件。若该路径已有条目，会先保留其原内容（见下文「保留历史」），并在结果中报告被替换的内容；若保留失败，写入本身失败，而不会退回到无保护的覆盖。
- `list(cwd)` 递归返回全部条目，按路径排序，附字节大小。
- `search(cwd, query, limit?)` 是逐行大小写不敏感的子串扫描，返回有上限的 `{path, line, excerpt}`。

每个操作都先对 `path` 执行 jail：必须相对、仅用正斜杠、不得含 `..`、无 NUL、长度受限——违规在任何 I/O 之前被拒绝。单个条目最多 256 KiB UTF-8。

## 保留历史

当 `write()` 落在一个已有条目的路径上时，该条目不会被直接销毁：它的内容会先被复制到 scope 根目录下的 `.replaced/<相同相对路径>.<时间戳>`，然后写入才会继续进行。`.replaced/` 目录以点号开头，因此 `list()` 与 `search()`（二者都会跳过点号文件）永远不会展示它——这对模型来说不产生任何可见成本。每个条目最多保留 5 个历史版本，超出后先修剪最旧的；之所以保留不止一个版本，是因为这里防范的失败场景是若干个写者在几秒内争抢同一路径，而不仅仅是一次覆盖。如果保留原内容这一步本身失败，写入会直接失败，而不会退回到无保护的覆盖。

## `memory` 工具

一次 action 判别式调用：`{action:"read"|"write"|"list"|"search", path?, content?, query?}`。项目作用域取自调用会话的 `cwd`；没有 agent 会话的调用会被拒绝，而不是回退到服务器启动目录。

## 与认证无关的配置

配置总共两项：提供方接受可选的 `root` 覆盖存储树，工具接受可选的 `searchLimit` 钳制。二者默认合理并在加载时校验失败即报错。

## 模型体验

### 记忆条目

#### 模型看到的内容

默认什么都没有：注册记忆不会增加提示词文本、系统提示段或目录侧提醒。会话只看到它读取的内容——`read` 结果作为工具结果原样给出条目 Markdown；`list` 渲染每条目一行 `- <path> (<N> B)`；`search` 渲染 `[<path>:<line>] <excerpt>` 行；`write` 渲染一行确认——若该写入替换了已有条目，还会追加第二句刻意直白的话，写明被替换条目的大小与最后修改时间，并明确说明原内容被保留而非删除。失败渲染其诊断（`isError` 结果），jail 拒绝正是借此教会模型路径语法。

#### Token 影响

未使用时为零——成本推迟到显式调用，之后与读入或命中的内容线性相关（摘要截断限制每一搜索行）。写入只把一行确认放进历史；大文件留在磁盘上而不进上下文窗口。

#### KV Cache 影响

挂载期间工具定义为每次请求增加固定的前缀成本，与其他工具 schema 一样稳定。调用结果追加在可复用前缀之后，从不使更早的缓存项失效；重复 `read()` 同一未变条目产生逐字节相同的结果，前缀保持稳定。

## 已知限制与暂缓事项

- **可见条目上最后写入者获胜**：并发写者仍会各自整体覆盖可见内容，没有合并；但原内容会被保留（见上文「保留历史」）而不是被销毁，因此被争抢路径上落败一方的笔记是可恢复的，而不是丢失。人类协作者仍应依赖小而专的主题文件来从一开始就避免冲突。
- **尚无删除／移动动作**：生命周期修剪（如 done/）由人在磁盘上完成；工具 list 反映磁盘现状。
- **搜索仅为子串**：无正则、排名、embedding，也不跨项目。
- **作用域只来自会话头**：agent 缺少会话 cwd 的部署只会收到明确的诊断错误；刻意不设隐式回退。
