import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import {
  assertCleanHostEnv, buildChildEnv, CLAUDE_CODE_FORBIDDEN_ENV, forbiddenEnvPresent,
} from '../src/env.ts'
import { allowlistSettings, buildQueryOptions } from '../src/options.ts'
import { PromptStream } from '../src/prompt-stream.ts'
import { foldModelId, isAllowedModel, isFableModel, parseSeatRow, toolPolicyFor } from '../src/seat-config.ts'
import { seatConfig, seatRow, CLAUDE_PATH } from './fakes.ts'

describe('seat row validation', () => {
  it('accepts a complete row and maps it to camelCase', () => {
    const config = parseSeatRow(seatRow({ model: 'opus', effort: 'high', role: 'lead', max_calls_per_window: 30 }), 'lead-seat')
    expect(config).toEqual({
      model: 'opus', effort: 'high', role: 'lead', maxTurns: 20, claudePath: CLAUDE_PATH, maxCallsPerWindow: 30, fableOk: false,
    })
    expect(parseSeatRow(seatRow(), 's')).not.toHaveProperty('effort')
    const pinned = parseSeatRow(seatRow({ claude_path_sha256: 'AB'.repeat(32) }), 's')
    expect(pinned.claudePathSha256).toBe('ab'.repeat(32))
    expect(parseSeatRow(seatRow({ model: 'ｏｐｕｓ' }), 's').model).toBe('opus')
  })

  it.each([
    'claude-fable-1', 'FABLE', 'Fable-5', 'ｆａｂｌｅ', 'ＦＡＢＬＥ', 'fa​ble', 'fab­le', 'opus-fable',
  ])('rejects the fable model id %j without fable_ok', (model) => {
    expect(isFableModel(model)).toBe(true)
    expect(() => parseSeatRow(seatRow({ model }), 'x')).toThrow(/fable model; fable seats need an explicit fable_ok: true/)
  })

  it('lets a fable model through only when the row sets fable_ok: true', () => {
    const allowed = parseSeatRow(Object.assign(seatRow({ model: 'claude-fable-1' }), { fable_ok: true }), 'x')
    expect(allowed.model).toBe('claude-fable-1')
    expect(allowed.fableOk).toBe(true)
    expect(() => parseSeatRow(Object.assign(seatRow({ model: 'claude-fable-1' }), { fable_ok: false }), 'x')).toThrow(/fable_ok/)
    expect(isFableModel('claude-sonnet-4-5')).toBe(false)
  })

  it.each([
    'best', 'default', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'claude-opus', 'claude-3-opus', 'gpt-5', 'opus ', 'claude-sonnet-x', 'claude-haiku-',
  ])('rejects the model %j because it is not on the allowlist', (model) => {
    expect(isAllowedModel(foldModelId(model), false)).toBe(false)
    expect(() => parseSeatRow(seatRow({ model: model === 'opus ' ? 'opus x' : model }), 'x')).toThrow(/is not allowed: use opus, sonnet, haiku/)
  })

  it.each(['opus', 'sonnet', 'haiku', 'claude-opus-4-1', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'SONNET'])('accepts the model %j', (model) => {
    expect(parseSeatRow(seatRow({ model }), 'x').model).toBe(model.toLowerCase())
  })

  it('refuses a coder row until a policy extension is registered', () => {
    expect(() => parseSeatRow(seatRow({ role: 'coder' }), 'x')).toThrow(/role "coder" is refused until the permission-policy extension/)
    expect(() => parseSeatRow(seatRow({ role: 'coder' }), 'x', { policyExtension: false })).toThrow(/refused/)
    expect(parseSeatRow(seatRow({ role: 'coder' }), 'x', { policyExtension: true }).role).toBe('coder')
    for (const role of ['lead', 'mail-only'] as const) expect(parseSeatRow(seatRow({ role }), 'x').role).toBe(role)
  })

  it.each([
    ['wrong driver', Object.assign(seatRow(), { driver: 'other' as never }), /driver must be "claude-code"/],
    ['no block', { driver: 'claude-code' } as never, /claude_code block is required/],
    ['empty model', seatRow({ model: ' ' }), /model must be a non-empty string/],
    ['bad role', seatRow({ role: 'boss' as never }), /role must be one of coder, lead, mail-only/],
    ['bad effort', seatRow({ effort: 'extreme' as never }), /effort must be one of/],
    ['fractional turns', seatRow({ max_turns: 1.5 }), /max_turns must be a positive integer/],
    ['zero turns', seatRow({ max_turns: 0 }), /max_turns must be a positive integer/],
    ['relative claude path', seatRow({ claude_path: 'claude' }), /absolute path to the real claude binary/],
    ['NUL in claude path', seatRow({ claude_path: '/opt/cla\0ude' }), /absolute path/],
    ['bad window cap', seatRow({ max_calls_per_window: 0 }), /max_calls_per_window must be a positive integer/],
    ['bad sha pin', seatRow({ claude_path_sha256: 'xyz' }), /claude_path_sha256 must be 64 hexadecimal characters/],
  ])('rejects %s', (_label, row, message) => {
    expect(() => parseSeatRow(row, 'seat-x')).toThrow(message)
    expect(() => parseSeatRow(row, 'seat-x')).toThrow(/seat "seat-x"/)
  })

  it('builds the native tool policy of each role', () => {
    expect(toolPolicyFor('coder')).toEqual({
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], disallowedTools: ['Bash', 'AskUserQuestion'],
    })
    for (const role of ['lead', 'mail-only'] as const) {
      expect(toolPolicyFor(role).tools).toEqual([])
      expect(toolPolicyFor(role).disallowedTools).toContain('Bash')
    }
  })

  it('exposes a Config schema that applies defaults and rejects a bad driver', () => {
    const parsed = Config({ stateDir: 'claude-code', seats: { a: seatRow() } })
    expect(parsed.disposeGraceMs).toBe(3000)
    expect(parsed.defaultPauseMs).toBe(900_000)
    expect(parsed.seats['a']?.fable_ok).toBe(false)
    expect(() => Config({ stateDir: '/s', seats: { a: Object.assign(seatRow(), { driver: 'default' as never }) } })).toThrow()
  })
})

