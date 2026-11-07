import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { internals, runOpen } from '../src/open.ts'

describe('runOpen (dsh open)', () => {
  const dirs: string[] = []
  const saved = { stdout: internals.stdout, stderr: internals.stderr }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    Object.assign(internals, saved)
  })

  function setup(ports: number[]) {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'dsh-open-'))
    dirs.push(runtimeDir)
    for (const port of ports) writeFileSync(join(runtimeDir, `dsh-web-relink-${String(port)}.key`), `key-${String(port)}\n`, { mode: 0o600 })
    writeFileSync(join(runtimeDir, 'unrelated.txt'), 'x')
    let out = ''
    let err = ''
    internals.stdout = { write: (t: string) => { out += t } }
    internals.stderr = { write: (t: string) => { err += t } }
    return { runtimeDir, out: () => out, err: () => err }
  }

  it('asks the only running host with its key and prints the link', async () => {
    const t = setup([3080])
    const fetchMock = vi.fn(async () => Response.json({ ok: true, code: 'code-1' }))
    expect(await runOpen({ port: undefined }, { runtimeDir: t.runtimeDir, fetch: fetchMock })).toBe(0)
    expect(t.out()).toBe('http://127.0.0.1:3080/#dsh-boot=code-1\n')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:3080/api/auth.relink')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-dsh-relink']).toBe('key-3080')
  })

  it('needs --port when several hosts run, and rejects a port with no key', async () => {
    const t = setup([3080, 3081])
    expect(await runOpen({ port: undefined }, { runtimeDir: t.runtimeDir })).toBe(2)
    expect(t.err()).toContain('3080, 3081')
    expect(await runOpen({ port: 4000 }, { runtimeDir: t.runtimeDir })).toBe(2)
    expect(t.err()).toContain('no relink key for port 4000')
  })

  it('explains each failure in plain words', async () => {
    const none = setup([])
    expect(await runOpen({ port: undefined }, { runtimeDir: none.runtimeDir })).toBe(2)
    expect(none.err()).toContain('no running dsh web host')
    const unset = setup([])
    expect(await runOpen({ port: undefined }, { runtimeDir: undefined })).toBe(2)
    expect(unset.err()).toContain('XDG_RUNTIME_DIR is not set')
    const missing = setup([])
    expect(await runOpen({ port: undefined }, { runtimeDir: join(missing.runtimeDir, 'nope') })).toBe(2)
    expect(missing.err()).toContain('cannot read')
    const down = setup([3080])
    expect(await runOpen({ port: undefined }, { runtimeDir: down.runtimeDir, fetch: (async () => { throw new Error('ECONNREFUSED') }) })).toBe(1)
    expect(down.err()).toContain('did not answer')
    const refused = setup([3080])
    expect(await runOpen({ port: undefined }, { runtimeDir: refused.runtimeDir, fetch: (async () => new Response('wrong key', { status: 401 })) })).toBe(1)
    expect(refused.err()).toContain('HTTP 401')
    const noCode = setup([3080])
    expect(await runOpen({ port: undefined }, { runtimeDir: noCode.runtimeDir, fetch: (async () => Response.json({ ok: true })) })).toBe(1)
    expect(noCode.err()).toContain('without a launch code')
  })
})
