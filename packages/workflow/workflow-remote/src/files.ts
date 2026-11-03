/**
 * Workflow file operations behind the Remote service: list, read, validate, and the contained
 * atomic save. Every path is `<workspace>/<workflowsDir>/<name>.yaml` with `name` matching the
 * kebab-case grammar; the directory and the target are realpath-checked to stay inside the
 * workspace, a symlinked target is refused, and a save writes a temp file in the same directory,
 * syncs it, then publishes it by `rename` (replace) or `link` (create), so a crash leaves the old
 * file, no file, or the whole new file.
 * @module @deepseek-ai/dsh-workflow-remote/files
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, link, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import {
  listWorkflowNames, modelFacingError, readWorkflowByName, resolveWorkflowsDir, WORKFLOW_NAME_PATTERN, WorkflowFileError,
} from '@deepseek-ai/dsh-tool-workflow-run'
import { analyze, DEFAULT_MAX_BYTES, layout, sha256Hex } from '@deepseek-ai/dsh-workflow-yaml'
import type { AnalyzeResult, Diagnostic, WorkflowGraph } from '@deepseek-ai/dsh-workflow-yaml'
import { WORKFLOW_LAYOUT } from './wire.ts'
import type {
  WorkflowDiagnostic, WorkflowErrorCode, WorkflowFailure, WorkflowGraphView, WorkflowLastRun, WorkflowLayoutView, WorkflowListEntry,
  WorkflowReadResult, WorkflowSaveRequest, WorkflowSaveResult, WorkflowValidateResult,
} from './wire.ts'

/** Longest workflow name, matching the runner's own limit. */
export const WORKFLOW_NAME_MAX_CHARS = 64

/**
 * Build a failure result.
 * @param error - machine-readable reason.
 * @param message - reader-facing text; must carry no host path or stack.
 * @param extra - remedy, diagnostics, conflict facts.
 * @returns the failure.
 */
export function failure(error: WorkflowErrorCode, message: string, extra: Partial<Omit<WorkflowFailure, 'ok' | 'error' | 'message'>> = {}): WorkflowFailure {
  return { ok: false, error, message, ...extra }
}

/**
 * Check a workflow name.
 * @param name - the caller's name.
 * @returns a failure when the name is not a valid file stem, otherwise undefined.
 */
export function checkName(name: string): WorkflowFailure | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > WORKFLOW_NAME_MAX_CHARS || !WORKFLOW_NAME_PATTERN.test(name)) {
    return failure('INVALID_NAME', 'A workflow name is lowercase words joined by single hyphens, at most 64 characters (for example feature-loop).')
  }
  return undefined
}

/**
 * Copy diagnostics into the wire shape.
 * @param diagnostics - analyzer diagnostics.
 * @returns plain wire diagnostics.
 */
export function wireDiagnostics(diagnostics: readonly Diagnostic[]): WorkflowDiagnostic[] {
  return diagnostics.map(d => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
    line: d.line,
    column: d.column,
    ...d.endLine === undefined ? {} : { endLine: d.endLine },
    ...d.endColumn === undefined ? {} : { endColumn: d.endColumn },
    ...d.nodeId === undefined ? {} : { nodeId: d.nodeId },
    path: [...d.path],
  }))
}

/**
 * Project the analyzer graph into the wire graph.
 * @param graph - graph from `describeGraph` or `analyze`.
 * @returns the wire graph.
 */
export function wireGraph(graph: WorkflowGraph): WorkflowGraphView {
  return {
    nodes: graph.nodes.map(n => ({
      id: n.id,
      kind: n.kind,
      layer: n.layer,
      order: n.order,
      gate: n.gate,
      ...n.when === undefined ? {} : { when: n.when },
      triggerRule: n.triggerRule,
      dependsOn: [...n.dependsOn],
      ...n.tier === undefined ? {} : { tier: n.tier },
      label: n.label,
    })),
    edges: graph.edges.map(e => ({ from: e.from, to: e.to, ...e.when === undefined ? {} : { when: e.when } })),
    layers: graph.layers,
    manifest: graph.manifest.map(m => ({ nodeId: m.nodeId, gateKind: m.gateKind })),
    inputs: graph.inputs.map(i => ({
      name: i.name,
      type: i.type,
      required: i.required,
      ...i.default === undefined ? {} : { default: i.default },
      ...i.description === undefined ? {} : { description: i.description },
    })),
  }
}

/**
 * Lay a graph out with the shared constants.
 * @param graph - the analyzer graph.
 * @returns node positions and the bounding box.
 */
export function wireLayout(graph: WorkflowGraph): WorkflowLayoutView {
  const result = layout(graph, WORKFLOW_LAYOUT)
  return { positions: result.positions, width: result.width, height: result.height }
}

