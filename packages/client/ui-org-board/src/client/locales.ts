/** `orgBoard` namespace dictionaries: the read-only org board footer control and its modal. */

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

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The read-only org board footer control and modal copy. */
    'orgBoard': OrgBoardKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<OrgBoardKey, string> = {
  'trigger': '组织架构图',
  'modal.title': '组织架构图（只读）',
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
}

/** English dictionary. */
export const en: Record<OrgBoardKey, string> = {
  'trigger': 'Org Board',
  'modal.title': 'Org Board (read-only)',
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
}
