/**
 * OP-270: the gate is a denylist over a large route table, so a new route would be public by
 * default. This test makes that a decision: every unary route is either token-privileged or on the
 * explicit public list below. Adding a route without classifying it fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(join(import.meta.dirname, relative), 'utf8')

/** Keys of the `UNARY_ROUTES` table in the apiproxy fetch handler (string-sliced, like the workflow wire test). */
function unaryRoutes(): string[] {
  const source = read('../../../host/apiproxy/src/fetch/handler.ts')
  const start = source.indexOf('const UNARY_ROUTES: UnaryRoutes = {')
  const end = source.indexOf('\n}\n', start)
  expect(start).toBeGreaterThan(-1)
  return [...source.slice(start, end).matchAll(/^ {2}'([A-Za-z]+\.[A-Za-z]+)': \{ schema/gm)].map(m => m[1]!)
}

/** Method names in a `new Set([...])` literal of the connection source. */
function setEntries(name: string): string[] {
  const source = read('../src/index.ts')
  const start = source.indexOf(`const ${name} = new Set([`)
  expect(start).toBeGreaterThan(-1)
  const block = source.slice(start, source.indexOf('])', start))
  return [...block.matchAll(/^ {2}'([^']+)',?$/gm)].map(m => m[1]!)
}

/**
 * Routes deliberately open to a loopback or trusted-host caller without the token. Each line is a
 * decision: read-only views, or a capability another open route already grants, or a method the
 * non-browser callers (dsh-hire, dsh-stable, curl) need.
 */
const PUBLIC_ROUTES = new Set([
  // Reads of session / roster / catalog state.
  'session.list', 'session.search', 'session.history', 'session.models', 'session.attachment',
  'subagent.list', 'subagent.history', 'host.describe', 'workspace.list', 'skill.list',
  'agentPreset.list', 'llm.providers', 'llm.models', 'worktree.list', 'org.get',
  // Session lifecycle that `session.create` / `session.prompt` already grant to any /api caller.
  'session.create', 'session.prompt', 'session.rename', 'session.fork', 'session.selectModel',
  'session.updateQueue', 'session.cancel', 'subagent.prompt', 'subagent.interrupt', 'mailbox.publish',
  // Workspace organisation and goal bookkeeping (no host filesystem or process effect).
  'workspace.create', 'workspace.rename', 'workspace.delete', 'workspace.insertBefore',
  'workspace.insertSessionBefore', 'workspace.archiveSession',
  'agentPreset.select',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
])

describe('every unary route is classified (OP-270)', () => {
  it('is privileged, token-required, or on the explicit public list', () => {
    const privileged = new Set(setEntries('PRIVILEGED_METHODS'))
    const tokenOnly = new Set(setEntries('TOKEN_REQUIRED_METHODS'))
    const routes = unaryRoutes()
    expect(routes.length).toBeGreaterThan(50)
    const unclassified = routes.filter(r => !privileged.has(r) && !tokenOnly.has(r) && !PUBLIC_ROUTES.has(r))
    expect(unclassified).toEqual([])
  })

  it('has no route that is both public and gated, and no stale public entry', () => {
    const gated = new Set([...setEntries('PRIVILEGED_METHODS'), ...setEntries('TOKEN_REQUIRED_METHODS')])
    const routes = new Set(unaryRoutes())
    expect([...PUBLIC_ROUTES].filter(r => gated.has(r))).toEqual([])
    expect([...PUBLIC_ROUTES].filter(r => !routes.has(r))).toEqual([])
  })

  it('pins the OP-270 additions', () => {
    const privileged = new Set(setEntries('PRIVILEGED_METHODS'))
    for (const m of [
      'org.write', 'org.writeServed', 'worktree.create', 'worktree.remove', 'worktree.lock',
      'host.createDirectory', 'session.sendAll', 'session.stopAll', 'session.stopTree',
    ]) expect(privileged.has(m)).toBe(true)
    const tokenOnly = new Set(setEntries('TOKEN_REQUIRED_METHODS'))
    expect([...tokenOnly].sort()).toEqual(['host.listDirectory', 'session.export'])
    for (const open of ['mailbox.publish', 'session.create', 'session.prompt', 'subagent.prompt', 'session.history', 'session.rename', 'mcp/status']) {
      expect(privileged.has(open)).toBe(false)
      expect(tokenOnly.has(open)).toBe(false)
    }
  })
})