/**
 * Validate draft text without writing anything.
 * @param text - the draft.
 * @param name - the name it will be saved under.
 * @returns diagnostics, and the graph and layout when it parsed.
 */
export function validateText(text: string, name: string | undefined): WorkflowValidateResult {
  if (Buffer.byteLength(text, 'utf8') > DEFAULT_MAX_BYTES) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error', code: 'too-large', line: 1, column: 1, path: [],
        message: `The workflow is larger than ${DEFAULT_MAX_BYTES} bytes.`,
      }],
    }
  }
  const analysis = analyze(text, name === undefined ? {} : { expectedName: name })
  return {
    ok: analysis.ok,
    diagnostics: wireDiagnostics(analysis.diagnostics),
    ...analysis.graph === undefined ? {} : { graph: wireGraph(analysis.graph), layout: wireLayout(analysis.graph) },
    ...analysis.hash === undefined ? {} : { hash: analysis.hash },
  }
}

/**
 * Text for a file problem, free of host paths.
 * @param error - the thrown value.
 * @returns the shown message.
 */
export function fileProblemText(error: WorkflowFileError): string {
  return modelFacingError(error.message)
}

/**
 * Read one workflow with the token a later save presents.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the workflows directory, workspace-relative.
 * @param name - the workflow name.
 * @returns the text and token, or why it could not be read.
 */
export async function readWorkflow(workspace: string, workflowsDir: string, name: string): Promise<WorkflowReadResult> {
  const bad = checkName(name)
  if (bad !== undefined) return bad
  try {
    const file = await readWorkflowByName(workspace, workflowsDir, name)
    return { ok: true, name, text: file.text, token: sha256Hex(file.text) }
  } catch (error: unknown) {
    if (error instanceof WorkflowFileError) return failure('NOT_FOUND', fileProblemText(error))
    throw error
  }
}

/**
 * List the workflows of a workspace with their validation status.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the workflows directory, workspace-relative.
 * @param lastRuns - the most recent run by workflow name.
 * @returns one row per workflow file.
 */
export async function listWorkflows(
  workspace: string,
  workflowsDir: string,
  lastRuns: ReadonlyMap<string, WorkflowLastRun>,
): Promise<WorkflowListEntry[]> {
  const rows: WorkflowListEntry[] = []
  for (const name of await listWorkflowNames(workspace, workflowsDir)) {
    let text: string
    try {
      text = (await readWorkflowByName(workspace, workflowsDir, name)).text
    } catch (error: unknown) {
      if (!(error instanceof WorkflowFileError)) throw error
      rows.push({ name, description: '', nodeCount: 0, hash: '', valid: false, diagnosticCount: 1 })
      continue
    }
    const analysis: AnalyzeResult = analyze(text, { expectedName: name })
    const lastRun = lastRuns.get(name)
    rows.push({
      name,
      description: analysis.doc?.description ?? '',
      nodeCount: analysis.doc?.nodes.length ?? 0,
      hash: sha256Hex(text),
      valid: analysis.ok,
      diagnosticCount: analysis.diagnostics.length,
      ...lastRun === undefined ? {} : { lastRun },
    })
  }
  return rows
}

/** Test seam for the save: runs between the temp file being complete and it being published. */
export interface SaveHooks {
  /** Called after the temp file is synced and closed, before the publishing rename or link. */
  readonly afterTempWritten?: () => void | Promise<void>
  /** Replaces the directory sync after the publish; a throw here must not turn a saved file into an error. */
  readonly syncDirectory?: (dir: string) => void | Promise<void>
}

const locks = new Map<string, Promise<unknown>>()

