# @deepseek-ai/dsh-tool-workflow-run

[English](README.md) | 中文

面向模型的 **`workflow_run` 工具**与 **`ctx.workflowRuns` 服务**：执行 YAML 工作流定义（`.workflows/<name>.yaml`，由 [`@deepseek-ai/dsh-workflow-yaml`](../workflow-yaml/README.md) 解析），基于 [`ctx.workflowEngine`](../workflow/README.md)，并通过 [`@deepseek-ai/dsh-workflow-run-store`](../workflow-run-store/README.md) 记录每次运行。它与 [`@deepseek-ai/dsh-tool-workflow`](../tool-workflow/README.md) 并存，后者继续按原样运行模型编写的 JavaScript 脚本。

当前版本只是包脚手架：插件声明自身标识与所需服务（`tools`、`workflowEngine`）并完成挂载，但不注册任何内容。工具、服务、信任与审批逻辑以及会话记录将在 OP-240 的后续切片中落地。

## 模型体验

### workflow_run 工具

#### 模型看到的内容

目前没有：脚手架既不注册工具，也不注册系统提示词段落。工具描述及其使用指导将随工具本身一并提供。

##### 工具描述与指导（占位）

```markdown
Placeholder: the workflow_run tool description and usage guidance are written when the tool is registered.
```

#### Token 影响

脚手架不注册任何内容时没有影响；工具注册后，在其可见的每个请求上会增加固定的 schema 开销。

#### KV Cache 影响

未注册任何内容时相互独立；工具注册后，只要其定义与可见性不变，工具 schema 保持前缀稳定。

## 已知限制与暂缓事项

- **仅为脚手架** —— 尚未注册任何工具或服务，因此 `workflow_run` 与 `ctx.workflowRuns` 还不存在。
