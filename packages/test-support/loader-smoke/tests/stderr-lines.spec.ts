import { describe, expect, it } from 'vitest'
import { nonConsoleExporterStderrLines } from '@deepseek-ai/dsh-loader-smoke'

const bootLine = (severity: string, rest: string): string => `2026-09-29 12:00:00 [${severity}] loader ${rest}`

describe('nonConsoleExporterStderrLines', () => {
  it('returns an empty array for empty input', () => {
    expect(nonConsoleExporterStderrLines('')).toEqual([])
  })

  it('drops empty lines produced by a trailing newline', () => {
    const stderr = `${bootLine('I', 'booted')}\n`
    expect(nonConsoleExporterStderrLines(stderr)).toEqual([])
  })

  it('allows an [I] line through by default and keeps an unrecognized line', () => {
    const stderr = [bootLine('I', 'booted subagent tool'), 'not a log line at all'].join('\n')
    expect(nonConsoleExporterStderrLines(stderr)).toEqual(['not a log line at all'])
  })

  it('keeps [W] and [E] lines unallowed by default, and a [D] line the shape also matches', () => {
    const stderr = [
      bootLine('I', 'expected boot noise'),
      bootLine('W', 'unexpected warning'),
      bootLine('E', 'unexpected error'),
      bootLine('D', 'debug detail'),
    ].join('\n')

    expect(nonConsoleExporterStderrLines(stderr)).toEqual([
      bootLine('W', 'unexpected warning'),
      bootLine('E', 'unexpected error'),
      bootLine('D', 'debug detail'),
    ])
  })

  it('widens the allow list for a scenario with a documented expected warning', () => {
    const stderr = [bootLine('I', 'booted'), bootLine('W', 'expected background warning')].join('\n')

    expect(nonConsoleExporterStderrLines(stderr, { allow: ['I', 'W'] })).toEqual([])
  })

  it('narrowing the allow list makes a normally-expected [I] line unexpected', () => {
    const stderr = bootLine('I', 'booted')

    expect(nonConsoleExporterStderrLines(stderr, { allow: ['W'] })).toEqual([bootLine('I', 'booted')])
  })

  it('treats a CRLF-split line as not matching the exporter shape, keeping it', () => {
    const stderr = `${bootLine('I', 'booted')}\r\n`
    expect(nonConsoleExporterStderrLines(stderr)).toEqual([`${bootLine('I', 'booted')}\r`])
  })
})
