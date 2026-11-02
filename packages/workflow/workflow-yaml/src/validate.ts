/**
 * Schema validation of a parsed workflow document into the normalized {@link WorkflowDoc}.
 * Every problem becomes a located {@link Diagnostic}; nothing throws.
 * @module @deepseek-ai/dsh-workflow-yaml/validate
 */

import type { Diagnostic } from './diagnostics.ts'
import { checkEnvName, checkModelId, checkRelativePath } from './checks.ts'
import { Locator } from './locator.ts'
import type { Anchor, Path, Position } from './locator.ts'
import { emitRef, parseWhen, refEnvName, scanTemplate, whenRefs, WhenSyntaxError } from './when.ts'
import type { Ref, TemplatePart } from './when.ts'
import type {
  AgentFields, AnalyzeOptions, ApprovalNode, BashNode, CancelNode, InputSpec, LoopNode, PromptNode, RetrySpec,
  TriggerRule, WorkflowDefaults, WorkflowDoc, WorkflowNode, WorkflowNodeKind, WorkflowTier,
} from './types.ts'

const NODE_ID = /^[a-z0-9_-]{1,64}$/
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const INPUT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const TIERS: readonly WorkflowTier[] = ['cheap', 'standard', 'premium']
const TRIGGER_RULES: readonly TriggerRule[] = ['all_success', 'one_success', 'none_failed_min_one_success', 'all_done']
const KINDS: readonly WorkflowNodeKind[] = ['prompt', 'bash', 'loop', 'approval', 'cancel']
const MAX_NODES = 100

/** Largest agent node timeout and the default approval cap, in milliseconds. */
export const MAX_AGENT_TIMEOUT_MS = 7_200_000
/** Longest a bash node may run. */
export const MAX_BASH_TIMEOUT_MS = 600_000
/** Longest an approval node may wait (and its default). */
export const MAX_APPROVAL_TIMEOUT_MS = 3_600_000
/** Ceiling for `done_when` continuation iterations. */
export const MAX_DONE_WHEN_ITERATIONS = 8
/** Ceiling for loop iterations. */
export const MAX_LOOP_ITERATIONS = 50

const TOP_KEYS = ['version', 'name', 'description', 'when_to_use', 'inputs', 'defaults', 'nodes']
const DEFAULT_KEYS = ['tier', 'timeout_ms', 'idle_timeout_ms', 'retry', 'max_total_agents']
const COMMON_KEYS = ['id', 'kind', 'depends_on', 'when', 'trigger_rule', 'gate', 'retry', 'label', 'phase']
const AGENT_KEYS = ['prompt', 'prompt_file', 'tier', 'model', 'provider', 'output_format', 'timeout_ms', 'idle_timeout_ms',
  'mutates_checkout', 'justify']
