import { describe, expect, it } from 'vitest'
import { createDirectoryTool } from '../../src/mcp/directory.ts'
import { makeContext, textOf } from './helpers.ts'

describe('mailbox_directory', () => {
  it('lists exactly the send_to names and does not taint', async () => {
    const context = makeContext({ sendTo: ['ops-lead', 'sam'] })
    const result = await createDirectoryTool(context).handler({})
    expect(textOf(result)).toBe('Seats you may mail:\n- ops-lead\n- sam')
    expect(context.marks).toEqual([])
  })

  it('says so, naming the key, when send_to is empty', async () => {
    const result = await createDirectoryTool(makeContext({ sendTo: [] })).handler({})
    expect(textOf(result)).toContain('key send_to')
  })

  it('scrubs its output', async () => {
    const result = await createDirectoryTool(makeContext({ sendTo: ['a\u0000b', '/home/op/x'] })).handler({})
    expect(textOf(result)).toBe('Seats you may mail:\n- ab\n- [path]')
  })

  it('rejects any input key', async () => {
    expect((await createDirectoryTool(makeContext()).handler({ seat: 'x' })).isError).toBe(true)
  })
})
