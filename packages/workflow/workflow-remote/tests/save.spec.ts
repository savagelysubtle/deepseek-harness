import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '@deepseek-ai/dsh-workflow-yaml'
import { saveWorkflowFile } from '../src/index.ts'
import { DEMO, setupRemote } from './support.ts'
import type { Remote } from './support.ts'

let h: Remote | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const demo = (name: string): string => DEMO.replace('name: demo', `name: ${name}`)

describe('save durability warning', () => {
  it('a failed folder flush after the publish is a successful save with a warning', async () => {
    h = await setupRemote()
    const result = await saveWorkflowFile(h.workspace, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null },
      { syncDirectory: () => { throw new Error('EIO') } })
    expect(result).toMatchObject({ ok: true, token: sha256Hex(demo('fresh')) })
    expect(result).toHaveProperty('warning')
    expect(JSON.stringify(result)).not.toContain('EIO')
    expect(await readFile(join(h.workspace, '.workflows', 'fresh.yaml'), 'utf8')).toBe(demo('fresh'))
  })
})

describe('save containment', () => {
  it('creates a new file with a null token and replaces it only with the current token', async () => {
    h = await setupRemote()
    const created = await saveWorkflowFile(h.workspace, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null })
    expect(created).toMatchObject({ ok: true, token: sha256Hex(demo('fresh')) })
    expect(await readFile(join(h.workspace, '.workflows', 'fresh.yaml'), 'utf8')).toBe(demo('fresh'))
    const edited = `${demo('fresh')}# edit\n`
    const replaced = await saveWorkflowFile(h.workspace, '.workflows', { name: 'fresh', text: edited, expectedToken: sha256Hex(demo('fresh')) })
    expect(replaced).toMatchObject({ ok: true, token: sha256Hex(edited) })
    expect(await readFile(join(h.workspace, '.workflows', 'fresh.yaml'), 'utf8')).toBe(edited)
  })

  it('creates the workflows directory when the workspace has none', async () => {
    h = await setupRemote()
    const bare = await h.scratch()
    expect(await saveWorkflowFile(bare, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null })).toMatchObject({ ok: true })
    expect(await readdir(join(bare, '.workflows'))).toEqual(['fresh.yaml'])
  })

  it('a null token on an existing file is a conflict that names the current token and writes nothing', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const result = await saveWorkflowFile(h.workspace, '.workflows', { name: 'demo', text: `${DEMO}# other\n`, expectedToken: null })
    expect(result).toMatchObject({ ok: false, error: 'CONFLICT', conflict: true, currentToken: sha256Hex(DEMO) })
    expect(await readFile(join(h.workspace, '.workflows', 'demo.yaml'), 'utf8')).toBe(DEMO)
  })

  it('a stale or missing-file token is a conflict', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'demo', text: demo('demo'), expectedToken: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, conflict: true, currentToken: sha256Hex(DEMO) })
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'gone', text: demo('gone'), expectedToken: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, error: 'CONFLICT', conflict: true })
  })

  it.each(['../evil', '..', 'a/b', '/etc/passwd', 'Upper', 'a--b', '-a', 'a_b', '', 'x'.repeat(65), 'a.yaml', 'a\0b'])(
    'refuses the name %j and writes nothing',
    async (name) => {
      h = await setupRemote()
      const result = await saveWorkflowFile(h.workspace, '.workflows', { name, text: demo('evil'), expectedToken: null })
      expect(result).toMatchObject({ ok: false, error: 'INVALID_NAME' })
      expect(await readdir(join(h.workspace, '.workflows'))).toEqual([])
      expect(await readdir(h.workspace)).toEqual(['.workflows'])
    },
  )

  it('refuses a symlinked workflows directory that leaves the workspace', async () => {
    h = await setupRemote()
    const outside = await h.scratch()
    const bare = await h.scratch()
    await symlink(outside, join(bare, '.workflows'))
    const result = await saveWorkflowFile(bare, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null })
    expect(result).toMatchObject({ ok: false, error: 'REFUSED' })
    expect(await readdir(outside)).toEqual([])
    expect(JSON.stringify(result)).not.toContain(outside)
  })

  it('refuses a dangling workflows-directory symlink without creating anything outside', async () => {
    h = await setupRemote()
    const bare = await h.scratch()
    const outside = join(await h.scratch(), 'made-by-attacker')
    await symlink(outside, join(bare, '.workflows'))
    const result = await saveWorkflowFile(bare, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null })
    expect(result.ok).toBe(false)
    await expect(readdir(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a target that is a symlink, even to a file inside the workspace', async () => {
    h = await setupRemote()
    await writeFile(join(h.workspace, 'real.txt'), 'keep')
    await symlink(join(h.workspace, 'real.txt'), join(h.workspace, '.workflows', 'linked.yaml'))
    const result = await saveWorkflowFile(h.workspace, '.workflows', { name: 'linked', text: demo('linked'), expectedToken: null })
    expect(result).toMatchObject({ ok: false, error: 'REFUSED' })
    expect(await readFile(join(h.workspace, 'real.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a target symlink pointing outside the workspace', async () => {
    h = await setupRemote()
    const outside = await h.scratch()
    await writeFile(join(outside, 'secret.yaml'), 'keep')
    await symlink(join(outside, 'secret.yaml'), join(h.workspace, '.workflows', 'escape.yaml'))
    const result = await saveWorkflowFile(h.workspace, '.workflows', { name: 'escape', text: demo('escape'), expectedToken: sha256Hex('keep') })
    expect(result).toMatchObject({ ok: false, error: 'REFUSED' })
    expect(await readFile(join(outside, 'secret.yaml'), 'utf8')).toBe('keep')
  })

  it('refuses invalid YAML with located diagnostics and leaves the directory untouched', async () => {
    h = await setupRemote()
    const result = await saveWorkflowFile(h.workspace, '.workflows', { name: 'bad', text: 'version: 1\nname: bad\nnodes: nope\n', expectedToken: null })
    expect(result).toMatchObject({ ok: false, error: 'DIAGNOSTICS' })
    if (!result.ok) expect(result.diagnostics?.[0]).toMatchObject({ severity: 'error', line: expect.any(Number) as number })
    expect(await readdir(join(h.workspace, '.workflows'))).toEqual([])
  })

  it('refuses a name that differs from the document name, oversize text, and NUL', async () => {
    h = await setupRemote()
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'other', text: demo('demo'), expectedToken: null })).toMatchObject({ ok: false, error: 'DIAGNOSTICS' })
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'big', text: 'x'.repeat(300_000), expectedToken: null })).toMatchObject({ ok: false, error: 'TOO_LARGE' })
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'nul', text: `${demo('nul')}\0`, expectedToken: null })).toMatchObject({ ok: false, error: 'INVALID_INPUT' })
    expect(await saveWorkflowFile(h.workspace, '.workflows', { name: 'tok', text: demo('tok'), expectedToken: 'not-a-token' })).toMatchObject({ ok: false, error: 'INVALID_INPUT' })
  })

  it('two creators racing for one name: exactly one wins', async () => {
    h = await setupRemote()
    const results = await Promise.all([1, 2, 3, 4].map(n => saveWorkflowFile(h!.workspace, '.workflows',
      { name: 'race', text: `${demo('race')}# ${n}\n`, expectedToken: null })))
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok && r.error === 'CONFLICT')).toHaveLength(3)
  })

  it('two writers presenting the same token: exactly one wins', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const token = sha256Hex(DEMO)
    const results = await Promise.all([1, 2, 3].map(n => saveWorkflowFile(h!.workspace, '.workflows',
      { name: 'demo', text: `${DEMO}# ${n}\n`, expectedToken: token })))
    expect(results.filter(r => r.ok)).toHaveLength(1)
  })
})

