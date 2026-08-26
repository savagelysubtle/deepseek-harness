[English](README.md) | 中文

# @deepseek-ai/dsh-named-sessions

命名会话的身份派生与跨进程按名互斥锁，供所有以稳定人工可读名称寻址持久会话的消费者共享——今天是 headless 运行器，明天是 mailbox 桥与其他命名运行表面。

没有映射存储：持久会话 id 由名称**派生**（`named-` + 名称 SHA-256 的 32 位十六进制），每个进程仅凭名称即可重算同一身份。同一 token 同时命名规范目录 `headless/locks/` 下的锁文件，使"每名一个存活持有者"通过纯文件系统语义跨进程成立。

## Service API

无 `ctx` 服务：这是纯工具库外加一个 invariant companion。

| 导出 | 语义 |
|---|---|
| `assertValidSessionName(name)` | 强制文件名安全文法 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；违规即抛出面向用法提示的错误。 |
| `deriveNamedSessionId(name)` | 已验证名称的确定性品牌化 `SessionId`。单向：无法从 id 还原名称。 |
| `acquireNamedSessionLock(name, options?)` | `<token>.lock` 的独占创建或接管。存活进程持有时响亮拒绝；持有者可证已消失（pid 死亡、内容不可读）时接管。设 `options.maxAgeMs` 后，超过时限的存活持有者也失去该文件；缺省（默认）时 pid 存活检测是唯一接管路径。 |
| `NamedSessionLock.release()` | 仅当文件仍记录本持有者时删除——被接管的文件属于其继任者。 |
| `namedLockPath(name)` / `lockPathForToken(token)` | id 到锁的代数唯一归属处；invariant companion 经此校验。 |

调用方自拥名称到地址的映射（通道路由、仪表盘）；本包只负责身份与互斥。

## Model Experience

无——没有任何内容进入模型请求。

#### KV Cache 效应

无。

## Known Limitations and Deferred Work

- 存活检测读取与重建之间存在狭窄的接管竞态窗口；同进程重试是调用方的对策。
- `maxAgeMs` 接管信任记录中的 `createdAt`；存活持有者的载荷缺少可读时间戳时，即便设置了时限仍然拒绝。
- 不提供存活名称枚举：`headless/locks/` 下的文件集可检视但不是公开 API。
