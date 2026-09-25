/**
 * Boot-mount verification for the REAL standard preset's `tool-session-title`
 * row: this spec reads
 * `apps/cli/config/agent-presets/standard/agent.cordis.yml` — the shipped
 * composition, not a fixture copy — extracts the row verbatim, boots it
 * through the same Loader + mountPreset pipeline as memory-mount.spec.ts via
 * a runtime user root, and asserts the `session_title` tool lands in the
 * agent's tools registry.
 *
 * The tool consumes the shared `sessionTitle` service (host-plane, mounted
 * once in packages/bundle/base/cordis.patch.yml, before any preset joins) via
 * `ctx.get` at execute time rather than `inject`, so mounting the row here
 * needs no host service present — only registration is asserted, same
 * boundary memory-mount.spec.ts draws around its own read-only round-trip.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
import AgentPresets, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const STANDARD_FILE = join(REPO_ROOT, 'apps/cli/config/agent-presets/standard/agent.cordis.yml')

/**
 * The exact YAML document lines of the top-level `tool-session-title` row:
 * from its `- id: tool-session-title` line to the line before the next
 * top-level entry. Extracted text (not a re-authored copy) so the test fails
 * when the shipped composition drifts.
 * @param source - the raw standard preset composition.
 * @returns the row's verbatim YAML text, or undefined when absent.
 */
function extractSessionTitleRow(source: string): string | undefined {
  const lines = source.split('\n')
  const start = lines.findIndex(line => /^- id: tool-session-title\s*$/.test(line))
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
 * Symlink the real `@deepseek-ai/dsh-session-title` package into a throwaway
 * `node_modules` inside `base`. The package is located via
 * `import.meta.resolve` from THIS test file's own module graph — which works
 * because the package is now a declared devDependency of this package — not
 * through any ancestry in the repository's own dependency tree. Mirrors
 * `linkMemoryPackage` in memory-mount.spec.ts.
 * @param base - the throwaway tree's root directory.
 */
async function linkSessionTitlePackage(base: string): Promise<void> {
  const scope = join(base, 'node_modules', '@deepseek-ai')
  const target = join(scope, 'dsh-session-title')
  const source = fileURLToPath(new URL('.', import.meta.resolve('@deepseek-ai/dsh-session-title/package.json')))
  await mkdir(scope, { recursive: true })
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Boot the harness registries exactly as memory-mount.spec.ts does, plus one
 * user root carrying ONLY the extracted `tool-session-title` row as its
 * `standard` preset.
 *
 * The temp root lives under the OS temp directory, never inside the
 * repository, so nothing here depends on the repository's own dependency
 * tree or on a scratch directory the repo happens to have created for
 * something else. It gets its own throwaway `node_modules` holding a symlink
 * to the real session-title package (see `linkSessionTitlePackage`), and the
 * Loader's `internal.import` is overridden to resolve bare specifiers
 * through that throwaway tree via `createRequire`, rather than relying on
 * Node's ordinary upward node_modules walk from `ctx.baseUrl` ever reaching a
 * repository link that nothing declares.
 * @param rowYaml - the verbatim row text.
 * @returns the booted context and the temp-root cleanup.
 */
async function harnessWithSessionTitlePreset(rowYaml: string): Promise<{ ctx: Context; done(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-session-title-'))
  const presetDir = join(root, 'standard')
  await mkdir(presetDir)
  await writeFile(join(presetDir, COMPOSITION_FILE), `${rowYaml}\n`)
  await linkSessionTitlePackage(root)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const rootRequire = createRequire(ctx.baseUrl)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module: unknown = await import(pathToFileURL(rootRequire.resolve(specifier)).href)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  ctx.loader.builtins.include = Include
  // Group rows (name: 'cordis:group') are a loader builtin in real
  // compositions — app-boot registers exactly this (mountRootInclude). This
  // preset's extracted row is not a group, but the builtin is registered the
  // same way the real host does, for parity with memory-mount.spec.ts.
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

describe('the real standard preset session-title tool row', () => {
  it('ships a `tool-session-title` row naming the session-title tool plugin', async () => {
    const source = await readFile(STANDARD_FILE, 'utf8')
    const row = extractSessionTitleRow(source)
    expect(row).toBeDefined()
    expect(row).toContain("name: '@deepseek-ai/dsh-session-title/tool'")
  })

  it('mounts clean through the Loader and registers session_title on the tools registry', async () => {
    const source = await readFile(STANDARD_FILE, 'utf8')
    const row = extractSessionTitleRow(source)
    if (row === undefined) throw new Error('standard preset lost its tool-session-title row')
    const booted = await harnessWithSessionTitlePreset(row)
    const ctx = booted.ctx
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('sess-session-title-real'),
        setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
      })

      // The tool reached THIS agent's registry view under the mounted preset.
      const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
      expect(names).toContain('session_title')

      await handle.dispose()
      expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('session_title')
    } finally {
      await booted.done()
      await ctx.fiber.dispose()
    }
  })
})