const KIND_KEYS: Record<string, string[]> = {
  prompt: [...AGENT_KEYS, 'context', 'done_when', 'max_continuations', 'max_iterations'],
  bash: ['bash', 'workdir', 'timeout_ms', 'env', 'allow_failure', 'inject_failure_to'],
  loop: [...AGENT_KEYS, 'until_bash', 'max_iterations', 'fresh_context', 'workdir', 'env'],
  approval: ['message', 'timeout_ms'],
  cancel: ['reason'],
}
const REJECTED: Record<string, string> = {
  evidence: "'evidence' is not supported in version 1; ask for the command and exit code in the prompt text instead",
  on_error: "'on_error' is not supported: retry only re-runs transient failures (stall, timeout, provider start failure, "
    + "shell timeout); set 'max_attempts' and 'delay_ms' only",
  workflow: "'workflow' is reserved and not yet supported: workflow includes cannot be used in version 1",
  include: "'include' is reserved and not yet supported: workflow includes cannot be used in version 1",
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Locations = Record<string, { line: number; column: number }>

/** The outcome of validation. */
export interface ValidationOutput {
  doc?: WorkflowDoc
  /** Where each node sits in the text. */
  locations: Record<string, { line: number; column: number }>
}

class Validator {
  readonly diags: Diagnostic[] = []
  readonly locations: Record<string, { line: number; column: number }> = Object.create(null) as Locations

  constructor(private readonly loc: Locator, private readonly opts: AnalyzeOptions) {}

  at(path: Path, offset: number, length: number): Position {
    return this.loc.inScalar(path, offset, length)
  }

  diagPosition(path: Path): { line: number; column: number } {
    const { line, column } = this.loc.pos(path, 'value')
    return { line, column }
  }

  err(code: string, message: string, path: Path, anchor: Anchor = 'value', nodeId?: string): void {
    this.diags.push(this.loc.diag('error', code, message, path, anchor, nodeId))
  }

  warn(code: string, message: string, path: Path, anchor: Anchor = 'value', nodeId?: string): void {
    this.diags.push(this.loc.diag('warning', code, message, path, anchor, nodeId))
  }

  /** Check a mapping's keys; returns false when it is not a mapping. */
  map(value: unknown, path: Path, allowed: string[], what: string, nodeId?: string): value is Record<string, unknown> {
    if (!isRecord(value)) {
      this.err('type-error', `${what} must be a mapping`, path, 'value', nodeId)
      return false
    }
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue
      const rejected = REJECTED[key]
      if (rejected !== undefined) this.err('rejected-field', rejected, [...path, key], 'key', nodeId)
      else this.err('unknown-field', `unknown field '${key}' in ${what}`, [...path, key], 'key', nodeId)
    }
    return true
  }

  str(value: unknown, path: Path, what: string, nodeId?: string, max = 100_000): string | undefined {
    if (typeof value !== 'string') {
      this.err('type-error', `${what} must be a string`, path, 'value', nodeId)
      return undefined
    }
    if (value.length > max) {
      this.err('too-long', `${what} is longer than ${max} characters`, path, 'value', nodeId)
      return undefined
    }
    return value
  }

  nonEmpty(value: unknown, path: Path, what: string, nodeId?: string, max?: number): string | undefined {
    const text = this.str(value, path, what, nodeId, max)
    if (text !== undefined && text.trim().length === 0) {
      this.err('empty-value', `${what} must not be empty`, path, 'value', nodeId)
      return undefined
    }
    return text
  }

  int(value: unknown, path: Path, what: string, min: number, max: number, nodeId?: string): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.err('type-error', `${what} must be an integer`, path, 'value', nodeId)
      return undefined
    }
    if (value < min || value > max) {
      this.err('out-of-range', `${what} must be between ${min} and ${max}`, path, 'value', nodeId)
      return undefined
    }
    return value
  }

  bool(value: unknown, path: Path, what: string, nodeId?: string): boolean | undefined {
    if (typeof value !== 'boolean') {
      this.err('type-error', `${what} must be true or false`, path, 'value', nodeId)
      return undefined
    }
    return value
  }

  oneOf<T extends string>(value: unknown, path: Path, what: string, allowed: readonly T[], nodeId?: string): T | undefined {
    const match = allowed.find(candidate => candidate === value)
    if (match === undefined) {
      this.err('invalid-value', `${what} must be one of: ${allowed.join(', ')}`, path, 'value', nodeId)
      return undefined
    }
    return match
  }

  retry(value: unknown, path: Path, nodeId?: string): RetrySpec | undefined {
    if (!this.map(value, path, ['max_attempts', 'delay_ms'], 'retry', nodeId)) return undefined
    const maxAttempts = value.max_attempts === undefined ? 1 : this.int(value.max_attempts, [...path, 'max_attempts'],
      'retry.max_attempts', 1, 5, nodeId)
    const delayMs = value.delay_ms === undefined ? 0 : this.int(value.delay_ms, [...path, 'delay_ms'], 'retry.delay_ms', 0, 600_000, nodeId)
    return { maxAttempts: maxAttempts ?? 1, delayMs: delayMs ?? 0 }
  }

  relPath(value: unknown, path: Path, what: string, nodeId?: string): string | undefined {
    const text = this.str(value, path, what, nodeId, 512)
    if (text === undefined) return undefined
    const reason = checkRelativePath(text)
    if (reason !== undefined) {
      this.err('path-escape', `${what}: ${reason}`, path, 'value', nodeId)
      return undefined
    }
    return text
  }

  envMap(value: unknown, path: Path, nodeId: string): Record<string, string> {
    const out: Record<string, string> = Object.create(null) as Record<string, string>
    if (!isRecord(value)) {
      this.err('type-error', 'env must be a mapping of names to values', path, 'value', nodeId)
      return out
    }
    for (const [name, raw] of Object.entries(value)) {
      const reason = checkEnvName(name)
      if (reason !== undefined) {
        this.err('env-denied', reason, [...path, name], 'key', nodeId)
        continue
      }
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        this.err('type-error', `env value for ${name} must be a string, number, or boolean`, [...path, name], 'value', nodeId)
        continue
      }
      const text = String(raw)
      if (text.includes('\0') || text.length > 4096) {
        this.err('invalid-value', `env value for ${name} must be under 4096 characters with no NUL byte`, [...path, name], 'value', nodeId)
        continue
      }
      out[name] = text
    }
    return out
  }

  model(value: unknown, path: Path, what: string, nodeId: string): string | undefined {
    const text = this.nonEmpty(value, path, what, nodeId, 200)
    if (text === undefined) return undefined
    const reason = checkModelId(text) ?? this.opts.checkModel?.(text, { nodeId })
    if (reason !== undefined) {
      this.err('model-denied', reason, path, 'value', nodeId)
      return undefined
    }
    return text
  }
}

