# Agent Note：组织看板不能删除或重命名 claude-code 席位

状态：已实现

[English](2026-11-07-op-296-b2-claude-code-seat-delete-refusal.md) | 中文

## 问题

`org.write` 已经会拒绝这样的保存：同名行仍在，但去掉了 `claude-code` 驱动。而删除该行、或重命名（到达主机时表现为删除加新增）的保存会通过该检查，因为它只检查以同名保留的行。工单（OpenProject #296 第 7 项）记录了 claude-code 席位可被从看板上悄悄移除。

## 决定

`org.write`（`packages/host/apiproxy/src/api-proxy.ts`）同样拒绝省略了磁盘上驱动为 `claude-code` 的行的文档。拒绝代码为 `org-registry-rejected`，消息以 `org-registry-driver-seat-removed:` 开头，指出席位名、说明磁盘行保存着驱动设置且邮箱与会话与名字绑定，并给出解决办法：手工编辑注册表文件并重启主机。不会写入任何内容。普通的默认循环席位仍可从看板删除。

## 曾考虑的替代方案

**在看板里加确认步骤。** 否决：写入 API 没有确认通道，客户端确认也拦不住 `org.write` 的其他调用者。

**允许删除并给出警告。** 否决：claude-code 行保存着看板无法重建的驱动设置（看板不能设置驱动），删除会丢失看板无法恢复的状态。

## 后果

确实要移除 claude-code 席位的操作员需手工编辑注册表文件。拒绝信息显示在看板的保存错误中，解决办法在同一条消息里。
