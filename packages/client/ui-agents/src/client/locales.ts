/** `agents` namespace dictionaries (view tab label, tree, and row status copy). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'agents'

/** The agents dictionary key set (the source of truth for both locales). */
export type AgentsKey =
  | 'view.agents'
  | 'tree.aria'
  | 'row.aria'
  | 'status.running'
  | 'status.stopped'
  | 'status.interrupted'
  | 'status.error'
  | 'status.completed'
  | 'status.idle'
  | 'empty'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Agents view tab label, tree rows, and status copy. */
    'agents': AgentsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<AgentsKey, string> = {
  'view.agents': '代理',
  'tree.aria': '此会话下的子代理',
  'row.aria': '{name}：{status}',
  'status.running': '运行中',
  'status.stopped': '已停止',
  'status.interrupted': '已中断',
  'status.error': '出错',
  'status.completed': '已完成',
  'status.idle': '空闲',
  'empty': '此会话下没有正在运行的子代理。',
}

/** English dictionary. */
export const en: Record<AgentsKey, string> = {
  'view.agents': 'Agents',
  'tree.aria': "This conversation's subagents",
  'row.aria': '{name}: {status}',
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'status.interrupted': 'Interrupted',
  'status.error': 'Error',
  'status.completed': 'Completed',
  'status.idle': 'Idle',
  'empty': 'No subagents are running under this conversation.',
}