/**
 * Validate a parsed document value into the normalized model.
 * @param root - parsed document value
 * @param loc - position resolver
 * @param opts - analyze options
 * @returns diagnostics, locations, and the normalized document when valid
 */
export function validate(root: unknown, loc: Locator, opts: AnalyzeOptions): { diags: Diagnostic[] } & ValidationOutput {
  const v = new Validator(loc, opts)
  const doc = validateRoot(v, root, opts)
  return { diags: v.diags, locations: v.locations, ...(doc === undefined ? {} : { doc }) }
}

function validateRoot(v: Validator, root: unknown, opts: AnalyzeOptions): WorkflowDoc | undefined {
  if (!v.map(root, [], TOP_KEYS, 'the workflow file')) return undefined

  if (root.version === undefined) v.err('version-missing', "missing required field 'version': add 'version: 1' at the top of the file",
    [], 'value')
  else if (root.version !== 1) v.err('version-unsupported',
    `unsupported version ${JSON.stringify(root.version)}: this build supports 'version: 1' only`, ['version'], 'value')

  let name = ''
  if (root.name === undefined) v.err('missing-field', "missing required field 'name'", [], 'value')
  else {
    const text = v.str(root.name, ['name'], 'name', undefined, 64)
    if (text !== undefined) {
      if (!KEBAB.test(text)) v.err('invalid-value', 'name must be kebab-case (lowercase letters, digits, single hyphens)', ['name'])
      else if (opts.expectedName !== undefined && text !== opts.expectedName) {
        v.err('name-mismatch', `name '${text}' must equal the file name '${opts.expectedName}'`, ['name'])
      } else name = text
    }
  }
  let description = ''
  if (root.description === undefined) v.err('missing-field', "missing required field 'description'", [], 'value')
  else description = v.nonEmpty(root.description, ['description'], 'description', undefined, 1000) ?? ''
  const whenToUse = root.when_to_use === undefined ? undefined : v.nonEmpty(root.when_to_use, ['when_to_use'], 'when_to_use', undefined,
    1000)

  const inputs = root.inputs === undefined ? [] : validateInputs(v, root.inputs)
  const defaults = root.defaults === undefined ? {} : validateDefaults(v, root.defaults)

  if (root.nodes === undefined) {
    v.err('missing-field', "missing required field 'nodes'", [], 'value')
    return undefined
  }
  if (!Array.isArray(root.nodes)) {
    v.err('type-error', 'nodes must be a list', ['nodes'])
    return undefined
  }
  if (root.nodes.length === 0 || root.nodes.length > MAX_NODES) {
    v.err('out-of-range', `nodes must contain between 1 and ${MAX_NODES} entries`, ['nodes'])
    return undefined
  }
  const nodes = validateNodes(v, root.nodes, defaults)
  if (nodes === undefined) return undefined
  validateGraph(v, nodes, inputs)

  if (v.diags.some(d => d.severity === 'error')) return undefined
  return {
    version: 1,
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    inputs,
    defaults,
    nodes,
  }
}

function validateInputs(v: Validator, raw: unknown): InputSpec[] {
  const out: InputSpec[] = []
  if (!isRecord(raw)) {
    v.err('type-error', 'inputs must be a mapping of input names to definitions', ['inputs'])
    return out
  }
  for (const [name, def] of Object.entries(raw)) {
    const path: Path = ['inputs', name]
    if (!INPUT_NAME.test(name)) {
      v.err('invalid-value', 'input names must match [a-z][a-z0-9_]{0,63}', path, 'key')
      continue
    }
    if (!v.map(def, path, ['type', 'required', 'default', 'description'], `input '${name}'`)) continue
    const type = def.type === undefined ? 'string' : v.oneOf(def.type, [...path, 'type'], 'type', ['string', 'number', 'boolean'])
    const required = def.required === undefined ? false : v.bool(def.required, [...path, 'required'], 'required')
    const spec: InputSpec = { name, type: type ?? 'string', required: required ?? false }
    if (def.default !== undefined) {
      if (typeof def.default === spec.type) spec.default = def.default as string | number | boolean
      else v.err('type-error', `default must be a ${spec.type}`, [...path, 'default'])
    }
    if (def.description !== undefined) {
      const text = v.str(def.description, [...path, 'description'], 'description', undefined, 1000)
      if (text !== undefined) spec.description = text
    }
    out.push(spec)
  }
  return out
}