describe('save atomicity', () => {
  it('a crash after the temp file is written and before it is published leaves the old file whole', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const dir = join(h.workspace, '.workflows')
    let tempSeen: string[] = []
    await expect(saveWorkflowFile(h.workspace, '.workflows',
      { name: 'demo', text: `${DEMO}# new\n`, expectedToken: sha256Hex(DEMO) },
      {
        afterTempWritten: async () => {
          tempSeen = (await readdir(dir)).filter(f => f.endsWith('.tmp'))
          throw new Error('simulated crash')
        },
      })).rejects.toThrow('simulated crash')
    expect(tempSeen).toHaveLength(1)
    expect(await readFile(join(dir, 'demo.yaml'), 'utf8')).toBe(DEMO)
    expect(await readdir(dir)).toEqual(['demo.yaml'])
  })

  it('a crash while creating leaves no file at all', async () => {
    h = await setupRemote()
    const dir = join(h.workspace, '.workflows')
    await expect(saveWorkflowFile(h.workspace, '.workflows', { name: 'fresh', text: demo('fresh'), expectedToken: null },
      { afterTempWritten: () => { throw new Error('simulated crash') } })).rejects.toThrow('simulated crash')
    expect(await readdir(dir)).toEqual([])
  })

  it('a leftover temp file from a real crash is never listed as a workflow', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    await writeFile(join(h.workspace, '.workflows', '.demo.deadbeef.tmp'), 'torn')
    await mkdir(join(h.workspace, '.workflows', '.x.tmpdir'))
    const listed = await h.service.list(h.agent())
    expect(listed).toMatchObject({ ok: true })
    if (listed.ok) expect(listed.workflows.map(w => w.name)).toEqual(['demo'])
  })

  it('keeps the mode of the file it replaces', async () => {
    h = await setupRemote()
    await h.writeWorkflow('demo', DEMO)
    const { chmod, stat } = await import('node:fs/promises')
    await chmod(join(h.workspace, '.workflows', 'demo.yaml'), 0o640)
    await saveWorkflowFile(h.workspace, '.workflows', { name: 'demo', text: `${DEMO}# m\n`, expectedToken: sha256Hex(DEMO) })
    expect((await stat(join(h.workspace, '.workflows', 'demo.yaml'))).mode & 0o777).toBe(0o640)
  })
})
