/**
 * `compile()`: turn a validated {@link WorkflowDoc} into the plain-JS script body the existing
 * worker-thread workflow engine runs, plus its `meta` and gate manifest.
 *
 * Safety properties of the emitted script:
 * - User text (prompts, commands, messages, `when` expressions) only ever appears as a
 *   `JSON.stringify` string literal; the only code in the script is fixed text from this file
 *   plus operator tokens and calls to the prelude helpers.
 * - Node outputs reach `bash` through environment variables named `WF_*`, never spliced into the
 *   command text; the command refers to them as `${WF_X}`.
 * - Node ids and input names are only ever string keys of null-prototype maps.
 *
 * @module @deepseek-ai/dsh-workflow-yaml/compile
 */

import { checkModelId } from './checks.ts'
import { buildManifest, describeGraph } from './graph.ts'
import { emitRef, emitWhen, parseWhen, refEnvName, scanTemplate } from './when.ts'
import type { Ref } from './when.ts'
import type { ApprovalNode, BashNode, LoopNode, ManifestEntry, PromptNode, WorkflowDoc, WorkflowNode } from './types.ts'

/** The `meta` block the engine validates before the script runs. */
export interface CompiledMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string }[]
}

/** What {@link compile} returns. */
export interface CompiledWorkflow {
  meta: CompiledMeta
  /** Plain-JS script body (top-level await; ends with `return`). */
  script: string
  manifest: ManifestEntry[]
  /** Workspace-relative prompt files the script text already embeds (hash these bytes too). */
  promptFiles: string[]
  /** `defaults.max_total_agents`, for `WorkflowStartRequest.maxTotalAgents`. */
  maxTotalAgents?: number
}

/** Options for {@link compile}. */
export interface CompileOptions {
  /** Contents of every `prompt_file`, keyed by the path as written. The caller reads them safely. */
  promptFiles?: Record<string, string>
}

/** Thrown when a validated document still cannot compile (a missing or invalid prompt file). */
export class WorkflowCompileError extends Error {}

/**
 * The hook vocabulary the compiled script calls and the options it passes, for the engine
 * allowlist (`workflow-worker-thread`). Hooks are globals in the script realm.
 */
export const COMPILED_SCRIPT_CONTRACT = {
  hooks: ['agent', 'bash', 'approve', 'cancel', 'nodeStart', 'nodeEnd', 'gate', 'parallel', 'log'],
  agentOptions: ['nodeId', 'label', 'phase', 'schema', 'provider', 'model', 'tier', 'timeoutMs', 'idleTimeoutMs', 'retry'],
  bashOptions: ['nodeId', 'workdir', 'timeoutMs', 'env', 'retry'],
  approveRequest: ['nodeId', 'message', 'timeoutMs'],
  nodeStatuses: ['success', 'failed', 'skipped', 'cancelled'],
  gateOutcomes: ['fired-pass', 'fired-block', 'skipped'],
} as const

const AGENT_DEFAULT_TIMEOUT_MS = 1_800_000
const AGENT_DEFAULT_IDLE_MS = 300_000
const BASH_DEFAULT_TIMEOUT_MS = 120_000

const j = (value: unknown): string => JSON.stringify(value)

