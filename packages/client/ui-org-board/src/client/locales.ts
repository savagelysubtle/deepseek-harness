/** `orgBoard` namespace dictionaries: the org board footer control and its modal. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'orgBoard'

/** The org-board dictionary key set (the source of truth for both locales). */
export type OrgBoardKey =
  | 'trigger'
  | 'modal.title'
  | 'profile.label'
  | 'loading'
  | 'refresh'
  | 'error.rpc'
  | 'error.registry'
  | 'error.mailboxBridge'
  | 'error.toolMailbox'
  | 'error.drift'
  | 'roster.mailboxBridge'
  | 'roster.toolMailbox'
  | 'drift.title'
  | 'drift.unserved.title'
  | 'drift.unserved.empty'
  | 'drift.unserved.item'
  | 'drift.unregistered.title'
  | 'drift.unregistered.empty'
  | 'drift.unregistered.item'
  | 'graph.title'
  | 'graph.empty'
  | 'graph.seatCount'
  | 'badge.lead'
  | 'badge.test'
  | 'badge.unserved'
  | 'badge.callUp'
  | 'detail.hint'
  | 'detail.cwd'
  | 'detail.session'
  | 'detail.session.none'
  | 'detail.tools.allow'
  | 'detail.tools.deny'
  | 'detail.tools.none'
  | 'action.cancel'
  | 'action.add'
  | 'action.remove'
  | 'action.save'
  | 'action.serve'
  | 'action.stopServing'
  | 'write.notice.invalid'
  | 'write.notice.conflict'
  | 'write.notice.rejected'
  | 'write.notice.writeFailed'
  | 'write.notice.retry'
  | 'detail.served.label'
  | 'detail.served.value.served'
  | 'detail.served.value.unserved'
  | 'detail.served.value.split'
  | 'detail.served.toggle'
  | 'servedConfirm.title'
  | 'servedConfirm.description'
  | 'servedConfirm.split'
  | 'servedConfirm.acknowledge'
  | 'servedConfirm.acknowledgeSplit'
  | 'servedWrite.notice.invalid'
  | 'servedWrite.notice.conflict'
  | 'servedWrite.notice.rejected'
  | 'servedWrite.notice.writeFailed'
  | 'servedWrite.notice.split'
  | 'addSeat.trigger'
  | 'addSeat.name.label'
  | 'addSeat.cwd.label'
  | 'addSeat.validation.required'
  | 'seat.remove.trigger'
  | 'seat.remove.title'
  | 'seat.remove.cascade'
  | 'seat.remove.cascade.none'
  | 'seat.remove.cascadeCallUp'
  | 'seat.remove.acknowledge'
  | 'edge.remove.title'
  | 'edge.remove.description'
  | 'edge.remove.acknowledge'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The org board footer control and modal copy. */
    'orgBoard': OrgBoardKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<OrgBoardKey, string> = {
  'trigger': '组织架构图',
  'modal.title': '组织架构图',
  'profile.label': '数据来源 Profile：{profile}',
  'loading': '正在加载组织信息……',
  'refresh': '刷新',
  'error.rpc': '组织架构图不可用：{reason}',
  'error.registry': '注册表不可用：{reason}',
  'error.mailboxBridge': 'mailbox-bridge 名册不可用：{reason}',
  'error.toolMailbox': 'tool-mailbox 名册不可用：{reason}',
  'error.drift': '差异对比不可用：{reason}',
  'roster.mailboxBridge': 'mailbox-bridge',
  'roster.toolMailbox': 'tool-mailbox',
  'drift.title': '差异（注册表 vs. 实际提供的名册）',
  'drift.unserved.title': '已注册但未提供服务（{count}）',
  'drift.unserved.empty': '无',
  'drift.unserved.item': '{seat} — 缺失于：{rosters}',
  'drift.unregistered.title': '已提供服务但未注册（{count}）',
  'drift.unregistered.empty': '无',
  'drift.unregistered.item': '{seat} — 由以下名册提供：{rosters}',
  'graph.title': '席位与邮件权限',
  'graph.empty': '注册表中没有任何席位。',
  'graph.seatCount': '{count} 个席位',
  'badge.lead': '负责人',
  'badge.test': '测试席位',
  'badge.unserved': '未完全提供服务',
  'badge.callUp': '可致信任何席位',
  'detail.hint': '选择一个席位以查看详情。',
  'detail.cwd': '工作目录',
  'detail.session': '会话 ID',
  'detail.session.none': '未记录会话',
  'detail.tools.allow': '允许的工具',
  'detail.tools.deny': '禁止的工具',
  'detail.tools.none': '无工具限制',
  'action.cancel': '取消',
  'action.add': '添加',
  'action.remove': '移除',
  'action.save': '保存',
  'action.serve': '提供服务',
  'action.stopServing': '停止提供服务',
  'write.notice.invalid': '{reason} —— 未发送。',
  'write.notice.conflict': '自您加载以来，注册表已发生变化——可能是手动编辑。现已显示最新版本，如仍需要该改动，请重新执行一次。',
  'write.notice.rejected': '该改动被拒绝：{reason}。未写入任何内容——请修正后重试。',
  'write.notice.writeFailed': '保存未能完成（磁盘或连接问题，并非您的输入有误）。未发生任何改动——请重试。',
  'write.notice.retry': '重试',
  'detail.served.label': '提供服务状态',
  'detail.served.value.served': '已提供服务',
  'detail.served.value.unserved': '未提供服务',
  'detail.served.value.split': '不一致 —— 两份名册意见不一致',
  'detail.served.toggle': '更改提供服务状态',
  'servedConfirm.title': '更改提供服务状态',
  'servedConfirm.description': '更改 {seat} 的提供服务状态？保存后将立即在运行中的系统上生效——无需重启。此操作会重新加载 mailbox-bridge，并释放当前所有保持会话打开的席位，包括您未更改的席位。',
  'servedConfirm.split': '以下席位当前被两份名册以不同方式提供服务，保存后也会被统一到这同一份名单：{seats}。',
  'servedConfirm.acknowledge': '我知悉此操作将立即生效、无需重启，并将释放所有保持会话打开的席位。',
  'servedConfirm.acknowledgeSplit': '我知悉此操作将立即生效、无需重启，将释放所有保持会话打开的席位，并将统一上述不一致的席位到这同一份名单。',
  'servedWrite.notice.invalid': '{reason} —— 未发送。',
  'servedWrite.notice.conflict': '自您加载以来，已提供服务的名册已发生变化——可能是手动编辑。现已显示最新版本，如仍需要该改动，请重新执行一次。',
  'servedWrite.notice.rejected': '该改动被拒绝：{reason}。未写入任何内容——请修正后重试。',
  'servedWrite.notice.writeFailed': '保存未能完成（磁盘或连接问题，并非您的输入有误）。未发生任何改动——请重试。',
  'servedWrite.notice.split': '两份已提供服务的名册当前已不一致：仅 mailbox-bridge 提供服务的席位为 {onlyMailboxBridge}；仅 tool-mailbox 提供服务的席位为 {onlyToolMailbox}。请确认后重新保存以统一它们。',
  'addSeat.trigger': '添加席位',
  'addSeat.name.label': '席位名称',
  'addSeat.cwd.label': '工作目录',
  'addSeat.validation.required': '席位名称和工作目录均为必填项。',
  'seat.remove.trigger': '移除席位',
  'seat.remove.title': '移除席位',
  'seat.remove.cascade': '移除 {seat} 还将移除 {count} 条邮件权限连线：{edges}。',
  'seat.remove.cascade.none': '无',
  'seat.remove.cascadeCallUp': '{seat} 还将从可致信任何席位名单中移除。',
  'seat.remove.acknowledge': '我知悉此操作将移除该席位及上述连线。',
  'edge.remove.title': '移除邮件权限连线',
  'edge.remove.description': '移除 {from} 与 {to} 之间的邮件权限连线？',
  'edge.remove.acknowledge': '我知悉此邮件权限连线将被移除。',
}

