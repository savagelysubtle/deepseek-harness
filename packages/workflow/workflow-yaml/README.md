# @deepseek-ai/dsh-workflow-yaml

English | [中文](README.zh.md)

Pure YAML workflow definitions for the Workflows feature (OP-240): the parser, validator, graph compiler, and layout for `.workflows/<name>.yaml` files. The package performs no I/O and registers no Cordis service, so the Host tool, the Host Remote service, and the browser editor share one implementation. Its only runtime dependency is [`yaml`](https://eemeli.org/yaml/). The package root currently exports only `WORKFLOW_YAML_SCHEMA_VERSION`.

## Model Experience

None, as this package parses and validates workflow files and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Scaffold only** — the schema, diagnostics, graph compiler, and layout are not implemented yet; the package root exports only the schema version constant.