const PRELUDE = String.raw`
const $ = Object.create(null);
const inputs = Object.create(null);
const INJ = Object.create(null);
const RUN = Object.create(null);
const TAIL = 8192;
const ENVCAP = 32768;
const S = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const tail = (v) => { const s = S(v); return s.length > TAIL ? s.slice(s.length - TAIL) : s; };
const msg = (e) => S(e && e.message !== undefined ? e.message : e);
const envVal = (v) => {
  const s = S(v);
  if (s.indexOf('\u0000') !== -1) throw new Error('output contained a NUL byte');
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    const low = s.charCodeAt(i - 1);
    const pair = low >= 0xDC00 && low <= 0xDFFF && i >= 2 && s.charCodeAt(i - 2) >= 0xD800 && s.charCodeAt(i - 2) <= 0xDBFF;
    const cp = pair ? s.codePointAt(i - 2) : low;
    const width = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + width > ENVCAP) break;
    bytes += width;
    i -= pair ? 2 : 1;
  }
  return s.slice(i);
};
const dat = (label, v) => '<workflow-data ref="' + label + '">\n' + S(v) + '\n</workflow-data>';
const field = (v, name) => {
  let cur = v;
  if (typeof cur === 'string') { try { cur = JSON.parse(cur); } catch (e) { return undefined; } }
  return cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, name) ? cur[name] : undefined;
};
const R = (id, prop, path) => {
  const n = $[id];
  if (n === undefined) return undefined;
  if (prop === 'status') return n.status;
  if (prop === 'exit_code') return n.exitCode;
  let v = n.output;
  for (const seg of path) { v = field(v, seg); if (v === undefined) return undefined; }
  return v;
};
const I = (name) => inputs[name];
const T = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
const num = (v) => (typeof v === 'number' ? v
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const C = (op, a, b) => {
  if (a === undefined || b === undefined || a === null || b === null) return false;
  const x = num(a); const y = num(b);
  const both = x !== undefined && y !== undefined;
  const l = both ? x : S(a); const r = both ? y : S(b);
  switch (op) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '>': return l > r;
    case '<=': return l <= r;
    default: return l >= r;
  }
};
const trig = (rule, deps) => {
  const s = deps.map((d) => $[d].status);
  if (s.length === 0 || rule === 'all_done') return true;
  if (rule === 'one_success') return s.some((x) => x === 'success');
  if (rule === 'none_failed_min_one_success') return s.every((x) => x !== 'failed' && x !== 'cancelled') && s.some((x) => x === 'success');
  return s.every((x) => x === 'success');
};
const exec = async (id, kind, deps, rule, cond, gates, body) => {
  let go = trig(rule, deps);
  if (go && cond !== null) go = cond();
  nodeStart(id, kind);
  let res;
  if (!go) {
    for (const g of gates) gate(id, g, 'skipped');
    res = { status: 'skipped', output: '', exitCode: undefined };
  } else {
    try { res = await body(); }
    catch (e) { nodeEnd(id, { status: kind === 'cancel' ? 'cancelled' : 'failed', error: msg(e) }); throw e; }
  }
  nodeEnd(id, Object.assign({ status: res.status, output: tail(res.output) },
    res.exitCode === undefined ? {} : { exitCode: res.exitCode }, res.error === undefined ? {} : { error: res.error }));
  return res;
};
const sh = async (id, command, o) => {
  if (command.indexOf('\u0000') !== -1) throw new Error('output contained a NUL byte');
  const r = (await bash(command, Object.assign({ nodeId: id }, o))) || {};
  const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
  const out = S(r.stdout);
  const evidence = 'command: ' + command + '\nexit code: ' + S(r.exitCode) + (r.timedOut ? ' (timed out)' : '')
    + '\n' + tail(out + S(r.stderr));
  return { ok, exitCode: r.exitCode, text: out, evidence };
};
const iterate = async (id, base, opts, check, maxIter, gateKind) => {
  let extra = INJ[id] === undefined ? '' : '\n\n' + dat('failure-from-previous-step', INJ[id]);
  let text = null;
  let last;
  for (let i = 1; i <= maxIter; i++) {
    text = await agent(base + extra, opts);
    if (text === null) return { status: 'failed', output: '', error: 'the agent did not complete' };
    if (check === null) return { status: 'success', output: text };
    last = await check();
    if (last.ok) { if (gateKind !== null) gate(id, gateKind, 'fired-pass'); return { status: 'success', output: text,
      exitCode: last.exitCode }; }
    extra = '\n\n' + dat('check-failed-on-previous-attempt', last.evidence) + '\n\nFix the problem above, then finish.';
  }
  if (gateKind !== null) gate(id, gateKind, 'fired-block');
  return { status: 'failed', output: text, exitCode: last.exitCode,
    error: 'the check still failed after ' + maxIter + ' attempts: ' + tail(last.evidence) };
};
{
  const given = typeof args === 'object' && args !== null ? args : {};
  for (const s of INPUT_SPECS) {
    let val = Object.prototype.hasOwnProperty.call(given, s.n) ? given[s.n] : undefined;
    if (val === undefined || val === null || val === '') {
      if (s.d !== undefined) val = s.d;
      else if (s.r) throw new Error('missing required input: ' + s.n);
      else continue;
    }
    if (s.t === 'number') {
      const n = typeof val === 'number' ? val : Number(val);
      if (!Number.isFinite(n)) throw new Error('input ' + s.n + ' must be a number');
      val = n;
    } else if (s.t === 'boolean') {
      if (val === 'true') val = true; else if (val === 'false') val = false;
      if (typeof val !== 'boolean') throw new Error('input ' + s.n + ' must be true or false');
    }
    else if (typeof val !== 'string') throw new Error('input ' + s.n + ' must be a string');
    inputs[s.n] = val;
  }
}
`