/** English dictionary. */
export const en: Record<OrgBoardKey, string> = {
  'trigger': 'Org Board',
  'modal.title': 'Org Board',
  'profile.label': 'Profile: {profile}',
  'loading': 'Loading organisation…',
  'refresh': 'Refresh',
  'error.rpc': 'Org board unavailable: {reason}',
  'error.registry': 'Registry unavailable: {reason}',
  'error.mailboxBridge': 'Mailbox-bridge roster unavailable: {reason}',
  'error.toolMailbox': 'Tool-mailbox roster unavailable: {reason}',
  'error.drift': 'Drift unavailable: {reason}',
  'roster.mailboxBridge': 'mailbox-bridge',
  'roster.toolMailbox': 'tool-mailbox',
  'drift.title': 'Drift (registry vs. served rosters)',
  'drift.unserved.title': 'Registered but not served ({count})',
  'drift.unserved.empty': 'None',
  'drift.unserved.item': '{seat} — missing from: {rosters}',
  'drift.unregistered.title': 'Served but not registered ({count})',
  'drift.unregistered.empty': 'None',
  'drift.unregistered.item': '{seat} — served by: {rosters}',
  'graph.title': 'Seats and mail permissions',
  'graph.empty': 'No seats in the registry.',
  'graph.seatCount': '{count} seat(s)',
  'badge.lead': 'Lead',
  'badge.test': 'Test seat',
  'badge.unserved': 'Not fully served',
  'badge.callUp': 'May mail anyone',
  'detail.hint': 'Select a seat to see its details.',
  'detail.cwd': 'Working directory',
  'detail.session': 'Session ID',
  'detail.session.none': 'No session recorded',
  'detail.tools.allow': 'Allowed tools',
  'detail.tools.deny': 'Denied tools',
  'detail.tools.none': 'No tool restrictions',
  'action.cancel': 'Cancel',
  'action.add': 'Add',
  'action.remove': 'Remove',
  'action.save': 'Save',
  'action.serve': 'Serve',
  'action.stopServing': 'Stop serving',
  'write.notice.invalid': '{reason} — nothing was sent.',
  'write.notice.conflict': 'The registry changed since you loaded it — probably a hand edit. Showing the latest version now. Redo your change if you still want it.',
  'write.notice.rejected': 'That change was refused: {reason}. Nothing was written — fix it and try again.',
  'write.notice.writeFailed': 'The save didn’t go through (a disk or connection problem, not your input). Nothing changed — try again.',
  'write.notice.retry': 'Retry',
  'detail.served.label': 'Served status',
  'detail.served.value.served': 'Served',
  'detail.served.value.unserved': 'Not served',
  'detail.served.value.split': 'Split — the two rosters disagree',
  'detail.served.toggle': 'Change served status',
  'servedConfirm.title': 'Change served status',
  'servedConfirm.description': 'Change {seat}’s served status? Saving takes effect on the running system immediately — there is no restart. This reloads the mailbox bridge, which will release every seat that currently has a session open, including seats you are not changing.',
  'servedConfirm.split': 'The following seat(s) are currently served differently by the two rosters and will also be unified onto this one list: {seats}.',
  'servedConfirm.acknowledge': 'I understand this takes effect immediately, with no restart, and will release every seat with an open session.',
  'servedConfirm.acknowledgeSplit': 'I understand this takes effect immediately, with no restart, will release every seat with an open session, and will also unify the split seat(s) named above onto this one list.',
  'servedWrite.notice.invalid': '{reason} — nothing was sent.',
  'servedWrite.notice.conflict': 'The served rosters changed since you loaded them — probably a hand edit. Showing the latest version now. Redo your change if you still want it.',
  'servedWrite.notice.rejected': 'That change was refused: {reason}. Nothing was written — fix it and try again.',
  'servedWrite.notice.writeFailed': 'The save didn’t go through (a disk or connection problem, not your input). Nothing changed — try again.',
  'servedWrite.notice.split': 'The two served rosters already disagree: only mailbox-bridge serves {onlyMailboxBridge}; only tool-mailbox serves {onlyToolMailbox}. Confirm and save again to unify them.',
  'addSeat.trigger': 'Add seat',
  'addSeat.name.label': 'Seat name',
  'addSeat.cwd.label': 'Working directory',
  'addSeat.validation.required': 'Seat name and working directory are both required.',
  'seat.remove.trigger': 'Remove seat',
  'seat.remove.title': 'Remove seat',
  'seat.remove.cascade': 'Removing {seat} will also remove {count} mail-permission line(s): {edges}.',
  'seat.remove.cascade.none': 'none',
  'seat.remove.cascadeCallUp': '{seat} will also be removed from the may-mail-anyone list.',
  'seat.remove.acknowledge': 'I understand this removes the seat and the line(s) named above.',
  'edge.remove.title': 'Remove mail-permission line',
  'edge.remove.description': 'Remove the mail-permission line between {from} and {to}?',
  'edge.remove.acknowledge': 'I understand this mail-permission line will be removed.',
}
