/** Open/closed state shared by the header control and the overlay panel. */

/** Minimal external store holding whether the Workflows overlay is open. */
export class WorkflowsOverlayStore {
  private open = false
  private readonly listeners = new Set<() => void>()

  /** Current open state; stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): boolean => this.open

  /** Subscribe to state changes; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Open or close the overlay, notifying subscribers only on a change.
   * @param open - whether the overlay should be open.
   */
  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    for (const listener of [...this.listeners]) listener()
  }
}

/** Injected face shared by the two registered components. */
export interface WorkflowsFace {
  /** The shared open/closed store. */
  overlay: WorkflowsOverlayStore
}