describe('query options', () => {
  const base = (role: 'coder' | 'lead' | 'mail-only', binding: 'first' | 'resume') => ({
    seat: 's',
    config: seatConfig({ role, effort: 'low' }),
    cwd: '/work/seat',
    binding: { kind: binding, sdkSessionId: '11111111-1111-4111-8111-111111111111' } as const,
    env: { PATH: '/usr/bin' },
    abortController: new AbortController(),
    spawn: () => { throw new Error('unused') },
  })

  it.each(['coder', 'lead', 'mail-only'] as const)('always applies the fences for the %s role', (role) => {
    const options = buildQueryOptions(base(role, 'first'))
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.tools).toEqual(role === 'coder' ? ['Read', 'Grep', 'Glob', 'Edit', 'Write'] : [])
    expect(options.disallowedTools).toContain('Bash')
    expect(options.maxTurns).toBe(20)
    expect(options.model).toBe('sonnet')
    expect(options.effort).toBe('low')
    expect(options.pathToClaudeCodeExecutable).toBe(CLAUDE_PATH)
    expect(options.persistSession).toBe(true)
    expect(options.env).toEqual({ PATH: '/usr/bin' })
  })

  it('binds the first query with sessionId and later queries with resume', () => {
    const first = buildQueryOptions(base('coder', 'first'))
    expect(first.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(first).not.toHaveProperty('resume')
    const later = buildQueryOptions(base('coder', 'resume'))
    expect(later.resume).toBe('11111111-1111-4111-8111-111111111111')
    expect(later).not.toHaveProperty('sessionId')
    expect(buildQueryOptions({ ...base('coder', 'first'), config: seatConfig() })).not.toHaveProperty('effort')
  })

  it('lets the extension add settings but never loosen a fence', () => {
    const seen: string[] = []
    const warned: string[] = []
    const options = buildQueryOptions({
      ...base('mail-only', 'first'),
      warn: (message) => { warned.push(message) },
      extension: (context) => {
        seen.push(context.seat, context.binding.kind)
        return {
          settings: { hooks: {} },
          permissionMode: 'bypassPermissions',
          settingSources: ['user'],
          tools: ['Bash'],
          strictMcpConfig: false,
        } as never
      },
    })
    expect(seen).toEqual(['s', 'first'])
    expect(options.settings).toEqual({ hooks: {} })
    expect(warned).toEqual([])
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.settingSources).toEqual([])
    expect(options.tools).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
  })
})

