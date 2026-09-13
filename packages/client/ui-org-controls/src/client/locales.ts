/** `orgControls` namespace dictionaries: the Stop All and Send All footer controls. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'orgControls'

/** The org-controls dictionary key set (the source of truth for both locales). */
export type OrgControlsKey =
  | 'stopAll.trigger'
  | 'stopAll.trigger.disabledAria'
  | 'stopAll.trigger.disabledReason'
  | 'stopAll.confirm.title'
  | 'stopAll.confirm.description'
  | 'stopAll.confirm.cancel'
  | 'stopAll.confirm.confirm'
  | 'stopAll.result.success'
  | 'stopAll.result.partial'
  | 'stopAll.result.error'
  | 'stopAll.result.dismiss'
  | 'sendAll.trigger'
  | 'sendAll.trigger.disabledAria'
  | 'sendAll.trigger.disabledReason'
  | 'sendAll.compose.title'
  | 'sendAll.compose.description'
  | 'sendAll.compose.placeholder'
  | 'sendAll.compose.cancel'
  | 'sendAll.compose.send'
  | 'sendAll.result.success'
  | 'sendAll.result.partial'
  | 'sendAll.result.error'
  | 'sendAll.result.dismiss'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Stop All / Send All sidebar footer controls' copy. */
    'orgControls': OrgControlsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<OrgControlsKey, string> = {
  'stopAll.trigger': '全部停止',
  'stopAll.trigger.disabledAria': '全部停止（当前没有正在运行的会话）',
  'stopAll.trigger.disabledReason': '当前没有正在运行的会话。',
  'stopAll.confirm.title': '停止全部会话？',
  'stopAll.confirm.description': '这将立即停止全部 {count} 个正在运行的会话（包括它们的子代理）。此操作无法撤销。',
  'stopAll.confirm.cancel': '取消',
  'stopAll.confirm.confirm': '停止全部',
  'stopAll.result.success': '已停止 {count} 个会话。',
  'stopAll.result.partial': '已停止 {count} 个会话，但部分子代理未能停止：{reason}',
  'stopAll.result.error': '全部停止失败：{reason}',
  'stopAll.result.dismiss': '关闭',
  'sendAll.trigger': '全部发送',
  'sendAll.trigger.disabledAria': '全部发送（当前没有可发送的活跃会话）',
  'sendAll.trigger.disabledReason': '当前没有可发送的活跃会话。',
  'sendAll.compose.title': '发送给全部会话',
  'sendAll.compose.description': '此消息将立即发送给全部 {count} 个当前活跃的顶层会话，并中断它们目前正在进行的任何操作。此操作无法撤销。',
  'sendAll.compose.placeholder': '输入要发送给全部会话的消息……',
  'sendAll.compose.cancel': '取消',
  'sendAll.compose.send': '发送给全部',
  'sendAll.result.success': '已发送给 {count} 个会话。',
  'sendAll.result.partial': '已发送给 {count} 个会话，但部分会话未能收到：{reason}',
  'sendAll.result.error': '全部发送失败：{reason}',
  'sendAll.result.dismiss': '关闭',
}

/** English dictionary. */
export const en: Record<OrgControlsKey, string> = {
  'stopAll.trigger': 'Stop All',
  'stopAll.trigger.disabledAria': 'Stop All (no sessions are currently running)',
  'stopAll.trigger.disabledReason': 'No sessions are currently running.',
  'stopAll.confirm.title': 'Stop all sessions?',
  'stopAll.confirm.description': 'This immediately stops {count} running session(s), including their subagents. This cannot be undone.',
  'stopAll.confirm.cancel': 'Cancel',
  'stopAll.confirm.confirm': 'Stop All',
  'stopAll.result.success': 'Stopped {count} session(s).',
  'stopAll.result.partial': 'Stopped {count} session(s), but some subagents failed to stop: {reason}',
  'stopAll.result.error': 'Stop All failed: {reason}',
  'stopAll.result.dismiss': 'Dismiss',
  'sendAll.trigger': 'Send All',
  'sendAll.trigger.disabledAria': 'Send All (no active sessions to send to)',
  'sendAll.trigger.disabledReason': 'No active sessions to send to.',
  'sendAll.compose.title': 'Send to all sessions',
  'sendAll.compose.description': 'This message goes immediately to all {count} active top-level session(s), interrupting whatever any of them are doing right now. This cannot be undone.',
  'sendAll.compose.placeholder': 'Type a message to send to every session…',
  'sendAll.compose.cancel': 'Cancel',
  'sendAll.compose.send': 'Send All',
  'sendAll.result.success': 'Sent to {count} session(s).',
  'sendAll.result.partial': 'Sent to {count} session(s), but some sessions did not receive it: {reason}',
  'sendAll.result.error': 'Send All failed: {reason}',
  'sendAll.result.dismiss': 'Dismiss',
}
