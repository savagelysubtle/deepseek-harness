/**
 * Package-owned runtime invariant for `@deepseek-ai/dsh-ag-ui`: every frame
 * written to an external socket must be a member of the AG-UI event union AND
 * respect the open-run state — RUN_STARTED only opens a closed run,
 * RUN_FINISHED/RUN_ERROR only close an open one. The companion watches the
 * live frame stream of every server in this process, so a malformed sequence
 * fails loudly at emission instead of reaching clients unnoticed.
 *
 * @module @deepseek-ai/dsh-ag-ui/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { FrameObserver, AgUiServer } from './server.ts'
import { listAgUiServers, onAgUiServer } from './server.ts'
import { AG_UI_EVENT_TYPES } from './translate.ts'
import type { AgUiEvent } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-ag-ui'

/** Cordis companion plugin name. */
export const name = 'ag-ui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The frame-relation check behind the runtime invariant, exposed pure so the
 * rejection of each invalid case is directly provable.
 *
 * @param runOpen - whether the emitting connection currently has an open run bracket.
 * @param frame - the frame about to hit the socket.
 * @returns the violation message, or undefined when the frame is admissible.
 */
export function frameRelationViolation(runOpen: boolean, frame: AgUiEvent): string | undefined {
  if (!AG_UI_EVENT_TYPES.has(frame.type)) {
    return `emitted frame type ${JSON.stringify(frame.type)} is outside the AG-UI event union`
  }
  if (frame.type === 'RUN_STARTED') {
    return runOpen ? 'emitted RUN_STARTED while a run is already open' : undefined
  }
  if ((frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR') && !runOpen) {
    return `emitted ${frame.type} with no open run`
  }
  return undefined
}

/**
 * Validate one emitted frame against its connection's run bracket and report
 * violations through the package-attributed reporter.
 * @param trackers - per-server, per-connection-label run state.
 * @param server - server writing the frame.
 * @param label - connection label the frame was written under.
 * @param frame - the frame about to hit the socket.
 * @param fail - package-attributed failure reporter.
 */
function validateFrame(
  trackers: WeakMap<AgUiServer, Map<string, { runOpen: boolean }>>,
  server: AgUiServer,
  label: string,
  frame: AgUiEvent,
  fail: InvariantFailure,
): void {
  let connections = trackers.get(server)
  if (connections === undefined) {
    connections = new Map()
    trackers.set(server, connections)
  }
  let tracker = connections.get(label)
  if (tracker === undefined) {
    tracker = { runOpen: false }
    connections.set(label, tracker)
  }
  const violation = frameRelationViolation(tracker.runOpen, frame)
  if (violation !== undefined) fail(`connection ${label} ${violation}`)
  if (frame.type === 'RUN_STARTED') tracker.runOpen = true
  if (frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR') tracker.runOpen = false
}

/**
 * Watch every live and future server's frame stream. Subscription disposers
 * ride the registration's child context, so disposing the invariant
 * registration detaches every observer.
 */
const install: InvariantInstaller = (childCtx, fail) => {
  const trackers = new WeakMap<AgUiServer, Map<string, { runOpen: boolean }>>()
  const observe = (server: AgUiServer): FrameObserver =>
    (label, frame) => { validateFrame(trackers, server, label, frame, fail) }
  // Future servers arrive through the creation subscription…
  childCtx.effect(() => onAgUiServer((server) => {
    childCtx.effect(() => server.onFrame(observe(server)), 'ag-ui-invariant.observe')
  }), 'ag-ui-invariant.discover')
  // …and servers alive before this companion installed get their observers now.
  for (const server of listAgUiServers()) {
    childCtx.effect(() => server.onFrame(observe(server)), 'ag-ui-invariant.observe')
  }
}

/* jscpd:ignore-start -- package companions share registration plumbing */
/**
 * Register the ag-ui invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
