/** Copy dictionaries for the Tools settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nav: '工具',
  title: '工具',
  intro: '已连接的 MCP 服务器及其授权状态。',
  refresh: '刷新',
  loading: '正在读取工具状态…',
  error: '暂时无法读取工具状态。',
  retry: '重试',
  empty: '未配置任何 MCP 服务器。',
  stateConnected: '已连接',
  stateConnecting: '正在连接',
  stateNeedsAuthorization: '需要授权',
  stateGaveUp: '已放弃（尝试 {attempts} 次后）',
  stateDisabled: '已停用',
  lastError: '最近错误',
  authorize: '授权',
  reconnect: '重新连接',
  enable: '启用',
  disable: '停用',
  disableConfirmTitle: '停用此 MCP 服务器？',
  disableConfirmDescription: '停用后，该服务器提供的工具将不再可用，直到重新启用。',
  disableConfirmAcknowledge: '我了解此操作会移除这些工具。',
  disableConfirmCancel: '取消',
  disableConfirmConfirm: '停用',
  disabling: '正在停用…',
  popupBlocked: '浏览器拦截了授权标签页；请允许此页面弹出窗口后重试。',
} satisfies Record<string, string>

/** Tools settings locale key union. */
export type ToolsLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Tools',
  title: 'Tools',
  intro: 'Connected MCP servers and their authorization status.',
  refresh: 'Refresh',
  loading: 'Reading tool status…',
  error: 'Tool status is temporarily unavailable.',
  retry: 'Retry',
  empty: 'No MCP servers are configured.',
  stateConnected: 'Connected',
  stateConnecting: 'Connecting',
  stateNeedsAuthorization: 'Needs authorization',
  stateGaveUp: 'Gave up after {attempts} attempts',
  stateDisabled: 'Disabled',
  lastError: 'Last error',
  authorize: 'Authorize',
  reconnect: 'Reconnect',
  enable: 'Enable',
  disable: 'Disable',
  disableConfirmTitle: 'Disable this MCP server?',
  disableConfirmDescription: 'Disabling removes the tools it provides until it is enabled again.',
  disableConfirmAcknowledge: 'I understand this removes those tools.',
  disableConfirmCancel: 'Cancel',
  disableConfirmConfirm: 'Disable',
  disabling: 'Disabling…',
  popupBlocked: 'Your browser blocked the authorization tab; allow pop-ups for this page and try again.',
} satisfies Record<ToolsLocaleKey, string>
