/** Injected faces for the two footer-action entries this package registers. */

import type { PromptContentPart, SendAllResult, StopDescendantsResult } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Live verb for the Stop All control (SWD-130): stops every live top-level
 * session and cascades into its descendant forest through one host call. The
 * component never mutates list state itself — it reads back `descendants` to
 * decide whether to show success or a surfaced partial failure.
 */
export interface StopAllFace {
  // Arrow-typed property, not a method shorthand: destructuring `onStopAll`
  // off this face in the component must not trip `unbound-method` — it holds
  // no `this` to lose.
  onStopAll: () => Promise<RpcResult<{ stoppedCount: number; descendants: StopDescendantsResult }>>
}

/**
 * Live verb for the Send All control (SWD-131): steers every live top-level
 * session with the same content, immediately and mid-turn. The component
 * reads back `result` to decide whether to show success or a surfaced
 * partial failure — never folds a `{ failed }` outcome into a clean message.
 */
export interface SendAllFace {
  // Arrow-typed property, not a method shorthand: same `unbound-method` reason as StopAllFace above.
  onSendAll: (content: PromptContentPart[]) => Promise<RpcResult<{ sentCount: number; result: SendAllResult }>>
}
