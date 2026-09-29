/**
 * SWD-151: the Node console exporter must write every log level to stderr,
 * never stdout — a headless or scripted `dsh` run treats stdout as its
 * task/data output channel, and an interleaved log line makes it
 * unparseable by anything piping it. Color-support detection must follow
 * the same stream, or a colored render could still land on the wrong one's
 * TTY assumption. The browser exporter is untouched by this fix (it has no
 * stdout/stderr distinction) and is covered here only as a regression guard.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleExporter } from '../src/index.ts'
import { ConsoleExporter as BrowserConsoleExporter } from '../src/browser.ts'

vi.mock('supports-color', () => ({
  default: {
    // Deliberately distinct levels so a default read from the wrong stream
    // is caught: stdout claims full truecolor support, stderr claims none.
    stdout: { level: 3, hasBasic: true, has256: true, has16m: true },
    stderr: { level: 0 },
  },
}))

function emit(ctx: Context, name = 'test'): void {
  ctx.logger(name).info('hello %s', 'world')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Node ConsoleExporter', () => {
  it('writes every accepted message to stderr, never stdout or console.log', () => {
    const ctx = new Context()
    // eslint-disable-next-line no-new -- constructing registers the exporter as a side effect
    new ConsoleExporter(ctx, { colors: false })
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    emit(ctx)

    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    const [written] = stderrWrite.mock.calls[0] as [string]
    expect(written).toContain('hello world')
    expect(written.endsWith('\n')).toBe(true)
  })

  it('renders exactly one trailing newline per message, matching render() plus a line break', () => {
    const ctx = new Context()
    const exporter = new ConsoleExporter(ctx, { colors: false, showTime: '' })
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const message: Message = { sn: 1, ts: 0, name: 'test', type: 'info', level: 2, args: ['plain message'] }
    exporter.export(message)

    expect(stderrWrite).toHaveBeenCalledWith(`${exporter.render(message)}\n`)
  })

  it('derives its default color level from stderr support, not stdout', () => {
    const ctx = new Context()
    const exporter = new ConsoleExporter(ctx)

    // The mocked supports-color reports stdout at level 3 and stderr at
    // level 0; picking up stdout's value here would mean color escapes are
    // written to a stream that (per the mock) does not support them.
    expect(exporter.colors).toBe(0)
  })
})

describe('browser ConsoleExporter (regression guard, unaffected by SWD-151)', () => {
  it('still dispatches through native console methods, not process streams', () => {
    const ctx = new Context()
    const exporter = new BrowserConsoleExporter(ctx)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    exporter.export({ sn: 1, ts: 0, name: 'test', type: 'info', level: 2, args: ['hi'] })

    expect(consoleLog).toHaveBeenCalledTimes(1)
    expect(stderrWrite).not.toHaveBeenCalled()
  })
})
