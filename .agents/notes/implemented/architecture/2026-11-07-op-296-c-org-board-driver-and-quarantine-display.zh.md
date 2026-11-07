# Agent Note：组织看板显示被隔离的行和驱动字段

状态：已实现

[English](2026-11-07-op-296-c-org-board-driver-and-quarantine-display.md) | 中文

## 问题

组织注册表解析器会隔离无法接受的席位行，并在视图上以只读字段 `invalid` 报告原因。行还可以选择 `claude-code` 驱动，并带有 `admit_from` 与 `admit_sender_classes`。看板不显示这些内容，所以被隔离的席位看起来和正常席位一样，只有保存被拒绝时操作员才会知道（OpenProject #296 第 8 项）。

## 决定

看板用它已经收到的视图，以只读方式显示这些字段。线路格式、存储和写入路径均未改动。

- **席位节点。** `seatBadges`（`packages/client/ui-org-board/src/client/derive.ts`）新增 `invalid` 徽章（错误色，节点边框同未服务席位一样变红）和针对 `driver: claude-code` 的 `driver` 徽章（中性描边）。两者也出现在图例行。
- **详情面板。** `OrgBoard.tsx` 显示 `Driver`、`Admits mail from`、`Admitted sender classes`，以及带解析器原因的 `Quarantined (read-only)`，每项仅在该行有对应字段时出现。
- **第 9 项（guest 发件人）。** 不改动：`admit_sender_classes` 按存储值显示，在 S8 租约接收端落地之前，guest 发件人仍不能进入 claude-code 席位。

## 曾考虑的替代方案

**在看板上编辑驱动字段。** 否决：看板的文档是已解析的视图，无法携带被隔离的键；B2 切片和丢弃驱动的拒绝逻辑使驱动不在看板的写入路径上。

**只显示徽章，原因放在提示框里。** 否决：触屏设备没有悬停提示，而原因恰恰是操作员修改文件所需要的内容。

## 后果

操作员无需保存即可看到被隔离的席位及其原因。新增文案位于 `orgBoard` 语言命名空间（中英文）。
