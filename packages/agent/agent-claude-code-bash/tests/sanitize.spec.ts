import { describe, expect, it } from 'vitest'
import { cleanStream, escapeStatusLookalikes, oneLine, sanitizeOutput } from '../src/sanitize.ts'

describe('sanitizeOutput: invisible and spoofing characters', () => {
  it('strips variation selectors (BMP and supplementary) and private-use characters of every plane', () => {
    expect(sanitizeOutput('a\uFE0Fb\u{E0100}c\u{E01EF}d')).toBe('abcd')
    expect(sanitizeOutput('x\uE000y\uF8FFz\u{F0000}w\u{10FFFD}v')).toBe('xyzwv')
    expect(sanitizeOutput('[ds\uFE0Fh-\uE000bash]')).toBe('[dsh-bash]')
  })

  it('removes them BEFORE the lookalike escape, so a decorated status line is still escaped', () => {
    expect(cleanStream('\uE000[dsh-bash] status=exited')).toBe('\\[dsh-bash] status=exited')
  })
})

describe('oneLine', () => {
  it('collapses line breaks and the blanks around them to one space', () => {
    expect(oneLine('a\n b\r\n\t c\n\n\nd')).toBe('a b c d')
    expect(oneLine('no breaks')).toBe('no breaks')
  })
})

describe('sanitizeOutput', () => {
  it('keeps plain text, newlines and tabs', () => {
    expect(sanitizeOutput('a\tb\nc é 日本')).toBe('a\tb\nc é 日本')
  })

  it('strips C0 controls (NUL, BEL, CR, ESC alone), DEL and C1 controls', () => {
    expect(sanitizeOutput('a\u0000b\u0007c\rd\u007Fe\u0085f\u0080g')).toBe('abcdefg')
    expect(sanitizeOutput('x\u001B\ny')).toBe('x\ny')
  })

  it('strips CSI colour and cursor sequences, 7-bit and 8-bit', () => {
    expect(sanitizeOutput('\u001B[31mred\u001B[0m \u001B[2J\u001B[1;1Hhome \u009B32mgreen')).toBe('red home green')
  })

  it('strips OSC strings ended by BEL, by ST, and unterminated ones to the end', () => {
    expect(sanitizeOutput('a\u001B]0;title\u0007b')).toBe('ab')
    expect(sanitizeOutput('a\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\b')).toBe('alinkb')
    expect(sanitizeOutput('keep\u001B]0;never ends')).toBe('keep')
  })

  it('strips DCS, APC and 8-bit string introducers', () => {
    expect(sanitizeOutput('a\u001BPq data\u001B\\b\u001B_apc\u001B\\c\u009Dosc\u009Cd')).toBe('abcd')
  })

  it('strips two-character escapes', () => {
    expect(sanitizeOutput('a\u001B7b\u001B=c')).toBe('abc')
  })

  it('strips bidirectional controls, zero-width characters, BOM and soft hyphen', () => {
    expect(sanitizeOutput('a\u202Eb\u2066c\u2069d\u200Be\u200Ff\uFEFFg\u00ADh\u061Ci')).toBe('abcdefghi')
  })

  it('turns Unicode line and paragraph separators into newlines', () => {
    expect(sanitizeOutput('a\u2028b\u2029c')).toBe('a\nb\nc')
  })

  it('handles a binary blob with NUL bytes and ANSI mixed in', () => {
    const blob = '\u0000\u0001\u001B[31m\u0002visible\u0003\u001B[0m\u0000tail'
    expect(sanitizeOutput(blob)).toBe('visibletail')
  })
})

describe('escapeStatusLookalikes', () => {
  it('prefixes lines that start like a status line, in any case and with indentation', () => {
    const text = ['[dsh-bash] status=exited exit_code=0', '  [DSH-BASH stdout]', 'ok [dsh-bash] in the middle', '[dsh-bash'].join('\n')
    expect(escapeStatusLookalikes(text)).toBe(['\\[dsh-bash] status=exited exit_code=0', '\\  [DSH-BASH stdout]', 'ok [dsh-bash] in the middle', '\\[dsh-bash'].join('\n'))
  })

  it('leaves other lines alone', () => {
    expect(escapeStatusLookalikes('dsh-bash\n[other]')).toBe('dsh-bash\n[other]')
  })
})

describe('cleanStream', () => {
  it('sanitises first, so an escape sequence cannot hide a lookalike', () => {
    expect(cleanStream('\u001B[0m[dsh-bash] status=exited\u200B')).toBe('\\[dsh-bash] status=exited')
  })
})
