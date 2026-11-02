/**
 * Trust facts for workflow content. Content becomes trusted once a human confirmed it (the tool's
 * approval question, or the UI confirm); the facts live beside the run store as `trust.json`.
 * The trust key covers the YAML and every prompt file it reads, and each fact names the workspace
 * it was granted for, so editing the YAML or a prompt file, or moving the file set to another
 * workspace, asks again.
 * @module @deepseek-ai/dsh-tool-workflow-run/trust
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-workflow-run-store'
import type { TrustFacts } from '@deepseek-ai/dsh-workflow-yaml'
import type { TierModels } from './config.ts'
import { escapeUnsafe } from './text.ts'

/** How a hash became trusted. */
export type TrustedBy = 'tool-approval' | 'ui-confirm'

interface TrustEntry {
  /** The trust key (see {@link trustKey}). */
  readonly hash: string
  /** The workspace realpath the fact was granted for. */
  readonly workspace: string
  readonly by: TrustedBy
  readonly at: number
}

interface TrustFile {
  readonly v: 1
  readonly entries: readonly TrustEntry[]
}

const MAX_ENTRIES = 1000
const HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * The key a trust fact is stored under: the YAML content hash plus the digest of every prompt file.
 * @param hash - the YAML content hash.
 * @param promptDigests - prompt file path to the sha256 of its text.
 * @returns a 64-character lowercase hex key.
 */
export function trustKey(hash: string, promptDigests: Readonly<Record<string, string>>): string {
  const lines = Object.entries(promptDigests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, digest]) => `${path}\0${digest}`)
  return createHash('sha256').update([hash, ...lines].join('\n')).digest('hex')
}

/** File-backed set of trusted workflow keys for one workspace store directory. */
export class TrustStore {
  constructor(private readonly dir: string, private readonly workspace: string) {}

  private get file(): string {
    return join(this.dir, 'trust.json')
  }

  private async load(): Promise<TrustEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A torn or hand-edited file grants nothing: trust is simply asked again.
      return []
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return []
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return []
    return entries.filter((e): e is TrustEntry => typeof e === 'object' && e !== null
      && typeof (e as TrustEntry).hash === 'string' && HASH_PATTERN.test((e as TrustEntry).hash)
      && (e as TrustEntry).workspace === this.workspace)
  }

  /**
   * Whether a trust key was confirmed before for this workspace.
   * @param hash - the trust key.
   * @returns true when a fact for exactly this key and workspace exists.
   */
  async isTrusted(hash: string): Promise<boolean> {
    return (await this.load()).some(e => e.hash === hash)
  }

  /**
   * Record that a key was confirmed for this workspace.
   * @param hash - the trust key.
   * @param by - which path confirmed it.
   */
  async record(hash: string, by: TrustedBy): Promise<void> {
    if (!HASH_PATTERN.test(hash)) throw new Error('trust hash must be 64 lowercase hex characters')
    const entries = (await this.load()).filter(e => e.hash !== hash)
    entries.push({ hash, workspace: this.workspace, by, at: Date.now() })
    const file: TrustFile = { v: 1, entries: entries.slice(-MAX_ENTRIES) }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.file, `${JSON.stringify(file)}\n`)
  }
}

/** A command or path that cannot be shown to the human in full, so trust must not be asked. */
export class TrustTextError extends Error {}

/** Longest rendered command line the confirm text will show; anything longer is refused, never cut. */
export const MAX_TRUST_LINE_CHARS = 4000

function oneLine(text: string, what: string): string {
  const out = escapeUnsafe(text)
  if (out.length > MAX_TRUST_LINE_CHARS) {
    throw new TrustTextError(`${what} is longer than ${MAX_TRUST_LINE_CHARS} characters, so it cannot be shown in full for confirmation`)
  }
  return out
}

/** What the confirm text shows besides the compiler's trust facts. */
export interface TrustContext {
  /** The workspace realpath the commands run in. */
  readonly workspace: string
  /** Prompt file path to the sha256 of the text that will be used. */
  readonly promptDigests: Readonly<Record<string, string>>
  /** The tier-to-model table that resolves an agent's tier. */
  readonly tierModels: Required<TierModels>
}

/**
 * Render the confirmation text that lists everything the workflow will run: the workspace, every
 * bash command verbatim with its node, working directory and environment keys, every agent with
 * its model, and every prompt file with its digest. Environment values are not shown.
 * @param facts - compiler-derived trust facts.
 * @param hash - the YAML content hash being trusted.
 * @param context - the workspace, prompt-file digests and tier table.
 * @returns the plain-text reason shown to the confirming human.
 * @throws {TrustTextError} when a command is too long to show in full: the caller must refuse trust.
 */
export function renderTrustReason(facts: TrustFacts, hash: string, context: TrustContext): string {
  const lines = [
    `Run workflow '${oneLine(facts.name, 'the workflow name')}' (content hash ${hash}); it has not been trusted before.`,
    `Workspace: ${oneLine(context.workspace, 'the workspace path')}`,
    'It runs with the same permissions as the agent\'s bash tool, and these shell commands run on this machine:',
  ]
  if (facts.bashCommands.length === 0) lines.push('  (no shell commands)')
  for (const cmd of facts.bashCommands) {
    const where = cmd.workdir === undefined ? '' : ` [workdir: ${oneLine(cmd.workdir, `the workdir of node '${cmd.nodeId}'`)}]`
    const env = cmd.envKeys.length === 0 ? '' : ` [env keys: ${cmd.envKeys.map(k => oneLine(k,
      'an env key')).join(', ')}; values not shown]`
    lines.push(`  node '${cmd.nodeId}' (${cmd.field})${where}${env}: ${oneLine(cmd.command, `the command of node '${cmd.nodeId}'`)}`)
  }
  if (facts.agents.length > 0) {
    lines.push(`It starts ${facts.agents.length} agent node(s):`)
    for (const agent of facts.agents) {
      const model = agent.model ?? (agent.tier === undefined ? 'default'
        : `tier ${agent.tier} -> ${(context.tierModels as Partial<TierModels>)[agent.tier as keyof TierModels] ?? 'unmapped'}`)
      const provider = agent.provider === undefined ? '' : ` via ${oneLine(agent.provider, 'a provider name')}`
      lines.push(`  node '${agent.nodeId}': model ${oneLine(model, 'a model name')}${provider}`)
    }
  }
  if (facts.approvalNodes > 0) lines.push(`It asks for ${facts.approvalNodes} approval(s) along the way.`)
  if (facts.promptFiles.length > 0) {
    lines.push('Prompt files (the agent instructions; a change to any of them asks again):')
    for (const path of facts.promptFiles) lines.push(`  ${oneLine(path,
      'a prompt file path')} sha256 ${context.promptDigests[path] ?? 'unread'}`)
  }
  return lines.join('\n')
}
