# 配置模型

[English](providers.md) | 中文

本指南假定你已按照[根 README](../../../README.md#run)启动 Web UI。模型变更会在下一次请求时生效，不需要重启服务器。

## 配置 DeepSeek

打开**设置 → 模型**。DeepSeek 卡片提供一个 API 密钥字段；输入密钥并保存。

![模型页：DeepSeek 卡片，以及添加提供方与添加自定义提供方两个入口](providers-models-page.zh.png)

密钥是只写的。保存后，页面只会收到脱敏描述符，永远不会收到明文密钥。密钥存储在 `$DSH_HOME/.credentials.yaml` 中，settings 只保留它的凭据引用。

## 添加目录提供方

选择**添加提供方**，选取 Anthropic 或 OpenAI 等提供方，输入其 API 密钥并保存。已安装目录会提供端点、协议和模型列表。

使用原生认证的提供方需要各自的原生凭据。Bedrock、Vertex、Azure 和 Codex 分别使用 AWS 凭据与区域、ADC 项目、`api-version` 和 OAuth；只填写 API 密钥字段无法完成配置。Claude Code 通过子 agent 工具而非模型页面使用你自己的 Claude 登录，参见下文“Claude：订阅与 API 密钥”一节。

## 添加自定义提供方

对于公司网关、自建服务器或已安装目录中不存在的提供方，选择**添加自定义提供方**。提供小写 Provider ID、基础 URL、API 协议、凭据和至少一个模型。

![自定义提供方表单：Provider ID、显示名称、API 地址、API 协议、API 密钥](providers-custom-form.zh.png)

Provider ID 是永久的，因为请求、已保存会话、模型默认值和凭据引用都会使用它。如需重命名提供方，请添加新提供方并删除旧提供方。显示名称、基础 URL、协议、凭据和模型仍可编辑。

在**模型目录**中选择**获取可用模型**，可查询表单当前显示的基础 URL 和凭据。选择候选项只会更新草稿；保存前不会存储提供方。目录提供方使用已安装目录，不发起网络请求。

### 图片输入

手动输入的模型在自己声明之前一律按纯文本对待，因为没有任何环节能去询问端点接受哪些模态。给这类模型附加图片，会在发送前就被拒绝，并点名该模型。

因此自定义提供方下的视觉模型需要加一行。表单没有对应字段；请在 `$DSH_HOME/settings.yaml` 中给该模型加上 `input`：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
```

`input` 接受 `text` 和 `image`，且只作用于该模型，因此一条路由可以同时服务两类模型。省略它——或写成空列表，两者同义——则保留已安装目录为该模型记录的模态；目录未描述的模型则回退到该路由的 `defaultInput`。

如果你手动录入的模型全都接受图片，可以在路由上设置一次回退值，不必逐个模型写：

```yaml
llm-pi-ai:
  providers:
    vision-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://vision.example/v1
      defaultInput: [text, image]
      models:
        - id: first-model
        - id: second-model
```

`defaultInput` 是回退值而不是覆盖值，默认为 `[text]`：在目录提供方上，它只为目录未描述的模型作答，因此绝不会把目录中本就具备图片能力的模型的该能力去掉。要收窄这类模型，请用它自己的 `input`。目录提供方没有可供填写的 `models` 列表，因此写在 `modelOverrides` 下，以模型 id 为键：

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

除模型自身的列表外，每个列表都至少要写一项模态；模型自身的空列表与省略它同义。未知模态在任何位置写入都会被拒绝。

这两个字段都是对你端点的断言，而不是对它的检查。声明了端点并不提供的图片能力的模型不会在这里被拦下，改由提供方拒绝该请求。

## Claude：订阅与 API 密钥

使用 Claude 有两种相互独立的方式，计费方式也不同。

- **订阅（原生登录）。** 可选的 Claude Code 子 agent 运行你已安装并用自己账户登录的 `claude`，模型通过工具 `subagent_claude_code` 调用它，消耗你套餐的额度。生产 `dsh` 默认不挂载它；Profile 通过 `examples/acp-agent/product-subagent-claude-code.cordis.yml` 中的覆盖文件选择启用（详见 `packages/subagent/subagent-claude-code/README.zh.md`）。先用 `claude` 登录一次；无人值守的宿主请运行 `claude setup-token`，并把 `CLAUDE_CODE_OAUTH_TOKEN` 设置在该子 agent 的 `config.env` 中，因为环境中具有凭证特征的变量会被清除。
- **API 密钥。** 在**设置 → 模型**下添加 Anthropic 提供方（`llm-pi-ai` 提供方，使用 `apiKeyEnv`）。请求由 dsh 自己的 agent 发出，按 token 向该密钥计费。

请仅在 dshTest Profile 中使用此覆盖文件，切勿用于 base 或在线席位的组装：目前 `subagent_claude_code` 没有按会话的调用上限或审批，每次调用都是一个全新的 Claude Code 会话并消耗套餐额度，被提示注入或陷入循环的模型可能反复调用（调用上限属于单独的后续工作）。

在子 agent 的 `config.env` 中设置 `ANTHROPIC_API_KEY` 会让该后端由订阅改为 API 计费。提供方自身绝不提供 API 密钥，并会清除环境中的凭证变量，但子进程仍会读取你自己的 `~/.claude/settings.json`（所有设置来源都会加载），其中可能带有 `env` 块或 `apiKeyHelper`，并继承 `ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 等非凭证变量；这些都可能改变计费或路由（`ANTHROPIC_BASE_URL` 被改动会把 OAuth bearer 发送到该地址）。登录过期预期会报错而不是改用 API 密钥（预期行为，未经验证）。

政策提示（未经核实）：Anthropic 的 Agent SDK 条款可能限制第三方产品提供 claude.ai 登录。依赖订阅方式之前，请查阅 https://code.claude.com/docs/en/agent-sdk/overview 。

## 选择模型

已配置的提供方会出现在模型选择器中。选择模型也会将其设为新会话的默认值。已发送过请求的会话会保留自身日志中记录的模型。

如果已保存默认值指向已删除的提供方，输入框会显示**选择模型**，并在选择其他模型前阻止输入。

## 排错

- **`MISSING_CREDENTIAL`**：通过模型页存储提供方密钥，或提供被引用的环境变量。
- **`UNKNOWN_MODEL`**：选择已配置的模型，或向自定义提供方添加缺失的模型。
- **获取可用模型返回 401**：检查密钥。模型发现会调用 OpenAI 兼容的 `GET /models` 端点；对于不提供该端点的服务，请手动输入模型。
- **图片在发送前被拒绝**：该模型未声明图片模态。请给自定义提供方的模型加上 `input: [text, image]`；DeepSeek 自身的 chat-completions 路由是纯文本的，且无法通过配置改变。
- **提供方拒绝了带图片的请求**：该模型声明了其端点实际并不提供的图片能力。请从授予它图片能力的那个列表中移除 `image`——可能是模型的 `input`，也可能是路由的 `defaultInput`——然后开启新会话：附加的图片会留在会话日志里，因此在会话离开它之前，同一个请求会不断重复。

## 进阶配置

自动生成的[插件配置目录](../../config-catalog.md)列出所有受支持的字段与默认值。[`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) 和 [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) 参考文档负责直接 `settings.yaml` 配置、目录解析、推理控制、凭据与适配器错误。
