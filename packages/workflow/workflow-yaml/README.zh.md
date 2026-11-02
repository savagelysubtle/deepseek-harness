# @deepseek-ai/dsh-workflow-yaml

[English](README.md) | 中文

Workflows 功能（OP-240）使用的纯 YAML 工作流定义包：负责 `.workflows/<name>.yaml` 文件的解析、校验、图编译与布局。本包不做任何 I/O，也不注册 Cordis 服务，因此 Host 工具、Host Remote 服务与浏览器编辑器共用同一实现。唯一的运行时依赖是 [`yaml`](https://eemeli.org/yaml/)。包根目前只导出 `WORKFLOW_YAML_SCHEMA_VERSION`。

## 模型体验

无，因为本包只解析和校验工作流文件，不向任何模型请求贡献内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **仅为脚手架** —— 模式、诊断、图编译器与布局尚未实现；包根只导出模式版本常量。
