/**
 * Config of the `workflow_run` plugin: tool name, the workflows directory, the approval wait cap,
 * the headless and trust stances, the tier-to-model table and run retention.
 * @module @deepseek-ai/dsh-tool-workflow-run/config
 */

import z from '@deepseek-ai/schemastery'
import { checkRelativePath, checkTierTable } from '@deepseek-ai/dsh-workflow-yaml'

/** Trust policy for a workflow file whose content hash has not been trusted yet. */
export type TrustPolicy = 'ask' | 'never'

/** The tier-to-model table applied to `agent()` calls that name a tier. */
export interface TierModels {
  /** Model for `cheap` nodes (default `haiku`). */
  cheap?: string
  /** Model for `standard` nodes (default `sonnet`). */
  standard?: string
  /** Model for `premium` nodes (default `opus`; the workflow must also give a non-empty `justify`). */
  premium?: string
}

/** Config: every key is optional; the schema fills the defaults. */
export interface Config {
  /** The model-facing tool name to register (default `workflow_run`). */
  toolName?: string
  /**
   * Register the model-facing tool (default true). False mounts only the `ctx.workflowRuns` service,
   * which the Workflows UI uses, so a composition can serve the UI without giving every agent the tool.
   */
  exposeTool?: boolean
  /** Workspace-relative directory holding `<name>.yaml` workflow files (default `.workflows`). */
  workflowsDir?: string
  /** How long an approval may wait for an answer before it expires and the node is rejected, in milliseconds (default 3600000). */
  approvalWaitMs?: number
  /** True in headless deployments: every approval node is rejected immediately with a reason and remedy (default false). */
  headless?: boolean
  /** `ask` confirms an untrusted workflow hash before its first run; `never` refuses any untrusted hash (default `ask`). */
  trustPolicy?: TrustPolicy
  /** Tier-to-model table; a model id containing the denied model family fails the plugin at startup. */
  tierModels?: TierModels
  /** Runs kept per workspace before the oldest finished ones are pruned (default 200). */
  retention?: number
  /** Harness home holding the run store; defaults to `$DSH_HOME`, else `~/.dsh`. */
  dshHome?: string
  /** Ceiling of the rendered tool-result text, in characters (default 50000). */
  maxResultChars?: number
}

/** The config after schema defaults: every key but `dshHome` is present. */
export type ResolvedConfig = Required<Omit<Config, 'dshHome' | 'tierModels'>> & {
  dshHome?: string
  tierModels: Required<TierModels>
}

const MAX_APPROVAL_WAIT_MS = 24 * 60 * 60 * 1000

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow_run'),
  exposeTool: z.boolean().default(true),
  workflowsDir: z.string().default('.workflows'),
  approvalWaitMs: z.natural().min(1).max(MAX_APPROVAL_WAIT_MS).default(3_600_000),
  headless: z.boolean().default(false),
  trustPolicy: z.union(['ask', 'never'] as const).default('ask'),
  tierModels: z.object({
    cheap: z.string().default('haiku'),
    standard: z.string().default('sonnet'),
    premium: z.string().default('opus'),
  }),
  retention: z.natural().min(1).default(200),
  dshHome: z.string(),
  maxResultChars: z.natural().min(1).default(50_000),
})

/**
 * Validate the config values the schema cannot express: the workflows directory must be a
 * workspace-relative path and no tier may map to a denied model id.
 * @param config - the schema-resolved config.
 * @throws when a value is unusable; the plugin must not start.
 */
export function assertConfigUsable(config: ResolvedConfig): void {
  const pathProblem = checkRelativePath(config.workflowsDir)
  if (pathProblem !== undefined) throw new Error(`tool-workflow-run: workflowsDir ${pathProblem}`)
  const rejected = checkTierTable({ ...config.tierModels })
  const entries = Object.entries(rejected)
  if (entries.length > 0) {
    throw new Error(`tool-workflow-run: tierModels rejected: ${entries.map(([tier, why]) => `${tier}: ${why}`).join('; ')}`)
  }
}