type Mode = 'data' | 'env'

class Emitter {
  private readonly ancestors = new Map<string, Set<string>>()
  private readonly byId: Map<string, WorkflowNode>
  private readonly inputNames: Set<string>

  constructor(private readonly doc: WorkflowDoc, private readonly files: Record<string, string>) {
    this.byId = new Map(doc.nodes.map(n => [n.id, n] as const))
    this.inputNames = new Set(doc.inputs.map(i => i.name))
  }

  private ancestorsOf(id: string): Set<string> {
    const known = this.ancestors.get(id)
    if (known !== undefined) return known
    const set = new Set<string>()
    for (const dep of this.byId.get(id)?.dependsOn ?? []) {
      set.add(dep)
      for (const a of this.ancestorsOf(dep)) set.add(a)
    }
    this.ancestors.set(id, set)
    return set
  }

  private checkRef(ref: Ref, nodeId: string, where: string): void {
    if (ref.kind === 'input') {
      if (!this.inputNames.has(ref.id)) throw new WorkflowCompileError(`${where}: $inputs.${ref.id} is not a declared input`)
    } else if (!this.ancestorsOf(nodeId).has(ref.id)) {
      throw new WorkflowCompileError(`${where}: $${ref.id} is not an ancestor of '${nodeId}'`)
    }
  }

  /** A JS string expression for `text`. In `env` mode refs become `${WF_X}` and are collected. */
  template(text: string, nodeId: string, mode: Mode, where: string, env?: Map<string, string>): string {
    const pieces: string[] = []
    let literal = ''
    const flush = (): void => { if (literal.length > 0) { pieces.push(j(literal)); literal = '' } }
    for (const part of scanTemplate(text)) {
      if ('lit' in part) { literal += part.lit; continue }
      const ref = part.ref
      this.checkRef(ref, nodeId, where)
      if (mode === 'env') {
        const name = refEnvName(ref)
        env?.set(name, emitRef(ref))
        literal += '${' + name + '}'
      } else {
        flush()
        const text = this.source(ref)
        pieces.push(ref.kind === 'output' ? `dat(${j(`${ref.id}.output${ref.path.map(p => `.${p}`).join('')}`)},${text})` : `S(${text})`)
      }
    }
    flush()
    return pieces.length === 0 ? '""' : pieces.join('+')
  }

  private source(ref: Ref): string {
    return emitRef(ref)
  }

  private promptExpr(node: PromptNode | LoopNode): string {
    if (node.prompt !== undefined) return this.template(node.prompt, node.id, 'data', `node '${node.id}' prompt`)
    const path = node.promptFile ?? ''
    const text = this.files[path]
    if (text === undefined) throw new WorkflowCompileError(`prompt_file '${path}' (node '${node.id}') was not provided to compile()`)
    return this.template(text, node.id, 'data', `prompt_file '${path}'`)
  }

  private commandParts(command: string, nodeId: string, where: string, fixed: Record<string, string>): { cmd: string; env: string } {
    const env = new Map<string, string>()
    const cmd = this.template(command, nodeId, 'env', where, env)
    const dynamic = [...env.entries()].map(([name, expr]) => `${j(name)}: envVal(${expr})`)
    return { cmd, env: `Object.assign({}, ${j(fixed)}, {${dynamic.join(', ')}})` }
  }

