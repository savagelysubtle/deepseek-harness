/**
 * The model-facing `workflow_run` tool and the `ctx.workflowRuns` service that execute YAML
 * workflow definitions over `ctx.workflowEngine`. This revision is the package scaffold: the
 * plugin mounts and registers nothing yet; the tool, the service, the trust and approval
 * logic, and the session records land in later slices of OP-240.
 * @module @deepseek-ai/dsh-tool-workflow-run
 */

import type { Context } from '@deepseek-ai/cordis'
// Declaration-only: the seams this package will consume once the tool and service land.
import type {} from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-workflow-yaml'
import type {} from '@deepseek-ai/dsh-workflow-run-store'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'tool-workflow-run'
export const inject = ['tools', 'workflowEngine']

/** Plugin body: nothing to register in the scaffold revision. */
export function apply(_ctx: Context): void {}
