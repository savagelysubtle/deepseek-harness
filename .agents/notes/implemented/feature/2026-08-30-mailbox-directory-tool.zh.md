# Agent Note: mailbox_directory — 席位发现，邮箱工具的点名册

Status: implemented

[English](2026-08-30-mailbox-directory-tool.md) | 中文

## Problem

邮箱接缝按裸名寻址席位，却没有任何东西告诉一个席位哪些名字存在。`list_agents` 一类的注册表列出的是 subagent，不是同僚；组织注册表文件里有花名册，但藏在没有任何模型可见工具暴露的裸文件访问之后。一个被要求"给部门主管寄信"的席位只能每次由 Steve 在对话里告知名字——发现能力是缺失的原语，缺了它，其他三个工具自身并不完整可用。

## Decision

`mailbox_directory` 是同一挂载点上的第四个工具，与姊妹工具同一构造模式。它不取参数、不携带身份——目录是组织知识，不是席位数据，因此在身份要到发送时才存在的匿名运行上也能工作。它把本主机的受服花名册（`Config.addresses`）与组织注册表（`Config.orgRegistryPath`，默认为 harness home 的 `org/registry.yml`——与桥读的是同一文件、同一默认）合并，为每个席位标注 `served`、`lead`、`test`，并按字母序排列。

组织注册表按调用加载，由加载器按 mtime 缓存。加载失败的注册表把结果退化为受服花名册，并在结果中声明 `orgRegistry: 'unavailable'`——目录只是信息性的，而 `mailbox_send` 无论目录显示什么都强制拓扑与准入，所以退化的列表绝不会扩大一个席位实际能寄的范围。测试席位即便被本主机受服也只渲染在"绝不可邮寄"分组里：在"受服"名下邀请向测试席位寄信，会把模型引向一个必然的拒绝。

## Alternatives considered

- **只列花名册（不读组织注册表）**——否决：角色正是让模型选对收件人（"部门主管"）的东西，而注册表本来就是接缝的权威花名册。
- **在列表中给出驻留/存活状态**——延期：存活状态在桥手里，注入它会让工具为了锦上添花而耦合到桥的服务上。谁存在是要件；谁醒着不是。

## Consequences

工具 schema 长出第四个条目（目录已再生成），`tool-mailbox` 为注册表路径默认值新增了 `dsh-home-paths` 依赖。把桥指向非默认 `orgRegistryPath` 的部署应让工具指向同一文件，使目录与桥描述同一个组织。列表只读且无身份，因此它既不扩大席位能寄的范围，也不泄露席位级状态。

## Testing

`packages/mailbox/tool-mailbox/tests/tool-mailbox.spec.ts` 钉住：零参数 schema 与描述契约、花名册加注册表的合并及 `served`/`lead`/`test` 标注与字母序、渲染分组（受服的测试席位只出现在绝不可邮寄分组）、注册表不可用时退化为仅花名册并声明退化，以及无身份的匿名运行可用。
