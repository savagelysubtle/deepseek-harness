import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createSeatMcpServer, neverTaintTools } from '../../src/mcp/server.ts'
import { createLeadTemplate } from '../../src/mcp/template.ts'
import { makeContext } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..', '..')
const ownSrc = join(repo, 'packages', 'agent', 'agent-claude-code-tools', 'src')

const SOURCE_FILE = /\.(?:ts|mts|tsx|js)$/

/** Every source file under `packages/<group>/<pkg>/src` and `apps/<app>/src`, as repo-relative paths. */
function allSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path)
    }
  }
  const dirs = (parent: string): string[] => {
    try {
      return readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(parent, entry.name))
    } catch {
      return []
    }
  }
  const roots = [...dirs(join(repo, 'apps')), ...dirs(join(repo, 'packages')).flatMap(dirs)]
  for (const root of roots) {
    try {
      walk(join(root, 'src'))
    } catch {
      // a package without src/ holds no tools
    }
  }
  return out.map(path => relative(repo, path)).sort()
}

/** The one file that documents the declaration syntax in prose and is not a tool declaration. */
const DECLARATION_DOCS = 'packages/agent/agent-claude-code-tools/src/mcp/types.ts'
const NEVER_DECLARATION = /taint:\s*['"]never['"]/
const CONSTANT_DECLARATION = /taint:\s*[A-Za-z_$][\w$.]*/

describe('the taint exemption list', () => {
  it('lists every never tool of the lead template with its reason; adding one shows up as a diff here', () => {
    const template = createLeadTemplate()
    const tools = template.build('lead-one', template.names(), makeContext())
    const never = tools.filter(tool => tool.taint === 'never').map(tool => ({ name: tool.name, taintReason: tool.taintReason }))
    expect(never).toMatchInlineSnapshot(`
      [
        {
          "name": "mailbox_send",
          "taintReason": "returns only a trace id and the destination name the operator configured in send_to; no mail body or external content comes back",
        },
        {
          "name": "mailbox_directory",
          "taintReason": "lists only the seat names the operator configured in send_to; no external content",
        },
      ]
    `)
    expect(tools.filter(tool => tool.taint === 'always')).toEqual([])
  })

  it('lists every source file in the repo that declares a never tool; a new declaration anywhere shows up as a diff here', () => {
    const files = allSources().filter(file => file !== DECLARATION_DOCS && NEVER_DECLARATION.test(readFileSync(join(repo, file), 'utf8')))
    expect(files).toEqual([
      'packages/agent/agent-claude-code-tools/src/mcp/directory.ts',
      'packages/agent/agent-claude-code-tools/src/mcp/send.ts',
    ])
  })

  it('finds no taint declared through a constant: that would hide an exemption from the scan and needs manual review', () => {
    const needsReview = allSources().filter(file => file !== DECLARATION_DOCS && CONSTANT_DECLARATION.test(readFileSync(join(repo, file), 'utf8')))
    expect(needsReview).toEqual([])
  })

  it('the scan patterns are quote-agnostic and catch constants', () => {
    expect(NEVER_DECLARATION.test('taint: "never"')).toBe(true)
    expect(NEVER_DECLARATION.test('taint:\'never\'')).toBe(true)
    expect(NEVER_DECLARATION.test("taint: 'always'")).toBe(false)
    expect(CONSTANT_DECLARATION.test('taint: NEVER_TAINT')).toBe(true)
    expect(CONSTANT_DECLARATION.test('taint: neverTaint')).toBe(true)
    expect(CONSTANT_DECLARATION.test('taint: shared.never')).toBe(true)
    expect(CONSTANT_DECLARATION.test('taint: "never"')).toBe(false)
    expect(CONSTANT_DECLARATION.test("taint: 'never'")).toBe(false)
  })

  it('the server records every never tool it serves, with its reason, for the full-registry snapshot', () => {
    const template = createLeadTemplate()
    const server = createSeatMcpServer({ seat: 'lead-one', tools: template.names(), template, context: makeContext() })
    expect(Object.fromEntries(neverTaintTools(server))).toEqual({
      mailbox_send: 'returns only a trace id and the destination name the operator configured in send_to; no mail body or external content comes back',
      mailbox_directory: 'lists only the seat names the operator configured in send_to; no external content',
    })
    expect(neverTaintTools({}).size).toBe(0)
  })
})

describe('the only path to a tool handler is createSeatMcpServer', () => {
  it('no source file that can see SeatTool calls a handler except the server (and defineSeatTool\'s own wrapper)', () => {
    const own = '@deepseek-ai/dsh-agent-claude-code-tools'
    const callers = allSources()
      .filter((file) => {
        const text = readFileSync(join(repo, file), 'utf8')
        return (join(repo, file).startsWith(ownSrc) || text.includes(own)) && /\bhandler\s*\(/.test(text.replace(/\bhandler\s*:\s*(async\s*)?\(/g, ''))
      })
    expect(callers).toEqual([
      'packages/agent/agent-claude-code-tools/src/mcp/server.ts',
      'packages/agent/agent-claude-code-tools/src/mcp/types.ts',
    ])
    // types.ts only wraps the definition's typed handler inside the tool's own handler; server.ts is the sole caller of that.
    const typesText = readFileSync(join(ownSrc, 'mcp', 'types.ts'), 'utf8')
    expect(typesText.match(/definition\.handler\(/g)).toHaveLength(1)
    expect(readFileSync(join(ownSrc, 'mcp', 'server.ts'), 'utf8').match(/tool\.handler\(/g)).toHaveLength(1)
  })
})
