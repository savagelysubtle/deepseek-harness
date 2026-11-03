/**
 * Workflow file discovery and safe reads. Every path is resolved through `realpath` and must stay
 * under the workspace; names follow the kebab-case grammar; reads are size-capped.
 * @module @deepseek-ai/dsh-tool-workflow-run/discover
 */

import { constants } from 'node:fs'
import { open, readdir, readlink, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, basename } from 'node:path'
import { checkRelativePath, DEFAULT_MAX_BYTES } from '@deepseek-ai/dsh-workflow-yaml'

/** A workflow file name (without extension): lowercase words joined by single hyphens. */
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Largest `prompt_file` a workflow may pull in, in bytes. */
export const MAX_PROMPT_FILE_BYTES = 64 * 1024

/** Thrown for any discovery or read problem; the message is safe to show the model. */
export class WorkflowFileError extends Error {}

/** One workflow file read from disk. */
export interface WorkflowSourceFile {
  /** The workflow name (file basename without `.yaml`). */
  readonly name: string
  /** The realpath of the file. */
  readonly path: string
  /** The exact file text. */
  readonly text: string
}

/** True when `target` is `root` or inside it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve the workflows directory under a workspace, refusing symlink escapes.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the configured workspace-relative directory.
 * @returns the directory realpath, or undefined when it does not exist.
 */
export async function resolveWorkflowsDir(workspace: string, workflowsDir: string): Promise<string | undefined> {
  const problem = checkRelativePath(workflowsDir)
  if (problem !== undefined) throw new WorkflowFileError(`workflows directory ${problem}`)
  let dir: string
  try {
    dir = await realpath(join(workspace, workflowsDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!isInside(workspace, dir)) throw new WorkflowFileError(`workflows directory '${workflowsDir}' resolves outside the workspace`)
  return dir
}

/**
 * List the workflow names present in the workflows directory.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the configured workspace-relative directory.
 * @returns the sorted names of the regular `<name>.yaml` files with a valid name.
 */
export async function listWorkflowNames(workspace: string, workflowsDir: string): Promise<string[]> {
  const dir = await resolveWorkflowsDir(workspace, workflowsDir)
  if (dir === undefined) return []
  const names: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
    const name = entry.name.slice(0, -'.yaml'.length)
    if (WORKFLOW_NAME_PATTERN.test(name)) names.push(name)
  }
  return names.sort()
}

/**
 * Read a regular file under `root` exactly once: resolve and contain the path, then open it without
 * following a final symlink and check and read through that one descriptor, so a swap after the
 * check cannot change what is read.
 */
async function readContained(root: string, file: string, maxBytes: number, label: string): Promise<{ path: string; text: string }> {
  let real: string
  try {
    real = await realpath(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowFileError(`${label} does not exist`)
    throw error
  }
  if (!isInside(root, real)) throw new WorkflowFileError(`${label} resolves outside ${basename(root) || 'the allowed directory'}`)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOENT') throw new WorkflowFileError(`${label} changed while it was being read`)
    throw error
  }
  try {
    // O_NOFOLLOW guards only the last component: re-check where the descriptor really points.
    let opened: string
    try {
      opened = await readlink(`/proc/self/fd/${handle.fd}`)
    } catch {
      opened = await realpath(file)
    }
    if (!isInside(root, opened)) throw new WorkflowFileError(`${label} changed while it was being read`)
    const info = await handle.stat()
    if (!info.isFile()) throw new WorkflowFileError(`${label} is not a regular file`)
    if (info.size > maxBytes) throw new WorkflowFileError(`${label} is larger than ${maxBytes} bytes`)
    const bytes = await handle.readFile()
    if (bytes.length > maxBytes) throw new WorkflowFileError(`${label} is larger than ${maxBytes} bytes`)
    return { path: real, text: bytes.toString('utf8') }
  } finally {
    await handle.close()
  }
}

/**
 * Read one workflow by name.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the configured workspace-relative directory.
 * @param name - the workflow name (kebab-case, no extension).
 * @returns the file.
 * @throws {WorkflowFileError} for a bad name, a missing file, an escape or an oversize file.
 */
export async function readWorkflowByName(workspace: string, workflowsDir: string, name: string): Promise<WorkflowSourceFile> {
  if (!WORKFLOW_NAME_PATTERN.test(name) || name.length > 64) {
    throw new WorkflowFileError(`workflow name '${name.slice(0, 80)}' is invalid: use lowercase words joined by hyphens (for example 'feature-loop')`)
  }
  const dir = await resolveWorkflowsDir(workspace, workflowsDir)
  if (dir === undefined) throw new WorkflowFileError(`no workflow named '${name}': the directory '${workflowsDir}' does not exist in this workspace`)
  const read = await readContained(dir, join(dir, `${name}.yaml`), DEFAULT_MAX_BYTES + 1, `workflow '${name}'`)
  return { name, path: read.path, text: read.text }
}

/**
 * Read one workflow by a workspace-relative path that must name a `<name>.yaml` file inside the
 * workflows directory.
 * @param workspace - the workspace realpath.
 * @param workflowsDir - the configured workspace-relative directory.
 * @param path - the workspace-relative path the model gave.
 * @returns the file.
 * @throws {WorkflowFileError} when the path is not a workflow file under the workflows directory.
 */
export async function readWorkflowByPath(workspace: string, workflowsDir: string, path: string): Promise<WorkflowSourceFile> {
  const problem = checkRelativePath(path)
  if (problem !== undefined) throw new WorkflowFileError(`workflow path ${problem}`)
  const dir = await resolveWorkflowsDir(workspace, workflowsDir)
  if (dir === undefined) throw new WorkflowFileError(`the directory '${workflowsDir}' does not exist in this workspace`)
  const base = basename(path)
  const name = base.endsWith('.yaml') ? base.slice(0, -'.yaml'.length) : ''
  if (!WORKFLOW_NAME_PATTERN.test(name)) throw new WorkflowFileError(`workflow path '${path.slice(0, 200)}' must name a <name>.yaml file`)
  const read = await readContained(dir, join(workspace, path), DEFAULT_MAX_BYTES + 1, `workflow '${name}'`)
  return { name, path: read.path, text: read.text }
}

/**
 * Read the `prompt_file` texts a workflow refers to, confined to the workspace.
 * @param workspace - the workspace realpath.
 * @param paths - the workspace-relative paths as written in the workflow.
 * @returns path to text.
 * @throws {WorkflowFileError} when a file is missing, escapes the workspace, or is too large.
 */
export async function readPromptFiles(workspace: string, paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const path of paths) {
    const problem = checkRelativePath(path)
    if (problem !== undefined) throw new WorkflowFileError(`prompt_file '${path.slice(0, 200)}': ${problem}`)
    out[path] = (await readContained(workspace, join(workspace, path), MAX_PROMPT_FILE_BYTES, `prompt_file '${path.slice(0, 200)}'`)).text
  }
  return out
}
