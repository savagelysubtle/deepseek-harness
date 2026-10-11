/**
 * Tests for `./src/handle-store.ts`: the root-scoped handle store
 * (`registerMcpHandle`/`listMcpHandles`/`subscribeMcpHandles`) and the
 * `cordis.patch.yml` profile-file helpers it exports for
 * `@deepseek-ai/dsh-mcp-status`'s status-registry service — split out of
 * `status-registry.ts` in SWD-164 round 5, defect 2 (see that module's own
 * doc for the full history). The service-level behavior these helpers
 * compose into (`list`, `authorize-start`, `reconnect`, `set-enabled`) is
 * tested through the service itself in
 * `packages/mcp/mcp-status/tests/status-registry.spec.ts`; this file proves
 * the lower-level primitives this package owns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { StreamableHttpConfig } from '../src/index.ts'
import {
  backupPatchBytes,
  defaultPatchPath,
  hashMcpPatchBytes,
  listMcpHandles,
  locateMcpMount,
  parsePatchDocument,
  parsePatchFile,
  readMcpPatchEntries,
  redactAbsolutePaths,
  registerMcpHandle,
  subscribeMcpHandles,
} from '../src/handle-store.ts'
import type { ConnectionHandle } from '../src/connection.ts'
import type { McpServerStatus } from '../src/status.ts'

// `backupPatchBytes`'s non-Error-thrown branch cannot be produced by any
// real fs failure (Node's fs module only ever throws Error/ErrnoException
// instances), so it is injected via `vi.mock`, one-shot — same pattern
// `packages/mcp/mcp-status/tests/status-registry.spec.ts` uses for its own
// copy's identical branch. Off by default (`openWxFailError`/
// `readFileFailPath` undefined) so every other test's `open`/`readFile`
// call passes straight through to the real implementation.
const fsOpenFailState = vi.hoisted(() => ({
  openWxFailError: undefined as unknown,
  readFileFailPath: undefined as string | undefined,
  readFileFailError: undefined as unknown,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [, flags] = args
      if (flags === 'wx' && fsOpenFailState.openWxFailError !== undefined) {
        const error = fsOpenFailState.openWxFailError
        fsOpenFailState.openWxFailError = undefined // one-shot
        throw error
      }
      return actual.open(...args)
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const [path] = args
      if (
        fsOpenFailState.readFileFailPath !== undefined
        && typeof path === 'string'
        && path === fsOpenFailState.readFileFailPath
      ) {
        const error = fsOpenFailState.readFileFailError
        fsOpenFailState.readFileFailPath = undefined // one-shot
        fsOpenFailState.readFileFailError = undefined
        throw error
      }
      return actual.readFile(...args)
    }) as typeof actual.readFile,
  }
})

/**
 * Build one `cordis.patch.yml` mount entry's YAML lines for an
 * `@deepseek-ai/dsh-mcp-client` mount, `id` and `config.serverName`
 * deliberately independent (same fixture shape as
 * `status-registry.spec.ts`'s own copy — ids are opaque; matching logic may
 * never assume `id === 'mcp-' + config.serverName`).
 */
