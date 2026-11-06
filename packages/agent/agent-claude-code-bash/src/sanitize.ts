/**
 * Output sanitiser: what a program printed is cleaned before the model reads it. Terminal escape
 * sequences, control characters and invisible formatting characters are removed, and any program line that
 * looks like a host status line is escaped, so program output cannot pass for the status the host wrote.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-bash/sanitize
 */

import { ESCAPE_PREFIX, STATUS_MARKER } from './limits.ts'

/** OSC (`ESC ]` ... BEL or ST), DCS/SOS/PM/APC strings (`ESC P|X|^|_` ... ST) and their 8-bit introducers. */
const STRING_SEQUENCE = /(?:\u001B[\]PX^_]|[\u0090\u0098\u009D\u009E\u009F])[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C|$)/gu

/** CSI sequences (`ESC [` or the 8-bit introducer, parameters, intermediates, a final byte). */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]?/gu

/** The remaining two-character escapes (`ESC` followed by a single character). */
const SHORT_ESCAPE = /\u001B[ -~]?/gu

/**
 * Every control character except newline and tab (C0, DEL and C1), all format characters (bidi, zero width, BOM,
 * soft hyphen, tags), the private-use characters (BMP and planes 15 and 16) and the variation selectors.
 */
const UNWANTED = /[^\P{Cc}\n\t]|\p{Cf}|\p{Co}|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu

/** Unicode line and paragraph separators read as line breaks by many renderers. */
const SEPARATORS = /[\u2028\u2029]/gu

/** A line break and the blanks around it. */
const LINE_BREAK = /\s*[\r\n]+\s*/gu

/** A program line that would read as a host status line (optionally indented, any case). */
const LOOKALIKE = new RegExp(`^([ \\t]*)(${STATUS_MARKER.replaceAll('[', '\\[')})`, 'gimu')

/**
 * Remove terminal escape sequences, control characters (except newline and tab) and Unicode format characters
 * (bidirectional controls, zero-width characters, the byte-order mark), private-use characters and variation selectors.
 * Incomplete escape sequences are removed to the end of the text; a lone ESC is removed.
 * @param text - program output.
 * @returns the cleaned text.
 */
export function sanitizeOutput(text: string): string {
  return text
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(SHORT_ESCAPE, '')
    .replace(SEPARATORS, '\n')
    .replace(UNWANTED, '')
}

/**
 * Escape every line that starts like a host status line, so a program cannot print one. Escaped lines are
 * prefixed with a backslash.
 * @param text - already sanitised program output.
 * @returns the text with lookalike lines escaped.
 */
export function escapeStatusLookalikes(text: string): string {
  return text.replace(LOOKALIKE, `${ESCAPE_PREFIX}$1$2`)
}

/**
 * Collapse every line break (and the blanks around it) to one space, so text the host writes into a status line
 * can never start a second line.
 * @param text - host-side text, for example an error message.
 * @returns the text on one line.
 */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAK, ' ')
}

/**
 * The full cleaning of one output stream: sanitise, then escape lookalike lines.
 * @param text - what the program printed.
 * @returns the text the model may read.
 */
export function cleanStream(text: string): string {
  return escapeStatusLookalikes(sanitizeOutput(text))
}