function validateDefaults(v: Validator, raw: unknown): WorkflowDefaults {
  const out: WorkflowDefaults = {}
  if (!v.map(raw, ['defaults'], DEFAULT_KEYS, 'defaults')) return out
  if (raw.tier !== undefined) {
    const tier = v.oneOf(raw.tier, ['defaults', 'tier'], 'tier', TIERS)
    if (tier !== undefined) out.tier = tier
  }
  if (raw.timeout_ms !== undefined) {
    const n = v.int(raw.timeout_ms, ['defaults', 'timeout_ms'], 'timeout_ms', 1000, MAX_AGENT_TIMEOUT_MS)
    if (n !== undefined) out.timeoutMs = n
  }
  if (raw.idle_timeout_ms !== undefined) {
    const n = v.int(raw.idle_timeout_ms, ['defaults', 'idle_timeout_ms'], 'idle_timeout_ms', 1000, MAX_AGENT_TIMEOUT_MS)
    if (n !== undefined) out.idleTimeoutMs = n
  }
  if (raw.retry !== undefined) {
    const retry = v.retry(raw.retry, ['defaults', 'retry'])
    if (retry !== undefined) out.retry = retry
  }
  if (raw.max_total_agents !== undefined) {
    const n = v.int(raw.max_total_agents, ['defaults', 'max_total_agents'], 'max_total_agents', 1, 1000)
    if (n !== undefined) out.maxTotalAgents = n
  }
  return out
}

function validateNodes(v: Validator, raw: unknown[], defaults: WorkflowDefaults): WorkflowNode[] | undefined {
  const nodes: WorkflowNode[] = []
  const seen = new Map<string, number>()
  const state = { usable: true }
  raw.forEach((entry, index) => {
    const path: Path = ['nodes', index]
    if (!isRecord(entry)) {
      v.err('type-error', 'a node must be a mapping', path)
      state.usable = false
      return
    }
    const rawId = entry.id
    let id: string | undefined
    if (rawId === undefined) {
      v.err('missing-field', "node is missing required field 'id'", path)
    } else if (typeof rawId !== 'string' || !NODE_ID.test(rawId)) {
      v.err('node-id-invalid', 'node id must match [a-z0-9_-]{1,64}', [...path, 'id'])
    } else if (rawId === 'inputs') {
      v.err('node-id-invalid', "'inputs' is reserved and cannot be a node id", [...path, 'id'])
    } else if (seen.has(rawId)) {
      v.err('node-id-duplicate', `duplicate node id '${rawId}' (first defined at node ${(seen.get(rawId) ?? 0) + 1})`, [...path, 'id'],
        'value', rawId)
    } else {
      id = rawId
      seen.set(rawId, index)
      v.locations[rawId] = v.diagPosition([...path, 'id'])
    }
    if (id === undefined) state.usable = false
    const kindPath = [...path, 'kind']
    if (entry.kind === undefined) {
      v.err('missing-field', "node is missing required field 'kind'", path, 'value', id)
      state.usable = false
      return
    }
    if (entry.kind === 'workflow') {
      v.err('kind-unsupported', 'workflow nodes are not supported in v1', kindPath, 'value', id)
      state.usable = false
      return
    }
    const kind = v.oneOf(entry.kind, kindPath, 'kind', KINDS, id)
    if (kind === undefined) {
      state.usable = false
      return
    }
    const node = validateNode(v, entry, path, kind, id ?? `#${index + 1}`, defaults)
    if (node === undefined || id === undefined) state.usable = false
    else nodes.push(node)
  })
  return state.usable ? nodes : undefined
}

