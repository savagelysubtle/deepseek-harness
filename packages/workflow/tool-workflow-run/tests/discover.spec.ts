import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listWorkflowNames, readWorkflowByName, readWorkflowByPath, WorkflowFileError } from '../src/index.ts'

let ws: string
let outside: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'wfdisc-ws-'))
  outside = await mkdtemp(join(tmpdir(), 'wfdisc-out-'))
  await mkdir(join(ws, '.workflows'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('discovery', () => {
  it('lists only valid kebab-case yaml files, sorted', async () => {
    for (const f of ['b-two.yaml', 'a.yaml', 'Bad_Name.yaml', 'notes.txt']) await writeFile(join(ws, '.workflows', f), 'x')
    expect(await listWorkflowNames(ws, '.workflows')).toEqual(['a', 'b-two'])
  })

  it('returns an empty list when the directory does not exist', async () => {
    expect(await listWorkflowNames(ws, 'nope')).toEqual([])
  })

  it('reads by name and by path', async () => {
    await writeFile(join(ws, '.workflows', 'a.yaml'), 'hello')
    expect((await readWorkflowByName(ws, '.workflows', 'a')).text).toBe('hello')
    expect((await readWorkflowByPath(ws, '.workflows', '.workflows/a.yaml')).name).toBe('a')
  })

  it('rejects bad names, traversal, and paths outside the directory', async () => {
    await expect(readWorkflowByName(ws, '.workflows', '../x')).rejects.toBeInstanceOf(WorkflowFileError)
    await expect(readWorkflowByName(ws, '.workflows', 'Upper')).rejects.toThrow(/invalid/)
    await expect(readWorkflowByPath(ws, '.workflows', '../x.yaml')).rejects.toBeInstanceOf(WorkflowFileError)
    await writeFile(join(ws, 'top.yaml'), 'x')
    await expect(readWorkflowByPath(ws, '.workflows', 'top.yaml')).rejects.toThrow(/outside/)
  })

  it('refuses a symlink that escapes the workspace', async () => {
    await writeFile(join(outside, 'evil.yaml'), 'x')
    await symlink(join(outside, 'evil.yaml'), join(ws, '.workflows', 'evil.yaml'))
    await expect(readWorkflowByName(ws, '.workflows', 'evil')).rejects.toThrow(/outside/)
    await rm(join(ws, '.workflows'), { recursive: true })
    await symlink(outside, join(ws, '.workflows'))
    await expect(listWorkflowNames(ws, '.workflows')).rejects.toThrow(/outside the workspace/)
  })
})
