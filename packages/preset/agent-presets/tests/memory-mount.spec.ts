/**
 * Boot-mount verification for the REAL standard preset's memory group: this
 * spec reads `apps/cli/config/agent-presets/standard/agent.cordis.yml` — the
 * shipped composition, not a fixture copy — extracts the `memory` group
 * verbatim, boots it through the same Loader + mountPreset pipeline as
 * mount.spec.ts via a runtime user root, and asserts the provider publishes
 * its realm-scoped service and the tool lands in the agent's registry.
 *
 * The full standard preset cannot boot in this preset-only harness: rows like
 * `tool-bash` consume host-plane services the harness deliberately lacks.
 * Extracting the group keeps the verification pointed at the REAL file while
 * staying within the mounted scope.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { describe, expect, it } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE, livePresetMounts, serviceForAgent,
} from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { MemoryService } from '@deepseek-ai/dsh-memory'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const STANDARD_FILE = join(REPO_ROOT, 'apps/cli/config/agent-presets/standard/agent.cordis.yml')

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the real preset's memory group behind an entry-local realm. */
    memory: unknown
  }
}

/**
 * The exact YAML document lines of the `memory` group block: from its
 * top-level `- id: memory` to the line before the next top-level entry.
 * Extracted text (not a re-authored copy) so the test fails when the shipped
 * composition drifts.
 * @param source - the raw standard preset composition.
 * @returns the group's verbatim YAML text, or undefined when absent.
 */
function extractMemoryGroup(source: string): string | undefined {
  const lines = source.split('\n')
  const start = lines.findIndex(line => /^- id: memory\s*$/.test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^- /.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/**
 * Boot the harness registries exactly as mount.spec.ts does, plus one user
 * root carrying ONLY the extracted memory group as its `standard` preset.
 *
 * The temp root lives under `<repo>/node_modules/.cache/` deliberately: bare
 * plugin names resolve through Node's parent-directory walk from the config
 * file (the same mechanism `$DSH_HOME/profiles/node_modules` provides in real
 * deployments), and only a root inside the repo tree has the workspace link
 * in its ancestry.
 * @param groupYaml - the verbatim group block text.
 * @returns the booted context and the temp-root cleanup.
 */
async function harnessWithMemoryPreset(groupYaml: string): Promise<{ ctx: Context; done(): Promise<void> }> {
  const cacheRoot = join(REPO_ROOT, 'node_modules', '.cache')
  const root = await mkdtemp(join(cacheRoot, 'dsh-preset-memory-'))
  const presetDir = join(root, 'standard')
  await mkdir(presetDir)
  await writeFile(join(presetDir, COMPOSITION_FILE), `${groupYaml}\n`)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Group rows (name: 'cordis:group') are a loader builtin in real
  // compositions — app-boot registers exactly this (mountRootInclude).
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const roster: Config = {
    default: 'standard',
    roots: [{ path: root, trust: 'user' }],
    includeUserRoot: false,
  }
  await ctx.plugin(AgentPresets, roster)
  return {
    ctx,
    done: () => rm(root, { recursive: true, force: true }),
  }
}

describe('the real standard preset memory group', () => {
  it('ships a well-formed memory group with provider and tool rows', async () => {
    const source = await readFile(STANDARD_FILE, 'utf8')
    const group = extractMemoryGroup(source)
    expect(group).toBeDefined()
    expect(group).toContain("name: '@deepseek-ai/dsh-memory/local-plugin'")
    expect(group).toContain("name: '@deepseek-ai/dsh-memory/tool'")
    expect(group).toContain('isolate:')
    expect(group).toContain('memory: true')
  })

  it('mounts clean through the Loader and exposes scoped service + registry tool', async () => {
    const source = await readFile(STANDARD_FILE, 'utf8')
    const group = extractMemoryGroup(source)
    if (group === undefined) throw new Error('standard preset lost its memory group')
    const booted = await harnessWithMemoryPreset(group)
    const ctx = booted.ctx
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('sess-memory-real'),
        setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
      })

      // The tool reached THIS agent's registry view under the group realm.
      const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
      expect(names).toContain('memory')

      // The realm-scoped service resolved live inside the mount.
      const liveMounts = livePresetMounts(ctx)
      expect(liveMounts.length).toBeGreaterThan(0)

      // Round-trip proof through the mounted composition: resolve the memory
      // service exactly as an in-realm consumer would, then exercise list()
      // against a scope with no entries (read-only).
      const memory = serviceForAgent(ctx, { ctx: handle.agent.ctx }, 'memory') as MemoryService
      expect(memory).toBeDefined()
      expect(await memory.list('/tmp/fictional-real-root')).toEqual([])

      await handle.dispose()
      expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('memory')
    } finally {
      await booted.done()
      await ctx.fiber.dispose()
    }
  })
})