function validateNode(
  v: Validator, entry: Record<string, unknown>, path: Path, kind: WorkflowNodeKind, id: string, defaults: WorkflowDefaults,
): WorkflowNode | undefined {
  const nodeId = id
  if (!v.map(entry, path, [...COMMON_KEYS, ...(KIND_KEYS[kind] ?? [])], `${kind} node '${id}'`, nodeId)) return undefined

  const dependsOn: string[] = []
  if (entry.depends_on !== undefined) {
    if (!Array.isArray(entry.depends_on)) v.err('type-error', 'depends_on must be a list of node ids', [...path, 'depends_on'], 'value',
      nodeId)
    else {
      entry.depends_on.forEach((dep, i) => {
        if (typeof dep !== 'string') v.err('type-error', 'depends_on entries must be node ids', [...path, 'depends_on', i], 'value', nodeId)
        else if (dependsOn.includes(dep)) v.err('depends-duplicate', `'${dep}' is listed twice in depends_on`, [...path, 'depends_on', i],
          'value', nodeId)
        else dependsOn.push(dep)
      })
    }
  }
  let when: string | undefined
  if (entry.when !== undefined) when = v.nonEmpty(entry.when, [...path, 'when'], 'when', nodeId, 2000)
  const triggerRule: TriggerRule = entry.trigger_rule === undefined
    ? 'all_success'
    : (v.oneOf(entry.trigger_rule, [...path, 'trigger_rule'], 'trigger_rule', TRIGGER_RULES, nodeId) ?? 'all_success')
  const retry = entry.retry === undefined ? undefined : v.retry(entry.retry, [...path, 'retry'], nodeId)
  const label = entry.label === undefined ? undefined : v.nonEmpty(entry.label, [...path, 'label'], 'label', nodeId, 120)
  const phase = entry.phase === undefined ? undefined : v.nonEmpty(entry.phase, [...path, 'phase'], 'phase', nodeId, 80)
  const explicitGate = entry.gate === undefined ? undefined : v.bool(entry.gate, [...path, 'gate'], 'gate', nodeId)

  const inheritedRetry = defaults.retry === undefined || kind === 'cancel' || kind === 'approval' ? {} : { retry: defaults.retry }
  const base = {
    id,
    dependsOn,
    ...when === undefined ? {} : { when },
    triggerRule,
    ...retry === undefined ? inheritedRetry : { retry },
    ...label === undefined ? {} : { label },
    ...phase === undefined ? {} : { phase },
  }

  switch (kind) {
    case 'bash': {
      const bash = entry.bash === undefined ? undefined : v.nonEmpty(entry.bash, [...path, 'bash'], 'bash', nodeId, 20_000)
      if (entry.bash === undefined) v.err('missing-field', "bash node is missing required field 'bash'", path, 'value', nodeId)
      const workdir = entry.workdir === undefined ? undefined : v.relPath(entry.workdir, [...path, 'workdir'], 'workdir', nodeId)
      const timeoutMs = entry.timeout_ms === undefined ? undefined : v.int(entry.timeout_ms, [...path, 'timeout_ms'], 'timeout_ms', 100,
        MAX_BASH_TIMEOUT_MS, nodeId)
      const env = entry.env === undefined ? Object.create(null) as Record<string, string> : v.envMap(entry.env, [...path, 'env'], nodeId)
      const allowFailure = entry.allow_failure === undefined ? false : (v.bool(entry.allow_failure, [...path, 'allow_failure'],
        'allow_failure', nodeId) ?? false)
      if (allowFailure && explicitGate === true) v.err('invalid-value', 'allow_failure: true cannot be combined with gate: true',
        [...path, 'gate'], 'value', nodeId)
      const injectFailureTo = entry.inject_failure_to === undefined ? undefined : v.str(entry.inject_failure_to, [...path,
        'inject_failure_to'], 'inject_failure_to', nodeId, 64)
      const node: BashNode = {
        ...base, kind: 'bash', bash: bash ?? '', env, allowFailure,
        gate: explicitGate ?? !allowFailure,
        ...workdir === undefined ? {} : { workdir },
        ...timeoutMs === undefined ? {} : { timeoutMs },
        ...injectFailureTo === undefined ? {} : { injectFailureTo },
      }
      return node
    }
    case 'approval': {
      const message = entry.message === undefined ? undefined : v.nonEmpty(entry.message, [...path, 'message'], 'message', nodeId, 4000)
      if (entry.message === undefined) v.err('missing-field', "approval node is missing required field 'message'", path, 'value', nodeId)
      const timeoutMs = entry.timeout_ms === undefined ? MAX_APPROVAL_TIMEOUT_MS : (v.int(entry.timeout_ms, [...path, 'timeout_ms'],
        'timeout_ms', 1000, MAX_APPROVAL_TIMEOUT_MS, nodeId) ?? MAX_APPROVAL_TIMEOUT_MS)
      const node: ApprovalNode = { ...base, kind: 'approval', message: message ?? '', timeoutMs, gate: explicitGate ?? true }
      return node
    }
    case 'cancel': {
      const reason = entry.reason === undefined ? undefined : v.nonEmpty(entry.reason, [...path, 'reason'], 'reason', nodeId, 1000)
      if (entry.reason === undefined) v.err('missing-field', "cancel node is missing required field 'reason'", path, 'value', nodeId)
      if (explicitGate !== undefined) v.err('invalid-value', 'gate does not apply to a cancel node', [...path, 'gate'], 'key', nodeId)
      const node: CancelNode = { ...base, kind: 'cancel', reason: reason ?? '', gate: false }
      return node
    }
    case 'prompt':
    case 'loop': {
      const agent = validateAgentFields(v, entry, path, nodeId, defaults, kind)
      if (kind === 'prompt') {
        const doneWhen = entry.done_when === undefined ? undefined : v.nonEmpty(entry.done_when, [...path, 'done_when'], 'done_when',
          nodeId, 20_000)
        let maxIterations = 3
        const alias = ['max_iterations', 'max_continuations'].filter(key => entry[key] !== undefined)
        if (alias.length === 2) v.err('invalid-value', 'max_iterations and max_continuations are aliases: set only one', [...path,
          'max_continuations'], 'key', nodeId)
        else if (alias.length === 1) {
          const key = alias[0] ?? 'max_iterations'
          if (doneWhen === undefined) v.err('invalid-value', `${key} requires done_when`, [...path, key], 'key', nodeId)
          maxIterations = v.int(entry[key], [...path, key], key, 1, MAX_DONE_WHEN_ITERATIONS, nodeId) ?? 3
        }
        if (entry.context !== undefined && entry.context !== 'fresh') {
          v.err('unsupported', "context: only 'fresh' is supported in version 1", [...path, 'context'], 'value', nodeId)
        }
        const node: PromptNode = {
          ...base, ...agent, kind: 'prompt', gate: explicitGate ?? false, maxIterations,
          ...doneWhen === undefined ? {} : { doneWhen },
        }
        return node
      }
      const untilBash = entry.until_bash === undefined ? undefined : v.nonEmpty(entry.until_bash, [...path, 'until_bash'], 'until_bash',
        nodeId, 20_000)
      if (entry.until_bash === undefined) v.err('missing-field', "loop node is missing required field 'until_bash'", path, 'value', nodeId)
      let maxIterations = 1
      if (entry.max_iterations === undefined) v.err('missing-field', "loop node is missing required field 'max_iterations'", path,
        'value', nodeId)
      else maxIterations = v.int(entry.max_iterations, [...path, 'max_iterations'], 'max_iterations', 1, MAX_LOOP_ITERATIONS, nodeId) ?? 1
      if (entry.fresh_context !== undefined && v.bool(entry.fresh_context, [...path, 'fresh_context'], 'fresh_context', nodeId) === false) {
        v.err('unsupported', 'fresh_context: false is not supported in version 1', [...path, 'fresh_context'], 'value', nodeId)
      }
      const workdir = entry.workdir === undefined ? undefined : v.relPath(entry.workdir, [...path, 'workdir'], 'workdir', nodeId)
      const env = entry.env === undefined ? Object.create(null) as Record<string, string> : v.envMap(entry.env, [...path, 'env'], nodeId)
      const node: LoopNode = {
        ...base, ...agent, kind: 'loop', gate: explicitGate ?? true, untilBash: untilBash ?? '', maxIterations, env,
        ...workdir === undefined ? {} : { workdir },
      }
      return node
    }
  }
}

