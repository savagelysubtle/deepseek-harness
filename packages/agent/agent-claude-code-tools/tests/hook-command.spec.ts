import { describe, expect, it } from 'vitest'
import { FILE_TOOLS } from '../src/decide.ts'
import { buildHookCommand, ENV_PATH, GUARD_MATCHER, guardHookGroup, guardScriptPath, HOOK_TIMEOUT_SECONDS, shellQuote } from '../src/hook-command.ts'
import type { HookCommandInput } from '../src/hook-command.ts'
import { isSeatName, isSha256 } from '../src/grammar.ts'

const SHA = 'a'.repeat(64)
const base: HookCommandInput = { nodePath: '/opt/node/bin/node', guardPath: '/opt/dsh/lib/seat-guard.js', policyPath: '/home/me/.dsh/policy/coder-one.json', sha256: SHA, seat: 'coder-one' }

describe('buildHookCommand', () => {
  it('starts with the absolute, attested env and never a PATH lookup', () => {
    expect(buildHookCommand(base).startsWith("'/usr/bin/env' -u NODE_OPTIONS ")).toBe(true)
    expect(ENV_PATH).toBe('/usr/bin/env')
    expect(() => buildHookCommand({ ...base, envPath: '/nonexistent/env' })).toThrow(/cannot resolve it/)
    expect(() => buildHookCommand({ ...base, envPath: 'env' })).toThrow(/absolute/)
  })

  it('builds the exact command line', () => {
    expect(buildHookCommand(base)).toBe(
      `'/usr/bin/env' -u NODE_OPTIONS '/opt/node/bin/node' '/opt/dsh/lib/seat-guard.js' --policy '/home/me/.dsh/policy/coder-one.json' --sha256 ${SHA} --seat coder-one`,
    )
  })

  it.each([
    ['seat', { seat: 'Bad Seat' }],
    ['seat', { seat: 'a;rm' }],
    ['sha256', { sha256: 'ABC' }],
    ['node path', { nodePath: 'node' }],
    ['node path', { nodePath: '/opt/my node/bin/node' }],
    ['guard path', { guardPath: '/opt/$(id)/guard' }],
    ['guard path', { guardPath: "/opt/x'y/guard" }],
    ['policy path', { policyPath: '/a/../b/policy.json' }],
    ['policy path', { policyPath: '/a/b/policy.json/' }],
    ['policy path', { policyPath: '/a/b;c' }],
  ])('refuses a bad %s', (_label, patch) => {
    expect(() => buildHookCommand({ ...base, ...patch })).toThrow(/agent-claude-code-tools/)
  })
})

describe('guard script resolution', () => {
  it('defaults to the built lib/seat-guard.js and offers the source only on request', () => {
    expect(guardScriptPath()).toMatch(/agent-claude-code-tools\/lib\/seat-guard\.js$/)
    expect(guardScriptPath('built')).toBe(guardScriptPath())
    expect(guardScriptPath('source')).toMatch(/agent-claude-code-tools\/src\/bin\.ts$/)
    expect(buildHookCommand({ nodePath: base.nodePath, policyPath: base.policyPath, sha256: base.sha256, seat: base.seat })).toContain(`'${guardScriptPath()}'`)
  })

  it('refuses TypeScript source unless allowed', () => {
    const source = guardScriptPath('source')
    expect(() => buildHookCommand({ ...base, guardPath: source })).toThrow(/TypeScript source/)
    expect(buildHookCommand({ ...base, guardPath: source, allowSourceGuard: true })).toContain(source)
  })
})

describe('shellQuote and grammars', () => {
  it('escapes single quotes', () => {
    expect(shellQuote('a\'b')).toBe('\'a\'\\\'\'b\'')
    expect(shellQuote('plain')).toBe("'plain'")
  })

  it('checks seat names and digests', () => {
    expect(isSeatName('lead-1')).toBe(true)
    expect(isSeatName('Lead')).toBe(false)
    expect(isSeatName(3)).toBe(false)
    expect(isSha256(SHA)).toBe(true)
    expect(isSha256('xyz')).toBe(false)
  })
})

describe('guard hook group', () => {
  it('carries the matcher and the 60 second timeout', () => {
    const group = guardHookGroup('cmd')
    expect(group).toEqual({ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: 'cmd', timeout: 60 }] })
    expect(HOOK_TIMEOUT_SECONDS).toBe(60)
  })

  it('has a matcher that covers every file tool a seat could hold and every dsh tool', () => {
    const matches = (tool: string): boolean => new RegExp(`^(?:${GUARD_MATCHER})$`).test(tool)
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', ...FILE_TOOLS]) expect(matches(tool)).toBe(true)
    expect(matches('mcp__dsh__mailbox_send')).toBe(true)
    expect(matches('mcp__dsh__anything_else')).toBe(true)
    expect(matches('mcp__other__x')).toBe(false)
    expect(FILE_TOOLS).toHaveLength(7)
  })
})
