# @deepseek-ai/dsh-context-pressure

[English](README.md) | 中文

一个需主动启用的插件，在请求准备阶段追加持久的、模型可见的上下文窗口压力警告，使模型能够在不断上升的压力触发自动压缩之前规划自己的压缩。默认组合保持其禁用；请将其与某个压缩后端及 `compact` 工具一同挂载。

## 配置

```yaml
- id: context-pressure
  name: '@deepseek-ai/dsh-context-pressure'
  config:
    thresholds: [0.25, 0.5, 0.75] # optional; fractions of the routed model's context window
```

`thresholds` 必须严格升序、互不相同，且每个值都位于 (0, 1) 区间内；违反约定会在插件加载时拒绝，并给出指出违规值的诊断。省略时解析为默认的 `[0.25, 0.5, 0.75]`。显式空数组会禁用所有警告。

## 去重与重置

每个步骤通过 `ctx.tokenMeter` 为最新 `request/header` 持久路由的 provider/model 测量压力，把配置的分数换算到该模型的通告窗口上，并对当前压缩代中最小的尚未警告且已被跨越的阈值发出一次警告。比最新警告更新的 `compaction/end` 事件会重置所有阈值，因此每次压缩之后所有阈值都会重新就绪。已警告状态从持久日志折叠得出——包括后来被压缩遮蔽的警告——因此重启与恢复绝不会在已经持久的阈值处重复警告。

当路由目标没有可解析的上下文窗口（适配器未通告或查询失败）时，插件对每个目标记录一条警告并跳过注入，不会阻塞步骤。日志中尚无 `request/header` 的会话没有路由目标，会被静默跳过。

## 模型体验

### 准备阶段的上下文窗口压力

#### 模型看到什么

步骤进入时，在已认领输入之后追加的一条带来源的 user 消息；`<threshold>` 是以百分数渲染的被跨越阈值，总量反映的是本警告加入该请求之前计量器测得的结果。

##### 警告文本

```markdown
Context pressure notice: usage passed the <threshold>% threshold of this model's context window: <total> of <window> tokens in use (<used>%); <remaining> tokens remain.
Before rising pressure forces automatic compaction, you can request compaction yourself with the compact tool.
```

#### Token 影响

每条警告约 60 个 token，每个压缩代内每个阈值最多添加一次；两次跨越之间的后续步骤不增加任何内容。

#### KV Cache 影响

只追加且模板文本稳定；新可见的内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **失败的压缩同样会重新就绪** —— 任何比最新警告更新的 `compaction/end` 都会重置各阈值，因此一次留下高使用率的失败自动压缩会在下一步重新警告旧阈值。
- **启发式压力** —— 总量来自 token 计量器的重放计价，在跨越点附近可能与 provider 自身的统计存在差异。
- **所有模型共用一组阈值** —— `thresholds` 应用于每个路由目标；按模型的覆盖需要类似 compaction-basic 的 `modelPolicies` 那样按键配置的目标。
- **无路由目标即无警告** —— 在第一条被记录的 `request/header` 之前的步骤，即使测量到的压力很高也会被跳过。