function validateAgentFields(
  v: Validator, entry: Record<string, unknown>, path: Path, nodeId: string, defaults: WorkflowDefaults, kind: string,
): AgentFields {
  const out: Record<string, unknown> = { mutatesCheckout: true }
  const hasPrompt = entry.prompt !== undefined
  const hasFile = entry.prompt_file !== undefined
  if (hasPrompt === hasFile) {
    v.err(hasPrompt ? 'invalid-value' : 'missing-field',
      hasPrompt ? "set only one of 'prompt' and 'prompt_file'" : `${kind} node needs 'prompt' or 'prompt_file'`, hasPrompt ? [...path,
        'prompt_file'] : path, hasPrompt ? 'key' : 'value', nodeId)
  }
  if (hasPrompt) out.prompt = v.nonEmpty(entry.prompt, [...path, 'prompt'], 'prompt', nodeId, 100_000)
  if (hasFile) out.promptFile = v.relPath(entry.prompt_file, [...path, 'prompt_file'], 'prompt_file', nodeId)
  let tier = defaults.tier
  if (entry.tier !== undefined) {
    const parsed = v.oneOf(entry.tier, [...path, 'tier'], 'tier', TIERS, nodeId)
    if (parsed !== undefined) { out.tier = parsed; tier = parsed }
  }
  if (entry.model !== undefined) { const m = v.model(entry.model, [...path, 'model'], 'model', nodeId); if (m !== undefined) out.model = m }
  if (entry.provider !== undefined) { const m = v.model(entry.provider, [...path, 'provider'], 'provider',
    nodeId); if (m !== undefined) out.provider = m }
  if (entry.justify !== undefined) { const j = v.str(entry.justify, [...path, 'justify'], 'justify', nodeId,
    1000); if (j !== undefined) out.justify = j }
  if (tier === 'premium' && (typeof out.justify !== 'string' || out.justify.trim().length === 0)) {
    v.err('justify-required', "tier 'premium' requires a non-empty 'justify' explaining why", entry.tier === undefined ? path : [...path,
      'tier'], 'value', nodeId)
  }
  if (entry.output_format !== undefined) {
    const fmt = entry.output_format
    if (!isRecord(fmt) || fmt.type !== 'object') v.err('invalid-value', "output_format must be a JSON Schema object with 'type: object'",
      [...path, 'output_format'], 'value', nodeId)
    else out.outputFormat = fmt
  }
  if (entry.timeout_ms !== undefined) { const n = v.int(entry.timeout_ms, [...path, 'timeout_ms'], 'timeout_ms', 1000,
    MAX_AGENT_TIMEOUT_MS, nodeId); if (n !== undefined) out.timeoutMs = n }
  if (entry.idle_timeout_ms !== undefined) { const n = v.int(entry.idle_timeout_ms, [...path, 'idle_timeout_ms'], 'idle_timeout_ms', 1000,
    MAX_AGENT_TIMEOUT_MS, nodeId); if (n !== undefined) out.idleTimeoutMs = n }
  if (entry.mutates_checkout !== undefined) { const b = v.bool(entry.mutates_checkout, [...path, 'mutates_checkout'], 'mutates_checkout',
    nodeId); if (b !== undefined) out.mutatesCheckout = b }
  return out as unknown as AgentFields
}