describe('extension settings allowlist', () => {
  const run = (raw: unknown) => {
    const warned: string[] = []
    return { settings: allowlistSettings(raw, 'seat', (message) => { warned.push(message) }), warned }
  }

  it('keeps hooks and permission deny/ask entries and nothing else', () => {
    const { settings, warned } = run({
      hooks: { PreToolUse: [] },
      permissions: { deny: ['Read(~/.claude/**)'], ask: ['Edit'], allow: ['Bash(*)'], additionalDirectories: ['/'], defaultMode: 'bypassPermissions' },
      env: { ANTHROPIC_API_KEY: 'x' },
      apiKeyHelper: 'echo key',
      model: 'fable',
      disableAllHooks: true,
      enableAllProjectMcpServers: true,
    })
    expect(settings).toEqual({ hooks: { PreToolUse: [] }, permissions: { deny: ['Read(~/.claude/**)'], ask: ['Edit'] } })
    expect(warned.join('\n')).toMatch(/"env".*stripped/)
    for (const key of ['apiKeyHelper', 'model', 'disableAllHooks', 'enableAllProjectMcpServers', 'permissions.allow', 'permissions.additionalDirectories', 'permissions.defaultMode']) {
      expect(warned.join('\n')).toContain(`"${key}"`)
    }
  })

  it('drops a string (a settings path or JSON text) and any non-object shape', () => {
    expect(run('/etc/evil.json').settings).toBeUndefined()
    expect(run('/etc/evil.json').warned[0]).toContain('<string settings (path or JSON)>')
    expect(run(['hooks']).warned[0]).toContain('<non-object settings>')
    expect(run(7).settings).toBeUndefined()
    expect(run(undefined)).toEqual({ settings: undefined, warned: [] })
  })

  it('drops permission lists that hold non-strings and malformed hooks, and returns nothing when nothing survives', () => {
    const bad = run({ hooks: 'echo', permissions: { deny: ['ok', 3], ask: 'Edit' } })
    expect(bad.settings).toBeUndefined()
    expect(bad.warned.join('\n')).toMatch(/"hooks"[\s\S]*"permissions.deny"[\s\S]*"permissions.ask"/)
    expect(run({ permissions: 'deny' }).warned[0]).toContain('"permissions"')
  })

  it('strips content through buildQueryOptions and re-checks the child environment and model afterwards', () => {
    const input = {
      seat: 's', config: seatConfig({ role: 'lead' }), cwd: '/w', binding: { kind: 'first', sdkSessionId: 'x' } as const,
      env: { PATH: '/usr/bin' }, abortController: new AbortController(), spawn: () => { throw new Error('unused') },
    }
    const warned: string[] = []
    const options = buildQueryOptions({
      ...input, warn: (message) => { warned.push(message) }, extension: () => ({ settings: { env: { ANTHROPIC_BASE_URL: 'http://evil' } } as never }),
    })
    expect(options).not.toHaveProperty('settings')
    expect(warned[0]).toContain('"env"')
    expect(buildQueryOptions({ ...input, extension: () => ({ settings: '/tmp/x.json' as never }) })).not.toHaveProperty('settings')
    expect(() => buildQueryOptions({ ...input, env: { ANTHROPIC_API_KEY: 'k', anthropic_model: 'fable' } }))
      .toThrow(/forbidden variable\(s\) ANTHROPIC_API_KEY, anthropic_model/)
    expect(() => buildQueryOptions({ ...input, config: { ...input.config, model: 'best' } })).toThrow(/model "best" is not allowed/)
  })
})

