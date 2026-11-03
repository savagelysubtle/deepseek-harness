/** Open/closed state shared by the header control and the overlay panel. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowRunTranslate, WorkflowRunViewContract } from '@deepseek-ai/dsh-client-ui-workflow-run/client'
import type { WorkflowApi } from './api.ts'
import type { WorkflowEventSource } from './controller.ts'

/** What the overlay renders from: whether it is open and which session opened it. */
export interface OverlayState {
  readonly open: boolean
  /** The session whose workspace the surface works on; null while closed. */
  readonly sessionId: SessionId | null
}

const CLOSED: OverlayState = { open: false, sessionId: null }

/** Minimal external store holding whether the Workflows overlay is open, and for which session. */
export class WorkflowsOverlayStore {
  private state: OverlayState = CLOSED
  private readonly listeners = new Set<() => void>()

  /** Current state; stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): OverlayState => this.state

  /** Subscribe to state changes; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Open the overlay for a session.
   * @param sessionId - the session whose header button was pressed.
   */
  open(sessionId: SessionId): void {
    this.replace({ open: true, sessionId })
  }

  /** Close the overlay. */
  close(): void {
    this.replace(CLOSED)
  }

  private replace(next: OverlayState): void {
    if (this.state.open === next.open && this.state.sessionId === next.sessionId) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** Injected face shared by the two registered components. */
export interface WorkflowsFace {
  /** The shared open/closed store. */
  overlay: WorkflowsOverlayStore
  /** Bind the Remote namespace to a session. */
  createApi: (sessionId: SessionId) => WorkflowApi
  /** The `workflowRun` namespace translate function the embedded run components take. */
  runT: WorkflowRunTranslate
  /** The reusable run components from `ui-workflow-run` (`ctx.workflowRunView`). */
  runView: WorkflowRunViewContract
  /** The pushed `workflow/*` events. */
  events: WorkflowEventSource
}