/**
 * Text fields of a node that may contain `$ref` templates, with their YAML keys.
 * @param node - validated node
 * @returns the node fields that may contain references
 */
export function templateFields(node: WorkflowNode): { key: string; text: string; env: boolean }[] {
  switch (node.kind) {
    case 'bash': return [{ key: 'bash', text: node.bash, env: true }]
    case 'approval': return [{ key: 'message', text: node.message, env: false }]
    case 'cancel': return [{ key: 'reason', text: node.reason, env: false }]
    case 'loop': return [
      ...(node.prompt === undefined ? [] : [{ key: 'prompt', text: node.prompt, env: false }]),
      { key: 'until_bash', text: node.untilBash, env: true },
    ]
    case 'prompt': return [
      ...(node.prompt === undefined ? [] : [{ key: 'prompt', text: node.prompt, env: false }]),
      ...(node.doneWhen === undefined ? [] : [{ key: 'done_when', text: node.doneWhen, env: true }]),
    ]
  }
}

/** Warn when a reference sits inside single quotes in shell text, where `${WF_X}` stays literal. */
function warnSingleQuoted(v: Validator, parts: TemplatePart[], path: Path, nodeId: string, key: string): void {
  let single = false
  let double = false
  let offset = 0
  for (const part of parts) {
    if ('ref' in part) {
      if (single) {
        v.diags.push({
          severity: 'warning', code: 'ref-in-single-quotes', nodeId, path,
          message: `${key}: single quotes keep \${WF_...} literal; use double quotes around the reference`,
          ...v.at(path, offset, part.ref.length),
        })
      }
      offset += part.ref.length
      continue
    }
    for (let i = 0; i < part.lit.length; i++) {
      const c = part.lit.charAt(i)
      if (c === '\\' && !single) i += 1
      else if (c === "'" && !double) single = !single
      else if (c === '"' && !single) double = !double
    }
    offset += part.lit.length
  }
}

