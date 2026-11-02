import { describe, expect, it } from 'vitest'
import { analyze, checkEnvName, checkModelId, checkRelativePath, checkTierTable } from '../src/index.ts'

describe('model denylist', () => {
  it.each([
    'fable', 'Fable', 'FABLE', 'anthropic/fable-1', 'claude-fable-5', 'claude-fable-5-20260801', 'fable-5@20261001',
    'anthropic:fable', 'bedrock/us.anthropic.claude-fable-5-v1:0', 'models/vendor/fable', 'my-fable_latest',
    'ｆａｂｌｅ', 'ＦＡＢＬＥ-1', 'fa\u200Bble', 'fa\u00ADble', 'f-a-b-l-e', 'f.a.b.l.e', 'F A B L E', 'ﬁfable',
  ])('rejects %j', (id) => {
    expect(checkModelId(id), id).toContain('denied model family')
  })

  it.each(['sonnet', 'claude-sonnet-5-5', 'anthropic/claude-opus-4', 'haiku-4-5-20251001', 'gpt-5', 'deepseek-v4', ''])('allows %j',
    (id) => {
      expect(checkModelId(id)).toBeUndefined()
    })

  it('checks a tier table and reports each bad tier', () => {
    expect(checkTierTable({ cheap: 'haiku', standard: 'sonnet', premium: 'opus' })).toEqual({})
    expect(Object.keys(checkTierTable({ cheap: 'haiku', premium: 'anthropic/fable-2' }))).toEqual(['premium'])
  })

  it('rejects the denied model in model and provider fields, with a position', () => {
    for (const field of ['model', 'provider']) {
      const result = analyze('version: 1\nname: demo\ndescription: d\nnodes:\n  - id: a\n    kind: prompt\n'
          + `    prompt: hi\n    mutates_checkout: false\n    ${field}: ｆａｂｌｅ\n`)
      expect(result.diagnostics.map(d => `${d.code} ${d.line}:${d.column}`)).toEqual([`model-denied 9:${field.length + 7}`])
    }
  })
})

describe('relative paths', () => {
  it.each(['', '/etc/passwd', '\\\\host\\share', 'C:\\x', 'c:/x', '~', '~/x', '../x', 'a/../b', 'a/..', '..', 'a\\b', 'a\0b',
    'x'.repeat(513)])('rejects %j', (p) => {
    expect(checkRelativePath(p)).toBeDefined()
  })

  it.each(['prompts/a.md', 'a', 'a/b/c.txt', '.workflows/x', 'dir/..hidden', 'a..b/c'])('allows %j', (p) => {
    expect(checkRelativePath(p)).toBeUndefined()
  })
})

describe('environment denylist', () => {
  it.each([
    'PATH', 'path', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH',
    'GIT_DIR', 'GIT_SSH_COMMAND',
    'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS', 'PYTHONPATH', 'DSH_HOME', 'WF_FIRST_OUTPUT', 'BASH_FUNC_x%%',
    'TMPDIR', 'CDPATH', 'PROMPT_COMMAND', 'JAVA_TOOL_OPTIONS', 'NPM_CONFIG_REGISTRY', '__proto__',
    'EDITOR', 'PAGER', 'BROWSER', 'VISUAL', 'LESSOPEN', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
  ])('rejects %s', (name) => {
    expect(checkEnvName(name), name).toBeDefined()
  })

  it.each(['MAIL_PAGER', 'PROXYMODE', 'CI', 'MY_FLAG', 'lowercase_ok', '_x'])('allows %s', (name) => {
    expect(checkEnvName(name)).toBeUndefined()
  })

  it('rejects denied env names in a workflow at their key position', () => {
    const text = 'version: 1\nname: demo\ndescription: d\nnodes:\n  - id: a\n    kind: bash\n'
        + '    bash: echo\n    env:\n      OK: 1\n      LD_PRELOAD: /x.so\n'
        + '      GIT_DIR: /y\n'
    expect(analyze(text).diagnostics.map(d => `${d.code} ${d.line}:${d.column}`)).toEqual(['env-denied 10:7', 'env-denied 11:7'])
  })
})

describe('trust facts', () => {
  it('shows env values for every bash command', async () => {
    const { describeTrustFacts } = await import('../src/index.ts')
    const text = 'version: 1\nname: demo\ndescription: d\nnodes:\n  - id: a\n    kind: bash\n'
        + '    bash: echo\n    env:\n      MODE: fast\n      N: 3\n'
    const doc = analyze(text).doc
    expect(doc).toBeDefined()
    if (doc === undefined) return
    expect(describeTrustFacts(doc).bashCommands).toEqual([
      { nodeId: 'a', field: 'bash', command: 'echo', envKeys: ['MODE', 'N'], env: { MODE: 'fast', N: '3' } },
    ])
  })
})
