# dsh-port-allocator

[English](README.md) | 中文

面向并行会话的按会话端口与环境分配。Worktree 只隔离文件，不隔离端口：N 个并行会话各自运行开发服务器时，需要 N 个互不冲突的端口以及互不串扰的环境。本包是这套分配背后的零依赖库——`PortAllocator` 只发放经过真实可绑定验证的端口，`EnvIsolator` 则以全新对象构建每个会话的环境。

它是**库，而非服务或插件**：没有 `ctx`，不注册任何内容，也不发出事件。会话生命周期消费方将分配接到会话启动、将释放接到会话结束；本包既不拥有会话，也不拥有进程。

## 对外接口

```ts
import {
  EnvIsolator,
  PortAllocationError,
  PortAllocator,
  MAX_TCP_PORT,
  MIN_TCP_PORT,
  resolveEnvIsolatorConfig,
  resolvePortAllocatorConfig,
} from '@deepseek-ai/dsh-port-allocator'
```

| 导出项 | 职责 |
|---|---|
| `PortAllocator` | 从已验证的区间内为每个会话分配下一个空闲端口；`release(port)` 在会话结束时将其归还到池中。并发的 `allocate()` 调用会被串行化，因此两个会话永远不会拿到同一个端口。 |
| `resolvePortAllocatorConfig(input)` | 配置入口：验证 `min`/`max`（整数、合法 TCP 区间、`min < max`）、`maxAttempts`（整数 ≥ 1）、`probeHost` 以及种子 `inUse` 端口。默认值在这里显式解析，绝不会出现在调用点。 |
| `PortAllocationError` | 无端口可用时由 `allocate()` 拒绝；按探测顺序携带每一次失败的探测（`port`、`code`、`message`）。 |
| `probeFailure(port, error)` | 将一次监听错误归一化为探测失败记录；当错误未携带 code 时回退为 `UNKNOWN`。 |
| `EnvIsolator` | 由会话的基础环境与已分配端口构建会话环境：端口变量、可选的会话 id 变量，以及已配置基础变量的会话后缀值。 |
| `resolveEnvIsolatorConfig(input)` | 环境配置入口：POSIX 名称验证、后缀名唯一性校验，以及配置后缀时要求非空分隔符。 |
| `MIN_TCP_PORT` / `MAX_TCP_PORT` | 显式绑定的合法 TCP 区间（`1`–`65535`）；由协议固定，不可配置。 |

## 分配机制

分配器按从小到大的顺序扫描区间，跳过已发放的端口和种子 `inUse` 端口。不在该集合中的端口仍可能被外部进程占用，因此每个候选端口都会做**真实可绑定**探测：一个真实的 `net.Server` 在配置的探测接口上监听后立即关闭。探测使用 Node 自身的服务器默认选项，因此其结果可以预测消费方在同一主机上的后续绑定。探测在 `maxAttempts` 处停止；耗尽时以 `PortAllocationError` 拒绝，其中列出每一次失败的探测以及区间的其他占用情况。

`probeHost` 默认为 `127.0.0.1`：harness 消费方绑定 loopback，loopback 探测恰好能发现这些消费方会冲突的占用者。只有当消费方绑定全部接口时才选择 `0.0.0.0`——它会过度检测（跳过 loopback 绑定仍可使用的端口），这是安全的方向。

```ts
const allocator = new PortAllocator({ min: 3100, max: 3199, maxAttempts: 5 })
const port = await allocator.allocate()      // verified bindable, reserved
// ... hand `port` to the session's dev server ...
allocator.release(port)                      // session ended
```

## 环境隔离机制

`sessionEnv()` 将调用方的基础环境复制到全新对象中，把已分配端口写入 `portVar`，并在提供会话 id 时将其写入 `sessionVar`、追加到每个已配置 `suffixVars` 条目的基础值之后（以 `suffixSeparator` 分隔），用于会话私有的临时目录、缓存路径等。基础环境中不存在的后缀变量在结果中保持缺失：隔离从不凭空创造值。本模块不持有对 `process.env` 的引用，也从不修改调用方的 `baseEnv`。

```ts
const isolator = new EnvIsolator({
  portVar: 'PORT',
  sessionVar: 'DSH_SESSION_ID',
  suffixVars: ['TMPDIR'],
  suffixSeparator: '-',
})
const env = isolator.sessionEnv({ baseEnv, port, sessionId: session.id })
// { ...baseEnv, PORT: '3100', DSH_SESSION_ID: 'session-7', TMPDIR: '/tmp/dsh-session-7' }
```

## 已知限制与暂缓事项

- **探测后关闭留有交接窗口**：在探测关闭与消费方真实绑定之间，外部进程可能抢占该端口。本进程内的兄弟会话受分配器保留机制保护；剩余的竞态发生在跨进程之间，消费方在 `allocate()` 解决后立即绑定即可消除该窗口。
- **探测预测的是默认选项下的 Node `net.Server` 绑定**：通过其他协议栈或使用非默认套接字标志绑定的消费方，仍可能遇到探测无法发现的冲突。
- **loopback 探测按设计不会发现非 loopback 占用者**：仅绑定在其他接口上的端口会被视为空闲；当消费方绑定全部接口时，请配置 `probeHost: '0.0.0.0'`。
- **无跨进程协调**：分配状态是单个进程的内存。其他进程或更早运行所占用的端口由探测捕获，或通过种子 `inUse` 集合排除，而不依赖共享记账。
- **释放的端口会被重新探测，而非隔离**：释放的端口可能立即被再次发放；上一个会话残留的外部占用会被下一次分配的探测捕获。