  private agentOpts(node: PromptNode | LoopNode): string {
    const d = this.doc.defaults
    for (const value of [node.model, node.provider]) {
      const denied = value === undefined ? undefined : checkModelId(value)
      if (denied !== undefined) throw new WorkflowCompileError(`node '${node.id}': ${denied}`)
    }
    const retry = node.retry
    const tier = node.tier ?? d.tier ?? 'standard'
    return j({
      nodeId: node.id,
      label: node.label ?? node.id,
      ...node.phase === undefined ? {} : { phase: node.phase },
      ...node.outputFormat === undefined ? {} : { schema: node.outputFormat },
      ...node.provider === undefined ? {} : { provider: node.provider },
      ...node.model === undefined ? { tier } : { model: node.model },
      timeoutMs: node.timeoutMs ?? d.timeoutMs ?? AGENT_DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: node.idleTimeoutMs ?? d.idleTimeoutMs ?? AGENT_DEFAULT_IDLE_MS,
      ...retry === undefined ? {} : { retry },
    })
  }

  private shOpts(
    node: { id: string; retry?: { maxAttempts: number; delayMs: number } },
    env: string,
    workdir: string | undefined,
    timeoutMs: number | undefined,
  ): string {
    const retry = node.retry === undefined ? '' : `, retry: ${j(node.retry)}`
    const dir = workdir === undefined ? '' : `, workdir: ${j(workdir)}`
    const limit = timeoutMs === undefined ? '' : `, timeoutMs: ${j(timeoutMs)}`
    return `{ env: ${env}${dir}${limit}${retry} }`
  }

  body(node: WorkflowNode): string {
    switch (node.kind) {
      case 'bash': return this.bashBody(node)
      case 'approval': return this.approvalBody(node)
      case 'cancel':
        return `async () => { cancel(${this.template(node.reason, node.id, 'data', `node '${node.id}' reason`)}); `
          + 'return { status: \'cancelled\', output: \'\' }; }'
      case 'prompt': return this.promptBody(node)
      case 'loop': return this.loopBody(node)
    }
  }

  private bashBody(node: BashNode): string {
    const { cmd, env } = this.commandParts(node.bash, node.id, `node '${node.id}' bash`, node.env)
    const opts = this.shOpts(node, env, node.workdir, node.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS)
    const inject = node.injectFailureTo === undefined ? '' : `if (!r.ok) INJ[${j(node.injectFailureTo)}] = r.evidence; `
    const gate = node.gate ? `gate(${j(node.id)}, 'bash', r.ok ? 'fired-pass' : 'fired-block'); ` : ''
    const soft = j(node.allowFailure)
    return `async () => { const r = await sh(${j(node.id)}, ${cmd}, ${opts}); ${inject}${gate}`
      + `return { status: r.ok || ${soft} ? 'success' : 'failed', output: r.text.trim(), exitCode: r.exitCode, `
      + `...(r.ok || ${soft} ? {} : { error: r.evidence }) }; }`
  }

  private approvalBody(node: ApprovalNode): string {
    const gate = node.gate ? `gate(${j(node.id)}, 'approval', ok ? 'fired-pass' : 'fired-block'); ` : ''
    const message = this.template(node.message, node.id, 'data', `node '${node.id}' message`)
    return `async () => { const v = await approve({ nodeId: ${j(node.id)}, message: ${message}, timeoutMs: ${j(node.timeoutMs)} }); `
      + `const ok = v === 'allowed-once'; ${gate}`
      + 'return { status: ok ? \'success\' : \'failed\', output: S(v), ...(ok ? {} : { error: \'approval \' + S(v) }) }; }'
  }

  private promptBody(node: PromptNode): string {
    const opts = this.agentOpts(node)
    let check = 'null'
    if (node.doneWhen !== undefined) {
      const { cmd, env } = this.commandParts(node.doneWhen, node.id, `node '${node.id}' done_when`, {})
      check = `() => sh(${j(node.id)}, ${cmd}, ${this.shOpts({ id: node.id }, env, undefined, BASH_DEFAULT_TIMEOUT_MS)})`
    }
    const gate = node.gate ? `gate(${j(node.id)}, 'verifier', res.status === 'success' ? 'fired-pass' : 'fired-block'); ` : ''
    const doneWhen = node.doneWhen === undefined ? 'null' : "'done_when'"
    const limit = node.doneWhen === undefined ? 1 : node.maxIterations
    return `async () => { const res = await iterate(${j(node.id)}, ${this.promptExpr(node)}, ${opts}, ${check}, ${limit}, ${doneWhen}); `
      + `${gate}return res; }`
  }

