/**
 * Permanently-mounted Typert Remote service for the `workflow` namespace that the Workflows UI
 * talks to. It is its own package, mounted by its own Loader entry, so its Typert registration
 * is keyed to an entry that never unmounts: a package's RPC contract is withdrawn when its last
 * Loader entry unloads and the Gateway never falls back (see `@deepseek-ai/dsh-mcp-status` for
 * the same reasoning). This revision is the package scaffold: `list` answers an empty roster so
 * the Typert generator has a method to emit; discovery, validation, run control, and approvals
 * land in later slices of OP-240.
 * @module @deepseek-ai/dsh-workflow-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { WorkflowListEntry } from './wire.ts'

export type { WorkflowListEntry } from './wire.ts'
export {
  WORKFLOW_LIST_ENDPOINT,
  WORKFLOW_LIST_METHOD,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PRIVILEGED_ENDPOINTS,
} from './wire.ts'

/** Remote-only service publishing the `workflow` namespace; the scaffold revision exposes `list`. */
export class WorkflowRemoteService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'workflowRemote', { namespace: 'workflow' })
  }

  /**
   * List the calling workspace's discovered workflows.
   * @returns no rows in the scaffold revision.
   */
  @Remote('list')
  list(): Promise<WorkflowListEntry[]> {
    return Promise.resolve([])
  }
}

export default WorkflowRemoteService
