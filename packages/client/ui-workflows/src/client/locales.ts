/** `workflows` namespace dictionaries: the Workflows header control and its overlay. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'workflows'

/** The Workflows dictionary key set (the source of truth for both locales). */
export type WorkflowsKey =
  | 'trigger'
  | 'title'
  | 'placeholder'
  | 'close'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Workflows header control and overlay copy. */
    'workflows': WorkflowsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<WorkflowsKey, string> = {
  trigger: '工作流',
  title: '工作流',
  placeholder: '工作流面板即将推出。',
  close: '关闭',
}

/** English dictionary. */
export const en: Record<WorkflowsKey, string> = {
  trigger: 'Workflows',
  title: 'Workflows',
  placeholder: 'The workflows panel is coming soon.',
  close: 'Close',
}