  private loopBody(node: LoopNode): string {
    const { cmd, env } = this.commandParts(node.untilBash, node.id, `node '${node.id}' until_bash`, node.env)
    const check = `() => sh(${j(node.id)}, ${cmd}, ${this.shOpts(node, env, node.workdir, BASH_DEFAULT_TIMEOUT_MS)})`
    const kind = node.gate ? "'until_bash'" : 'null'
    return `async () => iterate(${j(node.id)}, ${this.promptExpr(node)}, ${this.agentOpts(node)}, ${check}, `
      + `${node.maxIterations}, ${kind})`
  }

  when(node: WorkflowNode): string {
    return node.when === undefined ? 'null' : `() => ${emitWhen(parseWhen(node.when))}`
  }
}

function gateKindsOf(manifest: ManifestEntry[], id: string): string[] {
  return manifest.filter(m => m.nodeId === id).map(m => m.gateKind)
}

/**
 * Compile a document (the `doc` from a successful {@link analyze}) to a script, `meta`, and gate
 * manifest. Deterministic: the same document and prompt files always produce the same text.
 * @throws WorkflowCompileError when a `prompt_file` was not supplied or a template cannot resolve
 * @param doc - validated document from analyze()
 * @param options - prompt file contents supplied by the caller
 * @returns the script, meta, manifest, and prompt file list
 */
export function compile(doc: WorkflowDoc, options: CompileOptions = {}): CompiledWorkflow {
  const manifest = buildManifest(doc)
  const graph = describeGraph(doc)
  const emitter = new Emitter(doc, options.promptFiles ?? {})
  const layers: string[][] = Array.from({ length: graph.layers }, () => [])
  for (const node of graph.nodes) layers[node.layer]?.push(node.id)

  const lines: string[] = []
  const specs = doc.inputs.map(i => ({ n: i.name, t: i.type, r: i.required, ...i.default === undefined ? {} : { d: i.default } }))
  lines.push(`const INPUT_SPECS = ${j(specs)};`)
  lines.push(PRELUDE.trim())
  for (const node of doc.nodes) {
    const gates = gateKindsOf(manifest, node.id)
    lines.push(`RUN[${j(node.id)}] = () => exec(${j(node.id)}, ${j(node.kind)}, ${j(node.dependsOn)}, ${j(node.triggerRule)}, `
      + `${emitter.when(node)}, ${j(gates)}, ${emitter.body(node)});`)
  }
  lines.push(`const LAYERS = ${j(layers)};`)
  lines.push(String.raw`for (const layer of LAYERS) {
  const results = await parallel(layer.map((id) => () => RUN[id]()));
  layer.forEach((id, i) => { $[id] = results[i] === null || results[i] === undefined ? { status: 'failed', output: '',
    exitCode: undefined } : results[i]; });
}
const nodes = LAYERS.flat().map((id) => ({ id, status: $[id].status, exitCode: $[id].exitCode === undefined ? null : $[id].exitCode,
  output: tail($[id].output) }));
return { status: nodes.some((n) => n.status === 'failed') ? 'failed' : 'completed', nodes };`)

  const promptFiles = [...new Set(doc.nodes.flatMap(n =>
    ((n.kind === 'prompt' || n.kind === 'loop') && n.promptFile !== undefined ? [n.promptFile] : [])))]
  const phases = [...new Set(doc.nodes.flatMap(n => (n.phase === undefined ? [] : [n.phase])))]
  return {
    meta: {
      name: doc.name,
      description: doc.description,
      ...doc.whenToUse === undefined ? {} : { whenToUse: doc.whenToUse },
      ...phases.length === 0 ? {} : { phases: phases.map(title => ({ title })) },
    },
    script: lines.join('\n') + '\n',
    manifest,
    promptFiles,
    ...doc.defaults.maxTotalAgents === undefined ? {} : { maxTotalAgents: doc.defaults.maxTotalAgents },
  }
}
