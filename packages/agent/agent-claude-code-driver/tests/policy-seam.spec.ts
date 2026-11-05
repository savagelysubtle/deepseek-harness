/**
 * The driver side of the S5 policy seam: what a policy extension may contribute (allow grammar, one in-process
 * `dsh` server, settings), the fixed fences around it, the lazy read of the policy service, the init tool
 * assertion, and the unchanged throwaway guarantee for tainted mail.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { buildQueryOptions, expectedInitTools, toolSetMismatch } from '../src/options.ts'
import type { BuildQueryOptionsInput } from '../src/options.ts'
import { SeatMutedByPolicyError } from '../src/policy-contract.ts'
import type { ClaudeCodePolicy, PolicyExtension } from '../src/policy-contract.ts'
import { CLAUDE_CODE_TURN_ERROR_CODES } from '../src/seat-agent.ts'
import { harness, mailMessage, resultMessage, seatConfig, stubPolicy, tick, userMessage } from './fakes.ts'
import type { FakeQuery, Harness } from './fakes.ts'

const CWD = '/work/seat'
const SERVER = { type: 'sdk', name: 'dsh', instance: {} }

function base(role: 'lead' | 'coder' | 'mail-only', extension: (() => PolicyExtension) | undefined, cwd = CWD): BuildQueryOptionsInput {
  return {
    seat: 's', config: seatConfig({ role }), cwd, binding: { kind: 'first', sdkSessionId: 'x' } as const,
    env: { PATH: '/usr/bin' }, abortController: new AbortController(), spawn: () => { throw new Error('unused') }, extension,
  }
}

const ext = (value: unknown): (() => PolicyExtension) => () => value as PolicyExtension

describe('allow grammar', () => {
  it.each<[string, 'lead' | 'coder', string[]]>([
    ['a dsh tool', 'lead', ['mcp__dsh__mailbox_send']],
    ['a dsh tool name at the length limit', 'lead', [`mcp__dsh__a${'b'.repeat(63)}`]],
    ['Read of the cwd for a lead', 'lead', ['Read(//work/seat/**)']],
    ['Read and Edit of the cwd for a coder', 'coder', ['Read(//work/seat/**)', 'Edit(//work/seat/**)']],
    ['a repeated entry, kept once', 'lead', ['mcp__dsh__a', 'mcp__dsh__a']],
  ])('accepts %s', (_label, role, allow) => {
    const options = buildQueryOptions(base(role, ext({ mcpServers: { dsh: SERVER }, allow })))
    expect((options.settings as { permissions: { allow: string[] } }).permissions.allow).toEqual([...new Set(allow)])
  })

  it.each<[string, 'lead' | 'coder', unknown]>([
    ['a bare tool', 'coder', ['Bash']],
    ['a Bash specifier', 'coder', ['Bash(*)']],
    ['a bare Edit', 'coder', ['Edit']],
    ['a wildcard dsh grant', 'lead', ['mcp__*']],
    ['the whole dsh server', 'lead', ['mcp__dsh']],
    ['an empty dsh tool name', 'lead', ['mcp__dsh__']],
    ['an upper-case dsh tool name', 'lead', ['mcp__dsh__Send']],
    ['a dsh tool name past the length limit', 'lead', [`mcp__dsh__a${'b'.repeat(64)}`]],
    ['another server', 'lead', ['mcp__other__send']],
    ['Edit for a lead', 'lead', ['Edit(//work/seat/**)']],
    ['Edit outside the cwd', 'coder', ['Edit(//etc/**)']],
    ['a sibling directory with the same prefix', 'coder', ['Edit(//work/seatx/**)']],
    ['a project-relative path', 'coder', ['Edit(/work/seat/**)']],
    ['a Write rule', 'coder', ['Write(//work/seat/**)']],
    ['a Grep rule', 'coder', ['Grep(//work/seat/**)']],
    ['a path without the glob', 'coder', ['Read(//work/seat)']],
    ['a non-string entry', 'lead', [7]],
    ['a very long entry, shown cut in the error', 'lead', [`Bash(${'x'.repeat(200)})`]],
    ['a string instead of a list', 'lead', 'mcp__dsh__a'],
    ['an object instead of a list', 'lead', { 0: 'mcp__dsh__a' }],
  ])('refuses %s and the whole extension with it', (_label, role, allow) => {
    expect(() => buildQueryOptions(base(role, ext({ mcpServers: { dsh: SERVER }, allow }))))
      .toThrow(/allow list refused.*refusing to apply a partial policy/)
  })

  it('refuses a dsh tool entry when no dsh server was supplied', () => {
    expect(() => buildQueryOptions(base('lead', ext({ allow: ['mcp__dsh__a'] })))).toThrow(/names a dsh tool but no dsh server was supplied/)
  })

  it.each(['/work/my seat', '/work/se*at', '/work/se[a]t', '/work/!seat', '/work/#seat', '/work/{seat}', '/work/se\\at', '/work/se\nat', '/work/seat/', '/'])(
    'refuses every path entry when the cwd %j cannot be stated unambiguously',
    (cwd) => {
      const unsafe = `Read(//${cwd.slice(1)}/**)`
      expect(() => buildQueryOptions(base('coder', ext({ allow: [unsafe, 'Read(//work/seat/**)'] }), cwd))).toThrow(/allow list refused/)
      // a dsh-only allow list still works in such a directory
      expect(() => buildQueryOptions(base('lead', ext({ mcpServers: { dsh: SERVER }, allow: ['mcp__dsh__a'] }), cwd))).not.toThrow()
    },
  )

  it('keeps settings deny/ask next to the validated allow entries, and strips an allow smuggled inside settings', () => {
    const warned: string[] = []
    const options = buildQueryOptions({
      ...base('lead', ext({
        settings: { permissions: { deny: ['Read(//etc/**)'], allow: ['Bash(*)'] } },
        mcpServers: { dsh: SERVER },
        allow: ['mcp__dsh__a'],
      })),
      warn: (message) => { warned.push(message) },
    })
    expect(options.settings).toEqual({ permissions: { deny: ['Read(//etc/**)'], allow: ['mcp__dsh__a'] }, autoMemoryEnabled: false })
    expect(warned.join('\n')).toContain('"permissions.allow"')
  })
})

describe('mcpServers', () => {
  it('merges exactly one in-process dsh server, rebuilt from the validated fields', () => {
    const extra = { ...SERVER, injected: 'x' }
    const options = buildQueryOptions(base('lead', ext({ mcpServers: { dsh: extra } })))
    expect(options.mcpServers).toEqual({ dsh: { type: 'sdk', name: 'dsh', instance: {} } })
    expect(options.mcpServers?.['dsh']).not.toBe(extra)
  })

  it('passes no mcpServers when the extension supplies none', () => {
    expect(buildQueryOptions(base('lead', ext({})))).not.toHaveProperty('mcpServers')
  })

  it.each<[string, unknown]>([
    ['a stdio server', { dsh: { type: 'stdio', command: 'node', args: [] } }],
    ['an http server', { dsh: { type: 'http', url: 'https://x' } }],
    ['an sse server', { dsh: { type: 'sse', url: 'https://x' } }],
    ['a different key', { other: SERVER }],
    ['a second server beside dsh', { dsh: SERVER, other: SERVER }],
    ['no servers at all', {}],
    ['an sdk server named something else', { dsh: { ...SERVER, name: 'other' } }],
    ['an sdk server without an instance', { dsh: { type: 'sdk', name: 'dsh' } }],
    ['an sdk server whose instance is null', { dsh: { type: 'sdk', name: 'dsh', instance: null } }],
    ['a non-object dsh entry', { dsh: 'node' }],
    ['a list of servers', [SERVER]],
    ['a string', 'dsh'],
  ])('refuses %s', (_label, mcpServers) => {
    expect(() => buildQueryOptions(base('lead', ext({ mcpServers })))).toThrow(/mcpServers refused/)
  })

  it('refuses an extension that returns something other than an object', () => {
    expect(() => buildQueryOptions(base('lead', ext('settings.json')))).toThrow(/returned a non-object/)
    expect(() => buildQueryOptions(base('lead', ext([])))).toThrow(/returned a non-object/)
  })

  it('treats an extension that returns nothing as no contribution', () => {
    const options = buildQueryOptions(base('lead', ext(undefined)))
    expect(options.settings).toEqual({ autoMemoryEnabled: false })
  })
})

describe('the fences stay fixed', () => {
  it.each<['lead' | 'coder' | 'mail-only', string[]]>([
    ['lead', []],
    ['mail-only', []],
    ['coder', ['Read', 'Grep', 'Glob', 'Edit', 'Write']],
  ])('sets tools to the exact native list of a %s, denies Bash, and carries no permission callback', (role, tools) => {
    const options = buildQueryOptions(base(role, ext({
      mcpServers: { dsh: SERVER }, allow: ['mcp__dsh__a'], permissionMode: 'bypassPermissions', tools: ['Bash'], canUseTool: () => ({ behavior: 'allow' }), settingSources: ['user'],
    })))
    expect(options.tools).toEqual(tools)
    expect(options.disallowedTools).toContain('Bash')
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options).not.toHaveProperty('canUseTool')
    expect(options).not.toHaveProperty('allowedTools')
  })

  it('switches auto-memory off through the inline settings on every non-throwaway query', () => {
    expect(buildQueryOptions(base('mail-only', undefined)).settings).toEqual({ autoMemoryEnabled: false })
  })

  it('gives a throwaway query no extension, no servers, no settings and no tools', () => {
    const extension = vi.fn(ext({ mcpServers: { dsh: SERVER }, allow: ['mcp__dsh__a'], settings: { hooks: {} } }))
    const options = buildQueryOptions({ ...base('lead', extension), throwaway: true })
    expect(extension).not.toHaveBeenCalled()
    expect(options.tools).toEqual([])
    for (const key of ['mcpServers', 'settings', 'canUseTool', 'allowedTools', 'hooks']) expect(options).not.toHaveProperty(key)
    expect(options.persistSession).toBe(false)
  })
})

describe('the query context', () => {
  it('defaults to a clean session with nothing delivered, and ignores a taint mark', () => {
    let seen: { tainted: boolean; traces: number; role: string } | undefined
    buildQueryOptions(base('lead', (() => undefined) as never))
    buildQueryOptions({
      ...base('lead', undefined),
      extension: (context) => {
        context.markTurnTainted('x')
        seen = { tainted: context.isTurnTainted(), traces: context.deliveredTraceIds().size, role: context.role }
        return {}
      },
    })
    expect(seen).toEqual({ tainted: false, traces: 0, role: 'lead' })
  })

  it('hands the extension the live controls', () => {
    const marks: string[] = []
    const controls = { isTurnTainted: () => true, markTurnTainted: (why: string) => { marks.push(why) }, deliveredTraceIds: () => new Set(['t1']) }
    let seen: unknown
    buildQueryOptions({
      ...base('lead', undefined),
      controls,
      extension: (context) => {
        context.markTurnTainted('why')
        seen = [
          context.isTurnTainted(), [...context.deliveredTraceIds()], context.seat, context.cwd, context.binding.kind, context.config.role,
        ]
        return {}
      },
    })
    expect(marks).toEqual(['why'])
    expect(seen).toEqual([true, ['t1'], 's', CWD, 'first', 'lead'])
  })
})

describe('init tool assertion helpers', () => {
  it('expects the native tools plus the allowed dsh tools', () => {
    const options = buildQueryOptions(base('coder', ext({ mcpServers: { dsh: SERVER }, allow: ['mcp__dsh__a', 'Read(//work/seat/**)'] })))
    expect(expectedInitTools(options)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'mcp__dsh__a'])
    expect(expectedInitTools({ tools: [] })).toEqual([])
    expect(expectedInitTools({})).toEqual([])
    expect(expectedInitTools({ settings: 'a.json' })).toEqual([])
    expect(expectedInitTools({ settings: { permissions: 'x' } } as unknown as Options)).toEqual([])
    expect(expectedInitTools({ tools: ['A'], settings: { permissions: {} } })).toEqual(['A'])
  })

  it('compares as sets and names the difference', () => {
    expect(toolSetMismatch(['b', 'a'], ['a', 'b'])).toBeUndefined()
    expect(toolSetMismatch([], [])).toBeUndefined()
    expect(toolSetMismatch(['a'], ['a', 'Bash'])).toMatch(/unexpected tools \["Bash"\] and lacked expected tools \[\]/)
    expect(toolSetMismatch(['a', 'mcp__dsh__x'], ['a'])).toMatch(/unexpected tools \[\] and lacked expected tools \["mcp__dsh__x"\]/)
    expect(toolSetMismatch([], undefined)).toMatch(/did not report a tool list/)
    expect(toolSetMismatch([], ['ok', 3])).toMatch(/did not report a tool list/)
    expect(toolSetMismatch([], Array.from({ length: 20 }, (_v, i) => `t${i}`))).toContain('"t11"')
  })
})

const init = (tools: unknown): never => ({ type: 'system', subtype: 'init', tools, session_id: '12345678-1234-4234-8234-123456789012', model: 'sonnet' }) as never

async function runTurn(h: Harness, run: (query: FakeQuery) => void, message = userMessage('hello')) {
  const agent = h.agent()
  agent.followup(message)
  const query = await h.query(0)
  await tick(5)
  run(query)
  await agent.whenIdle()
  return { agent, query }
}

const lastEnd = (agent: { session: { events: readonly { type: string; data: unknown }[] } }) =>
  (agent.session.events.findLast(event => event.type === 'turn/end')?.data as { reason: { kind: string; error?: { code: string; message: string } } }).reason

describe('the policy service is read at use time', () => {
  it('reads it per turn, never at agent creation, and a service registered later is used', async () => {
    const h = await harness()
    const reads = vi.fn(() => h.state.policy)
    ;(h.deps as { policy: unknown }).policy = reads
    h.state.policy = undefined
    const agent = h.agent()
    expect(reads).not.toHaveBeenCalled()
    agent.followup(userMessage('one'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).error).toMatchObject({ code: CLAUDE_CODE_TURN_ERROR_CODES.policy })
    expect(lastEnd(agent).error?.message).toContain('policy service absent')
    h.state.policy = stubPolicy({ mcpServers: { dsh: SERVER as never }, allow: ['mcp__dsh__a'] })
    agent.followup(userMessage('two'))
    // the refused first message stayed queued, so it runs first, then the second
    for (const index of [0, 1]) {
      const query = await h.query(index)
      await tick(5)
      query.emit(init(['mcp__dsh__a']))
      query.emit(resultMessage({ user_message_uuids: query.uuids() }))
      expect(query.options.mcpServers).toEqual({ dsh: SERVER })
      await tick(20)
    }
    await agent.whenIdle()
    expect(lastEnd(agent).kind).toBe('completed')
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('leaves the mail queued when the role cannot be served, and never reads the policy for a mail-only seat', async () => {
    const h = await harness()
    h.state.policy = stubPolicy({}, [])
    const refused = h.agent()
    refused.followup(mailMessage('hi', 'm-1'))
    await refused.whenIdle()
    expect(lastEnd(refused).error?.message).toMatch(/role "lead" is refused: the policy service is not ready for it/)
    expect(h.queries).toHaveLength(0)
    expect(h.state.leases).toEqual([])
    const refusals = refused.session.events.filter(event => event.type === 'claude-code/refused').map(event => event.data)
    expect(refusals).toEqual([expect.objectContaining({ reason: 'admission', detail: expect.stringContaining('is refused') as string })])

    const reads = vi.fn(() => undefined)
    ;(h.deps as { policy: unknown }).policy = reads
    const mailOnly = h.agent({ config: seatConfig({ role: 'mail-only' }) })
    mailOnly.followup(userMessage('hello'))
    const query = await h.query(0)
    await tick(5)
    query.emit(init([]))
    query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    await mailOnly.whenIdle()
    expect(reads).not.toHaveBeenCalled()
    expect(lastEnd(mailOnly).kind).toBe('completed')
  })

  it('mutes a seat the policy leaves with no tools: a recorded refusal, a stable code, a failed lease, no query', async () => {
    const h = await harness()
    h.state.policy = {
      ...stubPolicy(),
      extend: () => { throw new SeatMutedByPolicyError('tester', 'tools list is empty') },
    }
    const agent = h.agent()
    agent.followup(mailMessage('hi', 'm-mute'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).error).toMatchObject({ code: CLAUDE_CODE_TURN_ERROR_CODES.muted })
    expect(lastEnd(agent).error?.message).toContain('muted by policy: tools list is empty')
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-mute:.*muted by policy/)])
    expect(agent.session.events.some(event => event.type === 'claude-code/refused')).toBe(true)
  })

  it('lets any other policy failure end the turn as an ordinary error', async () => {
    const h = await harness()
    h.state.policy = { ...stubPolicy(), extend: () => { throw new Error('provider bug') } }
    const agent = h.agent()
    agent.followup(userMessage('hi'))
    await agent.whenIdle()
    expect(lastEnd(agent).error).toMatchObject({ code: 'UNKNOWN' })
    expect(lastEnd(agent).error?.message).toContain('provider bug')
  })

  it('refuses a whole turn when the extension breaks the allow grammar', async () => {
    const h = await harness()
    h.state.policy = stubPolicy({ allow: ['Bash(*)'] })
    const agent = h.agent()
    agent.followup(userMessage('hi'))
    await agent.whenIdle()
    expect(h.queries).toHaveLength(0)
    expect(lastEnd(agent).error?.message).toContain('allow list refused')
  })
})

describe('the init tool assertion', () => {
  const policy = (): ClaudeCodePolicy => stubPolicy({ mcpServers: { dsh: SERVER as never }, allow: ['mcp__dsh__a'] })

  it.each<[string, unknown]>([
    ['an extra native tool', ['mcp__dsh__a', 'Bash']],
    ['a missing dsh tool', []],
    ['no tool list', undefined],
  ])('aborts the query and fails the lease loudly on %s', async (_label, tools) => {
    const h = await harness()
    h.state.policy = policy()
    const { agent } = await runTurn(h, (query) => {
      query.emit(init(tools))
      query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    }, mailMessage('hi', 'm-init'))
    const end = lastEnd(agent)
    expect(end.error).toMatchObject({ code: CLAUDE_CODE_TURN_ERROR_CODES.toolSet })
    expect(h.state.leases).toEqual([expect.stringMatching(/^fail:m-init:.*tool set the policy did not expect/)])
    expect(agent.session.events.filter(event => event.type === 'claude-code/refused').map(event => (event.data as { detail: string }).detail))
      .toEqual([expect.stringContaining('tool set mismatch')])
    expect(h.warnings.join('\n')).toContain('query was aborted')
  })

  it('records the mismatch once even when a second init arrives', async () => {
    const h = await harness()
    h.state.policy = policy()
    const { agent } = await runTurn(h, (query) => {
      query.emit(init([]))
      query.emit(init(['x']))
    })
    expect(agent.session.events.filter(event => event.type === 'claude-code/refused')).toHaveLength(1)
  })

  it('lets a matching init through, in any order', async () => {
    const h = await harness()
    h.state.policy = stubPolicy({ mcpServers: { dsh: SERVER as never }, allow: ['mcp__dsh__a', 'mcp__dsh__b'] })
    const { agent } = await runTurn(h, (query) => {
      query.emit(init(['mcp__dsh__b', 'mcp__dsh__a']))
      query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    })
    expect(lastEnd(agent).kind).toBe('completed')
  })

  it('also holds a throwaway (tainted-mail) query to an empty tool list', async () => {
    const h = await harness()
    const { agent } = await runTurn(h, (query) => {
      query.emit(init(['Read']))
      query.emit(resultMessage({ user_message_uuids: query.uuids() }))
    }, mailMessage('portal', 'm-t', { tainted: true }))
    expect(lastEnd(agent).error).toMatchObject({ code: CLAUDE_CODE_TURN_ERROR_CODES.toolSet })
  })
})

describe('tainted mail keeps its guarantee with the S5 options present', () => {
  it('gets no tools, no servers, no settings and never calls the policy', async () => {
    const h = await harness()
    const extend = vi.fn(() => ({ mcpServers: { dsh: SERVER as never }, allow: ['mcp__dsh__a'], settings: { hooks: {} } }))
    h.state.policy = { ...stubPolicy(), extend }
    const { agent, query } = await runTurn(h, (q) => {
      q.emit(init([]))
      q.emit(resultMessage({ user_message_uuids: q.uuids() }))
    }, mailMessage('portal', 'm-t', { tainted: true }))
    expect(extend).not.toHaveBeenCalled()
    expect(query.options.tools).toEqual([])
    for (const key of ['mcpServers', 'settings', 'canUseTool', 'allowedTools', 'hooks']) expect(query.options).not.toHaveProperty(key)
    expect(query.options.persistSession).toBe(false)
    expect(lastEnd(agent).kind).toBe('completed')
  })

  it('serves a tainted mail even when the policy service is absent, because the throwaway needs none', async () => {
    const h = await harness()
    h.state.policy = undefined
    const { agent } = await runTurn(h, (q) => {
      q.emit(init([]))
      q.emit(resultMessage({ user_message_uuids: q.uuids() }))
    }, mailMessage('portal', 'm-t2', { tainted: true }))
    expect(lastEnd(agent).kind).toBe('completed')
  })
})