/** Serialize in-process saves of one target so the token check and the publish cannot interleave. */
async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tail = next.catch(() => undefined)
  locks.set(key, tail)
  try {
    return await next
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/** Resolve the workflows directory, creating its last component when the workspace holds none yet. */
async function ensureWorkflowsDir(workspace: string, workflowsDir: string): Promise<string> {
  const existing = await resolveWorkflowsDir(workspace, workflowsDir)
  if (existing !== undefined) return existing
  const absolute = join(workspace, workflowsDir)
  const parent = await realpath(dirname(absolute))
  if (!isInside(workspace, parent)) throw new WorkflowFileError('the workflows directory would be created outside the workspace')
  try {
    await mkdir(absolute, { mode: 0o755 })
  } catch (error: unknown) {
    if (errno(error) !== 'EEXIST') throw error
  }
  const created = await resolveWorkflowsDir(workspace, workflowsDir)
  if (created === undefined) throw new WorkflowFileError('the workflows directory could not be created')
  return created
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeTemp(dir: string, name: string, text: string, mode: number): Promise<string> {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
  try {
    await handle.chmod(mode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  await handle.close()
  return tmp
}

/**
 * Save a workflow file. Validates server-side and refuses any error diagnostic, so the workflows
 * directory never holds a file the runner cannot load. `expectedToken: null` creates a new file
 * and loses to one that already exists; otherwise the token must equal the sha256 of the current
 * text.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the workflows directory, workspace-relative.
 * @param request - name, text and expected token.
 * @param hooks - test seam between the temp write and the publish.
 * @returns the new token, or why nothing was written.
 */
export async function saveWorkflowFile(
  workspace: string,
  workflowsDir: string,
  request: WorkflowSaveRequest,
  hooks: SaveHooks = {},
): Promise<WorkflowSaveResult> {
  const { name, text, expectedToken } = request
  const bad = checkName(name)
  if (bad !== undefined) return bad
  if (typeof text !== 'string' || text.includes('\0')) return failure('INVALID_INPUT', 'The workflow text must be text without NUL characters.')
  if (Buffer.byteLength(text, 'utf8') > DEFAULT_MAX_BYTES) {
    return failure('TOO_LARGE', `The workflow is larger than ${DEFAULT_MAX_BYTES} bytes.`)
  }
  if (expectedToken !== null && !/^[0-9a-f]{64}$/.test(expectedToken)) {
    return failure('INVALID_INPUT', 'expectedToken must be the token from read or the previous save, or null to create a new file.')
  }
  const analysis = analyze(text, { expectedName: name })
  const errors = analysis.diagnostics.filter(d => d.severity === 'error')
  if (!analysis.ok || errors.length > 0) {
    return failure('DIAGNOSTICS', `The workflow has ${errors.length} error${errors.length === 1 ? '' : 's'} and was not saved.`, {
      diagnostics: wireDiagnostics(analysis.diagnostics),
      remedy: 'Fix the located problems; your draft is still in the editor.',
    })
  }
  let dir: string
  try {
    dir = await ensureWorkflowsDir(workspace, workflowsDir)
  } catch (error: unknown) {
    if (error instanceof WorkflowFileError) return failure('REFUSED', fileProblemText(error))
    throw error
  }
  const target = join(dir, `${name}.yaml`)
  return await withLock(target, async () => {
    const info = await lstat(target).catch((error: unknown) => {
      if (errno(error) === 'ENOENT') return undefined
      throw error
    })
    if (info?.isSymbolicLink() === true) return failure('REFUSED', `The file for '${name}' is a symbolic link, so it was not written.`)
    if (info !== undefined && !info.isFile()) return failure('REFUSED', `The path for '${name}' is not a regular file.`)
    let currentToken: string | undefined
    if (info !== undefined) {
      try {
        currentToken = sha256Hex((await readWorkflowByName(workspace, workflowsDir, name)).text)
      } catch (error: unknown) {
        if (error instanceof WorkflowFileError) return failure('REFUSED', fileProblemText(error))
        throw error
      }
    }
    if (expectedToken === null && currentToken !== undefined) {
      return failure('CONFLICT', `A workflow named '${name}' already exists.`, {
        conflict: true,
        currentToken,
        remedy: 'Reload it, or choose another name.',
      })
    }
    if (expectedToken !== null && currentToken !== expectedToken) {
      return failure('CONFLICT', `The file for '${name}' ${currentToken === undefined ? 'no longer exists' : 'changed since you opened it'}.`, {
        conflict: true,
        ...currentToken === undefined ? {} : { currentToken },
        remedy: 'Reload the file and re-apply your edits.',
      })
    }
    let warning: string | undefined
    const tmp = await writeTemp(dir, name, text, info === undefined ? 0o644 : info.mode & 0o777)
    try {
      await hooks.afterTempWritten?.()
      if (expectedToken === null) {
        try {
          await link(tmp, target)
        } catch (error: unknown) {
          if (errno(error) === 'EEXIST') {
            return failure('CONFLICT', `A workflow named '${name}' already exists.`, { conflict: true, remedy: 'Reload it, or choose another name.' })
          }
          throw error
        }
      } else {
        await rename(tmp, target)
      }
      try {
        await (hooks.syncDirectory ?? syncDirectory)(dir)
      } catch {
        // The file is already published; only its durability across a power cut is unconfirmed.
        warning = 'The workflow was saved, but the folder could not be flushed to disk; it may not survive a power loss.'
      }
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    return {
      ok: true as const,
      token: sha256Hex(text),
      diagnostics: wireDiagnostics(analysis.diagnostics),
      ...warning === undefined ? {} : { warning },
    }
  })
}