/** Graph-level checks: references, cycles, ancestors, `when`, templates, lint. */
function validateGraph(v: Validator, nodes: WorkflowNode[], inputs: InputSpec[]): void {
  const byId = new Map(nodes.map((n, i) => [n.id, { node: n, index: i }] as const))
  const baseline = v.diags.length
  nodes.forEach((node, index) => {
    node.dependsOn.forEach((dep, j) => {
      if (dep === node.id) { v.err('self-dependency', `node '${node.id}' depends on itself`, ['nodes', index, 'depends_on', j], 'value',
        node.id) }
      else if (!byId.has(dep)) { v.err('ref-unknown', `depends_on refers to unknown node '${dep}'`, ['nodes', index, 'depends_on', j],
        'value', node.id) }
    })
  })
  if (v.diags.length > baseline) return

  // Cycle detection: iterative DFS colouring; report at the back-edge dependency entry.
  const state = new Map<string, 0 | 1 | 2>()
  const found = { cyclic: false }
  const visit = (id: string, stack: string[]): void => {
    state.set(id, 1)
    const entry = byId.get(id)
    if (entry === undefined) return
    entry.node.dependsOn.forEach((dep, j) => {
      if (found.cyclic) return
      const s = state.get(dep) ?? 0
      if (s === 1) {
        found.cyclic = true
        const cycle = [...stack.slice(stack.indexOf(dep)), id, dep]
        v.err('cycle', `dependency cycle: ${cycle.join(' -> ')}`, ['nodes', entry.index, 'depends_on', j], 'value', id)
      } else if (s === 0) visit(dep, [...stack, id])
    })
    state.set(id, 2)
  }
  for (const node of nodes) if ((state.get(node.id) ?? 0) === 0 && !found.cyclic) visit(node.id, [])
  if (found.cyclic) return

  const ancestors = new Map<string, Set<string>>()
  const ancestorsOf = (id: string): Set<string> => {
    const known = ancestors.get(id)
    if (known !== undefined) return known
    const set = new Set<string>()
    for (const dep of byId.get(id)?.node.dependsOn ?? []) {
      set.add(dep)
      for (const a of ancestorsOf(dep)) set.add(a)
    }
    ancestors.set(id, set)
    return set
  }
  const inputNames = new Set(inputs.map(i => i.name))

  const checkRef = (ref: Ref, node: WorkflowNode, report: (message: string, code: string) => void): void => {
    if (ref.kind === 'input') {
      if (!inputNames.has(ref.id)) report(`$inputs.${ref.id} is not a declared input`, 'ref-unknown')
      return
    }
    if (!byId.has(ref.id)) report(`$${ref.id} refers to unknown node '${ref.id}'`, 'ref-unknown')
    else if (!ancestorsOf(node.id).has(ref.id)) {
      report(`$${ref.id} must come from a node this node depends on (directly or transitively); `
        + `add '${ref.id}' to depends_on`, 'ref-not-ancestor')
    }
  }

  nodes.forEach((node, index) => {
    const path: Path = ['nodes', index]
    if (node.when !== undefined) {
      try {
        for (const ref of whenRefs(parseWhen(node.when))) {
          checkRef(ref, node, (message, code) => {
            v.diags.push({ severity: 'error', code, message: `when: ${message}`, ...v.at([...path, 'when'], ref.offset, ref.length),
              nodeId: node.id, path: [...path, 'when'] })
          })
        }
      } catch (error: unknown) {
        if (!(error instanceof WhenSyntaxError)) throw error
        v.diags.push({ severity: 'error', code: 'when-syntax', message: `when: ${error.message}`, ...v.at([...path, 'when'], error.offset,
          1), nodeId: node.id, path: [...path, 'when'] })
      }
    }
    for (const field of templateFields(node)) {
      const envNames = new Map<string, string>()
      let parts
      try {
        parts = scanTemplate(field.text)
      } catch (error: unknown) {
        if (!(error instanceof WhenSyntaxError)) throw error
        v.diags.push({ severity: 'error', code: 'template-syntax', message: `${field.key}: ${error.message}`, ...v.at([...path,
          field.key], error.offset, 1), nodeId: node.id, path: [...path, field.key] })
        continue
      }
      let offset = 0
      for (const part of parts) {
        if ('lit' in part) { offset += part.lit.length; continue }
        const ref = part.ref
        checkRef(ref, node, (message, code) => {
          v.diags.push({ severity: 'error', code, message: `${field.key}: ${message}`, ...v.at([...path, field.key], offset, ref.length),
            nodeId: node.id, path: [...path, field.key] })
        })
        if (field.env) {
          const envName = refEnvName(ref)
          const key = emitRef(ref)
          const prior = envNames.get(envName)
          if (prior !== undefined && prior !== key) {
            v.diags.push({ severity: 'error', code: 'env-collision',
              message: `${field.key}: two different references map to the same environment variable ${envName}; `
                + 'rename a node or input',
              ...v.at([...path, field.key], offset, ref.length), nodeId: node.id, path: [...path, field.key] })
          }
          envNames.set(envName, key)
        }
        offset += ref.length
      }
      if (field.env) warnSingleQuoted(v, parts, [...path, field.key], node.id, field.key)
    }
    if ((node.kind === 'bash') && node.injectFailureTo !== undefined) {
      const target = byId.get(node.injectFailureTo)
      if (target === undefined || (target.node.kind !== 'prompt' && target.node.kind !== 'loop')) {
        v.err('ref-unknown', 'inject_failure_to must name a prompt or loop node', [...path, 'inject_failure_to'], 'value', node.id)
      } else if (!ancestorsOf(target.node.id).has(node.id)) {
        v.err('ref-not-ancestor', `inject_failure_to target '${target.node.id}' must depend on this node`, [...path, 'inject_failure_to'],
          'value', node.id)
      } else if (target.node.triggerRule !== 'all_done') {
        v.err('inject-trigger-rule',
          `inject_failure_to target '${target.node.id}' must use trigger_rule: all_done, `
            + 'otherwise it is skipped when this node fails',
          [...path, 'inject_failure_to'], 'value', node.id)
      }
    }
  })

  // Lint: a node that may change the checkout needs something downstream that can fail.
  const children = new Map<string, string[]>()
  for (const n of nodes) for (const dep of n.dependsOn) children.set(dep, [...(children.get(dep) ?? []), n.id])
  const isVerifier = (n: WorkflowNode): boolean => n.kind === 'loop' || (n.gate && n.kind !== 'cancel')
  nodes.forEach((node, index) => {
    if (node.kind !== 'prompt' || !node.mutatesCheckout || node.doneWhen !== undefined) return
    const stack = [...(children.get(node.id) ?? [])]
    const seen = new Set<string>()
    let found = false
    while (stack.length > 0 && !found) {
      const id = stack.pop()
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      const next = byId.get(id)?.node
      if (next !== undefined && isVerifier(next)) found = true
      stack.push(...(children.get(id) ?? []))
    }
    if (!found) v.err('no-verify-step',
      `prompt node '${node.id}' may change the checkout but nothing after it verifies the result; `
        + 'add a gating bash/approval node, a done_when, or set mutates_checkout: false',
      ['nodes', index, 'id'], 'value', node.id)
  })
}