function mcpMountYaml(id: string, serverName: string, disabled?: boolean, indent = ''): string {
  const lines = [
    `${indent}- id: ${id}`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: ${serverName}`,
  ]
  if (disabled !== undefined) lines.push(`${indent}  disabled: ${String(disabled)}`)
  return lines.join('\n')
}

function httpConfig(serverName: string): StreamableHttpConfig {
  return {
    transport: 'streamable-http',
    serverName,
    url: 'http://127.0.0.1:1/mcp',
    headers: {},
    toolCallTimeoutMs: 10_000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  }
}

/** A minimal fake `ConnectionHandle` — no real connection, no OAuth. */
function fakeHandle(serverName: string): { handle: ConnectionHandle; fireStatusChange: (status: McpServerStatus) => void } {
  const listeners = new Set<(status: McpServerStatus) => void>()
  const handle: ConnectionHandle = {
    ready: Promise.resolve({}),
    async dispose() {},
    status() {
      return { serverName, state: 'connected', attempts: 0, maxAttempts: 10 }
    },
    reconnectNow() {},
    onStatusChange(callback) {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    authProvider: undefined,
    peekConsentUrl() { return undefined },
    forceReconnectAfterAuthorization() {},
    reportAuthorizationFailure() {},
    beginAuthorization() {},
    endAuthorization() {},
    isReconnectAttemptInFlight() { return false },
  }
  return { handle, fireStatusChange: (status) => { for (const listener of listeners) listener(status) } }
}

describe('defaultPatchPath', () => {
  it('resolves under the running profile directory from ctx.baseUrl', async () => {
    const ctx = new Context()
    ctx.baseUrl = 'file:///home/dsh/profiles/web/'
    try {
      expect(defaultPatchPath(ctx)).toBe('/home/dsh/profiles/web/cordis.patch.yml')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('warns once and returns undefined when ctx.baseUrl is unset (no profile loader mounted)', async () => {
    const ctx = new Context()
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)
    try {
      expect(defaultPatchPath(ctx)).toBeUndefined()
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('ctx.baseUrl is unset')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('registerMcpHandle / listMcpHandles', () => {
  let ctx: Context
  afterEach(async () => { await ctx.fiber.dispose() })

  it('register exposes the handle through listMcpHandles; unregister removes it', async () => {
    ctx = new Context()
    const { handle } = fakeHandle('srv')
    const unregister = registerMcpHandle(ctx, httpConfig('srv'), handle)

    expect(listMcpHandles(ctx).get('srv')?.handle).toBe(handle)

    await unregister()
    expect(listMcpHandles(ctx).has('srv')).toBe(false)
  })

  it('a child context\'s registration is visible through the shared root', async () => {
    ctx = new Context()
    const child = ctx.extend()
    const { handle } = fakeHandle('srv')
    registerMcpHandle(child, httpConfig('srv'), handle)
    expect(listMcpHandles(ctx).get('srv')?.handle).toBe(handle)
  })

  it('an HMR replacement registration is not torn down by the OLD instance\'s unregister', async () => {
    ctx = new Context()
    const config = httpConfig('hmr')
    const { handle: oldHandle } = fakeHandle('hmr')
    const { handle: newHandle } = fakeHandle('hmr')

    const unregisterOld = registerMcpHandle(ctx, config, oldHandle)
    registerMcpHandle(ctx, config, newHandle)
    await unregisterOld()

    expect(listMcpHandles(ctx).get('hmr')?.handle).toBe(newHandle)
  })
})

describe('subscribeMcpHandles — forwarding', () => {
  let ctx: Context
  let dir: string
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('forwards a live handle\'s own onStatusChange transitions', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const { handle, fireStatusChange } = fakeHandle('srv')
    registerMcpHandle(ctx, httpConfig('srv'), handle)

    const events: McpServerStatus[] = []
    const unsubscribe = subscribeMcpHandles(ctx, (status) => { events.push(status) })
    fireStatusChange({ serverName: 'srv', state: 'gave-up', attempts: 5, maxAttempts: 10 })
    unsubscribe()
    fireStatusChange({ serverName: 'srv', state: 'connected', attempts: 0, maxAttempts: 10 })

    expect(events).toEqual([{ serverName: 'srv', state: 'gave-up', attempts: 5, maxAttempts: 10 }])
  })

  it('forwards a final "disabled" status on unregister when the mount is still named (disabled) in the patch file', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, `${mcpMountYaml('mcp-srv', 'srv', true)}\n`, 'utf8')
    const { handle } = fakeHandle('srv')
    const unregister = registerMcpHandle(ctx, httpConfig('srv'), handle, { patchPath })

    const events: McpServerStatus[] = []
    subscribeMcpHandles(ctx, (status) => { events.push(status) })
    await unregister()

    expect(events).toEqual([{ serverName: 'srv', state: 'disabled', attempts: 0, maxAttempts: 10 }])
  })

  it('forwards a final "removed: true" status on unregister when the mount is no longer named in the patch file at all', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, `${mcpMountYaml('mcp-someone-else', 'someone-else')}\n`, 'utf8')
    const { handle } = fakeHandle('gone')
    const unregister = registerMcpHandle(ctx, httpConfig('gone'), handle, { patchPath })

    const events: McpServerStatus[] = []
    subscribeMcpHandles(ctx, (status) => { events.push(status) })
    await unregister()

    expect(events).toEqual([{ ...handle.status(), removed: true }])
  })

  it('forwards nothing on unregister when the mount is still enabled in the patch file (an ordinary reload)', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, `${mcpMountYaml('mcp-srv', 'srv')}\n`, 'utf8')
    const { handle } = fakeHandle('srv')
    const unregister = registerMcpHandle(ctx, httpConfig('srv'), handle, { patchPath })

    const events: McpServerStatus[] = []
    subscribeMcpHandles(ctx, (status) => { events.push(status) })
    await unregister()

    expect(events).toEqual([])
  })

  it('forwards nothing on unregister when the replacement has already registered under the same serverName (fast path)', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, `${mcpMountYaml('mcp-srv', 'srv', true)}\n`, 'utf8')
    const config = httpConfig('srv')
    const { handle: oldHandle } = fakeHandle('srv')
    const { handle: newHandle } = fakeHandle('srv')

    const unregisterOld = registerMcpHandle(ctx, config, oldHandle, { patchPath })
    registerMcpHandle(ctx, config, newHandle, { patchPath })

    const events: McpServerStatus[] = []
    subscribeMcpHandles(ctx, (status) => { events.push(status) })
    await unregisterOld()

    expect(events).toEqual([])
  })

  it('forwards nothing when the patch file read fails (unreadable, not merely absent)', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    // A patch file that never existed in a directory that also does not
    // exist is not ENOENT-on-the-file alone — readFile on a missing parent
    // directory still yields ENOENT, so instead point at a path whose
    // parent is a FILE, which fails with ENOTDIR — a real non-ENOENT I/O
    // failure, exercising the "read failed, not merely absent" branch.
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'x', 'utf8')
    const patchPath = join(blocker, 'cordis.patch.yml')
    const { handle } = fakeHandle('srv')
    const unregister = registerMcpHandle(ctx, httpConfig('srv'), handle, { patchPath })

    const events: McpServerStatus[] = []
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)
    subscribeMcpHandles(ctx, (status) => { events.push(status) })
    await unregister()

    expect(events).toEqual([])
    expect(warns).toHaveLength(1)
  })
})

describe('readMcpPatchEntries', () => {
  let ctx: Context
  let dir: string
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty map for a missing file, silently (ENOENT is the ordinary no-patch-file case)', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    const entries = await readMcpPatchEntries(ctx, join(dir, 'does-not-exist.yml'))
    expect(entries).toEqual(new Map())
    expect(warns).toHaveLength(0)
  })

  it('returns undefined when there is no path to read at all', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    expect(await readMcpPatchEntries(ctx, undefined)).toBeUndefined()
  })

  it('warns once and returns undefined for a non-ENOENT read failure (non-Error thrown value)', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, `${mcpMountYaml('mcp-srv', 'srv', false)}\n`, 'utf8')
    fsOpenFailState.readFileFailPath = patchPath
    fsOpenFailState.readFileFailError = 'a plain thrown string, not an Error'
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    expect(await readMcpPatchEntries(ctx, patchPath)).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('a plain thrown string, not an Error')
  })

  it('warns once and returns undefined for malformed YAML', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, ': : not yaml ][', 'utf8')
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    expect(await readMcpPatchEntries(ctx, patchPath)).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('not valid YAML')
  })

  it('warns once and returns undefined for a document with no top-level list', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(patchPath, 'serverName: not-a-list\n', 'utf8')
    const warns: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: unknown) => { warns.push(String(message)) }) as never)

    expect(await readMcpPatchEntries(ctx, patchPath)).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('does not contain a top-level list')
  })

  it(
    'emits no process "warning" event for a `!!js`-tagged entry (SWD-169\'s TAG_RESOLVE_FAILED no longer fires '
    + 'now that `parsePatchDocument` registers the tag) and returns the correct entries',
    async () => {
      ctx = new Context()
      dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
      const patchPath = join(dir, 'cordis.patch.yml')
      await writeFile(
        patchPath,
        [
          '- id: mcp-supabase',
          '  name: \'@deepseek-ai/dsh-mcp-client\'',
          '  config:',
          '    serverName: supabase',
          '    headers:',
          '      # a comment sitting right above the tagged scalar',
          '      Authorization: !!js \'`Bearer ${process.env.TOKEN}`\'',
          mcpMountYaml('mcp-flat', 'flat', false),
          '',
        ].join('\n'),
        'utf8',
      )
      const warnings: unknown[] = []
      const onWarning = (warning: unknown): void => { warnings.push(warning) }
      process.on('warning', onWarning)
      let entries: Awaited<ReturnType<typeof readMcpPatchEntries>>
      try {
        entries = await readMcpPatchEntries(ctx, patchPath)
      } finally {
        process.off('warning', onWarning)
      }
      expect(warnings).toEqual([])
      expect(entries).toEqual(new Map([
        ['supabase', { disabled: false }],
        ['flat', { disabled: false }],
      ]))
    },
  )

  it('collects only valid mcp-client mounts, flat and nested, skipping non-object and invalid-serverName entries', async () => {
    ctx = new Context()
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-'))
    const patchPath = join(dir, 'cordis.patch.yml')
    await writeFile(
      patchPath,
      [
        '- null',
        '- a plain string top-level entry',
        '- id: mcp-no-config',
        '  name: \'@deepseek-ai/dsh-mcp-client\'',
        '  disabled: true',
        '- id: mcp-bad-pattern',
        '  name: \'@deepseek-ai/dsh-mcp-client\'',
        '  config:',
        '    serverName: \'not valid!\'',
        '  disabled: true',
        '- id: group',
        '  insert:',
        '    - a plain string nested entry',
        mcpMountYaml('mcp-nested', 'nested', true, '    '),
        mcpMountYaml('mcp-flat', 'flat', false),
        '',
      ].join('\n'),
      'utf8',
    )
    const entries = await readMcpPatchEntries(ctx, patchPath)
    expect(entries).toEqual(new Map([
      ['nested', { disabled: true }],
      ['flat', { disabled: false }],
    ]))
  })
})

describe('locateMcpMount', () => {
  it('finds a flat top-level mount by config.serverName', () => {
    const entry = { id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'a' } }
    expect(locateMcpMount([entry], 'a')).toEqual({
      kind: 'found',
      location: { topIndex: 0, entry },
    })
  })

  it('finds a nested mount under a group\'s insert list', () => {
    const nested = { id: 'mcp-b', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'b' } }
    const patches = [{ id: 'group', insert: [nested] }]
    expect(locateMcpMount(patches, 'b')).toEqual({
      kind: 'found',
      location: { topIndex: 0, insertIndex: 0, entry: nested },
    })
  })

  it('reports not-found when no mount matches', () => {
    expect(locateMcpMount([], 'ghost')).toEqual({ kind: 'not-found' })
  })

  it('reports ambiguous when more than one mount shares the requested serverName', () => {
    const a = { id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'dup' } }
    const b = { id: 'mcp-b', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'dup' } }
    expect(locateMcpMount([a, b], 'dup')).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('skips non-object top-level and nested entries, and entries missing/with a non-object config, while still finding the real mount', () => {
    const real = { id: 'mcp-real', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'real' } }
    const patches = [
      null,
      'a plain string',
      { id: 'mcp-no-config', name: '@deepseek-ai/dsh-mcp-client' },
      { id: 'mcp-string-config', name: '@deepseek-ai/dsh-mcp-client', config: 'not-an-object' },
      { id: 'group', insert: ['a plain string nested', null] },
      real,
    ]
    expect(locateMcpMount(patches, 'real')).toEqual({ kind: 'found', location: { topIndex: 5, entry: real } })
  })

  it('skips a well-formed mcp-client entry whose config.serverName simply does not match, continuing to the real mount', () => {
    const mismatched = { id: 'mcp-other', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'other' } }
    const real = { id: 'mcp-real', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'real' } }
    expect(locateMcpMount([mismatched, real], 'real')).toEqual({ kind: 'found', location: { topIndex: 1, entry: real } })
  })
})

describe('parsePatchDocument / parsePatchFile', () => {
  // The real `web-stable` profile's own trigger for SWD-169/SWD-170: a
  // leading comment, a blank-line-free block, and a `headers.Authorization`
  // scalar carrying the boot loader's `!!js` dialect — copied in shape (not
  // value) from `~/.dsh/profiles/web-stable/cordis.patch.yml`, which holds
  // the exact same construct with no secret values.
  const jsTaggedWithComments = [
    '# why this needs the raw expression, not a literal token',
    '- id: mcp-srv',
    '  name: \'@deepseek-ai/dsh-mcp-client\'',
    '  config:',
    '    serverName: srv',
    '    headers:',
    '      Authorization: !!js \'`Bearer ${process.env.TOKEN}`\'',
    '',
  ].join('\n')

  it(
    'registers the `!!js` custom tag: no parse errors or warnings, the tag resolves to its raw string via toJS(), '
    + 'and a no-edit round trip reproduces the source byte-for-byte (tag, quoting, comment, and trailing newline included)',
    () => {
      const doc = parsePatchDocument(jsTaggedWithComments)
      expect(doc.errors).toEqual([])
      expect(doc.warnings).toEqual([])
      const patches = doc.toJS() as [{ config: { headers: { Authorization: unknown } } }]
      expect(patches[0].config.headers.Authorization).toBe('`Bearer ${process.env.TOKEN}`')
      expect(doc.toString({ indentSeq: false, singleQuote: true })).toBe(jsTaggedWithComments)
    },
  )

  it('parsePatchFile returns the document and its already-resolved plain-JS form, kept in sync', () => {
    const { doc, patches } = parsePatchFile(`${mcpMountYaml('mcp-srv', 'srv', true)}\n`)
    expect(Array.isArray(patches)).toBe(true)
    expect(doc.toJS()).toEqual(patches)
  })

  it('throws the composer\'s own first error for malformed YAML (a problem `doc.errors` catches)', () => {
    expect(() => parsePatchFile(': : not yaml ][')).toThrow(/Nested mappings are not allowed in compact mappings/)
  })

  it('throws whatever toJS() itself throws for a problem that only surfaces at JS-conversion time (an unresolved alias)', () => {
    expect(() => parsePatchFile('key: *missing\n')).toThrow(/Unresolved alias/)
  })
})

describe('hashMcpPatchBytes', () => {
  it('is deterministic for identical bytes and differs for different bytes', () => {
    const a = Buffer.from('one')
    const b = Buffer.from('one')
    const c = Buffer.from('two')
    expect(hashMcpPatchBytes(a)).toBe(hashMcpPatchBytes(b))
    expect(hashMcpPatchBytes(a)).not.toBe(hashMcpPatchBytes(c))
  })
})

describe('redactAbsolutePaths', () => {
  it('redacts quoted-double, quoted-single, and bare absolute paths', () => {
    expect(redactAbsolutePaths('see "/home/dsh/secret" and \'/etc/passwd\' and /var/log/x')).toBe(
      'see "<path>" and \'<path>\' and <path>',
    )
  })
})

describe('backupPatchBytes', () => {
  let dir: string
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('writes a timestamped backup of the given bytes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-backup-'))
    const path = join(dir, 'cordis.patch.yml')
    const backupPath = await backupPatchBytes(path, Buffer.from('content'))
    expect(await readFile(backupPath, 'utf8')).toBe('content')
    expect((await readdir(dir)).some(name => name.startsWith('cordis.patch.yml.bak-'))).toBe(true)
  })

  it('retries past an existing same-timestamp backup rather than overwriting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-backup-'))
    const path = join(dir, 'cordis.patch.yml')
    const now = new Date('2026-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      await writeFile(`${path}.bak-${stamp}`, 'placeholder', 'utf8')
      const backupPath = await backupPatchBytes(path, Buffer.from('content'))
      expect(backupPath).toBe(`${path}.bak-${stamp}-1`)
      expect(await readFile(backupPath, 'utf8')).toBe('content')
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws after exhausting every same-timestamp backup filename', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-backup-'))
    const path = join(dir, 'cordis.patch.yml')
    const now = new Date('2026-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      await writeFile(`${path}.bak-${stamp}`, 'placeholder', 'utf8')
      for (let i = 0; i < 100; i++) {
        await writeFile(`${path}.bak-${stamp}-${i}`, 'placeholder', 'utf8')
      }
      await expect(backupPatchBytes(path, Buffer.from('content'))).rejects.toThrow(/has no free backup filename/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loud (Error instance) when the backup file cannot be created for a reason other than it already existing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-backup-'))
    // `open(dir, 'wx')` on an EXISTING directory reports EEXIST on Linux, not
    // EISDIR — that collides with the retry case, not this one. A
    // deterministic non-collision error instead: make the candidate path's
    // own PARENT a regular file, so `open()` cannot even traverse into it
    // and fails with ENOTDIR, a real non-EEXIST error no retry can route
    // around.
    const notADirectory = join(dir, 'not-a-directory')
    await writeFile(notADirectory, 'placeholder', 'utf8')
    const path = join(notADirectory, 'cordis.patch.yml')
    await expect(backupPatchBytes(path, Buffer.from('content'))).rejects.toThrow(
      `cordis patch file "${path}" could not be backed up before set-enabled: ENOTDIR: not a directory, open '${path}.bak-`,
    )
    // No retry occurred and nothing was silently written under `dir`: the
    // helper must special-case EEXIST only, never fall through on ENOTDIR.
    expect(await readdir(dir)).toEqual(['not-a-directory'])
  })

  it('fails loud (non-Error thrown value) when the backup file cannot be created for a reason other than it already existing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-handle-store-backup-'))
    const path = join(dir, 'cordis.patch.yml')
    fsOpenFailState.openWxFailError = 'a plain thrown string, not an Error'
    await expect(backupPatchBytes(path, Buffer.from('content'))).rejects.toThrow(
      `cordis patch file "${path}" could not be backed up before set-enabled: a plain thrown string, not an Error`,
    )
    // One shot, no retry, nothing written.
    expect(await readdir(dir)).toEqual([])
  })
})
