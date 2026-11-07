# dsh-config-guard

[English](README.md) | 中文

零依赖库，避免凭据出现在插件配置校验错误中（OP-205，原 SWD-168）。

Schemastery 的类型不匹配解析器会把消息拼成 `expected <type> but got ${data}`，直接插入**收到的原始值**，而 cordis 在每次插件挂载和重载时都会记录该消息。若把凭据放进了类型错误的字段（例如把 API key 放进字典类型的 `env`，或放进 `headers`），它就会写入持久的宿主日志和 fiber 保存的错误中。本包会去掉被回显的值，保留路径和期望类型说明。

它是**库，不是服务或插件**：没有 `ctx`，不注册任何内容，不持有状态。

## API

```ts
import { guardConfigSchema, redactReceivedValue, RECEIVED_VALUE_WITHHELD } from '@deepseek-ai/dsh-config-guard'
```

| 导出 | 作用 |
|---|---|
| `guardConfigSchema(schema)` | 包装已构建完成的插件 `Config` schema，使其校验错误在两条路径上都被脱敏：Standard Schema 路径（`~standard.validate`，cordis `resolveConfig` 调用的接口）和直接调用路径（`schema(data)`，settings 服务使用）。可调用的 schema 会返回为透传 Proxy，其 `apply` 陷阱对抛出错误的 message 和 stack 脱敏并重新抛出同一对象。必须最后调用（其后链式调用或克隆会生成新的 schema 并丢失守卫）。 |
| `redactReceivedValue(message)` | 把 ` but got <value>` 尾部（含多行值）替换为固定标记。不含该值的消息原样返回。 |
| `redactThrown(error)` | 就地脱敏已抛出的校验错误：包括 message 和 `stack`（V8 会把 message 写入 stack 头部，仅改 `.message` 不够）。由 `apply` 陷阱和 mcp-client 使用。 |
| `RECEIVED_VALUE_WITHHELD` | 标记文本 ` (received value withheld)`。 |

## 用法

```ts
import z from '@deepseek-ai/schemastery'
import { guardConfigSchema } from '@deepseek-ai/dsh-config-guard'

export interface Config {
  apiKey: string
  env: Record<string, string>
}

export const Config: z<Config> = guardConfigSchema(z.object({
  apiKey: z.string(),
  env: z.dict(z.string()).default({}),
}))
```

守卫在实例上以不可枚举方式覆盖 schema 的 `~standard` 访问器（cordis 的 `resolveConfig` 调用的接口），并为直接调用把可调用 schema 包装成透传 Proxy；schema 的解析器、默认值和结构保持不变，`scripts/gen-config-catalog.ts` 会透过该调用识别其参数。

## Model Experience

无，因为配置校验错误出现在插件挂载之前，这里的任何内容都不会进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- **依赖 Schemastery 的措辞**：去除逻辑以 ` but got ` 为依据。每个受保护的包都带有通过真实 vendored Schemastery 运行的泄漏测试和金丝雀断言，措辞变化会明显报错。
- **仅覆盖配置校验**：校验之后由插件代码抛出的错误不在范围内。
- **`path` 不会被脱敏**：字典键名等路径信息原样保留。
- **mcp-client 只使用消息辅助函数**：它在 `rethrowRedacted` 中调用 `redactThrown`，而不是 `guardConfigSchema`，因为它的自定义类型解析器在抛出时就已完成脱敏。
- **按包选择启用**：插件必须自行包装 `Config`；长期方案是在 vendored 解析器中处理 schema 声明的密钥角色（需创始人批准）。