describe('environment', () => {
  it('removes every credential, model-remap, config-dir, and provider override from the child environment, case-insensitively', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', ANTHROPIC_BASE_URL: 'c',
      CLAUDE_CODE_OAUTH_TOKEN: 'd', anthropic_base_url: 'e', HOME: '/h', ANTHROPIC_MODEL: 'm', ANTHROPIC_DEFAULT_OPUS_MODEL: 'o',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'f', anthropic_default_sonnet_model: 's', ANTHROPIC_SMALL_FAST_MODEL: 'h', ANTHROPIC_CUSTOM_HEADERS: 'x',
      CLAUDE_CONFIG_DIR: '/other', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
      ANTHROPIC_DEFAULT_MODEL_NAME: 'kept', CLAUDE_CODE_USE_ANTHROPIC: '1',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', ANTHROPIC_DEFAULT_MODEL_NAME: 'kept', CLAUDE_CODE_USE_ANTHROPIC: '1' })
    for (const name of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) expect(CLAUDE_CODE_FORBIDDEN_ENV).toContain(name)
    expect(forbiddenEnvPresent({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x', ANTHROPIC_DEFAULT_NEWTIER_MODEL: 'y', ANTHROPIC_DEFAULT_MODEL_NAME: 'z' }))
      .toEqual(['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_NEWTIER_MODEL'])
  })

  it('defaults to the scrubbed host environment', () => {
    const env = buildChildEnv()
    for (const name of CLAUDE_CODE_FORBIDDEN_ENV) expect(env).not.toHaveProperty(name)
  })

  it('refuses to run when any forbidden variable is set, naming each', () => {
    expect(() => { assertCleanHostEnv({ PATH: '/usr/bin' }) }).not.toThrow()
    expect(forbiddenEnvPresent({ ANTHROPIC_API_KEY: undefined })).toEqual([])
    expect(() => { assertCleanHostEnv({ ANTHROPIC_API_KEY: 'sk' }) }).toThrow(/ANTHROPIC_API_KEY is set in the host environment/)
    expect(() => { assertCleanHostEnv({ ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: 't' }) })
      .toThrow(/ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN are set/)
  })

  it('refuses at plugin start when the host environment carries an override', () => {
    const saved = process.env['ANTHROPIC_AUTH_TOKEN']
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'leaked'
    try {
      expect(() => { apply(new Context(), Config({ stateDir: 'claude-code', seats: {} })) })
        .toThrow(/refusing to run: ANTHROPIC_AUTH_TOKEN/)
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN']
      else process.env['ANTHROPIC_AUTH_TOKEN'] = saved
    }
  })
})

describe('prompt stream', () => {
  it('delivers queued and later pushes in order, then completes on end', async () => {
    const stream = new PromptStream()
    const message = (text: string) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) as never
    stream.push(message('a'))
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ message: { content: 'a' } })
    const pending = iterator.next()
    stream.push(message('b'))
    expect((await pending).value).toMatchObject({ message: { content: 'b' } })
    const waiting = iterator.next()
    stream.end()
    expect((await waiting).done).toBe(true)
    expect(stream.closed).toBe(true)
    expect(() => { stream.push(message('c')) }).toThrow(/closed/)
    stream.end()
    expect((await iterator.next()).done).toBe(true)
  })

  it('closes when the consumer returns early', async () => {
    const stream = new PromptStream()
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.return?.())?.done).toBe(true)
    expect(stream.closed).toBe(true)
  })
})
