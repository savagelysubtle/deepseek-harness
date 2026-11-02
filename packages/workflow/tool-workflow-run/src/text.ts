/**
 * Text hygiene shared by the confirm text, approval reasons and error messages: characters that
 * can forge lines or reorder what a human reads are escaped or removed.
 * @module @deepseek-ai/dsh-tool-workflow-run/text
 */

/**
 * C0 and C1 controls, DEL, zero-width and direction marks, embedded bidi overrides and isolates,
 * line and paragraph separators, the byte order mark, soft hyphen, joiners and invisible format
 * characters (U+2060-206F), variation selectors and tag characters.
 */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufe00-\\ufe0f\\u{e0000}-\\u{e007f}]', 'gu')

/**
 * Escape every unsafe character as `\xNN` or `\uNNNN`, so the text stays reviewable and cannot
 * forge lines or reorder what follows it.
 * @param text - arbitrary text.
 * @returns single-line text with no unsafe character.
 */
export function escapeUnsafe(text: string): string {
  return text.replace(UNSAFE, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
  })
}

/**
 * Replace every unsafe character with a space, collapse the whitespace and cap the length.
 * @param text - arbitrary text, for example a human's free-text reason.
 * @param max - the most characters kept.
 * @returns the cleaned text.
 */
export function stripUnsafe(text: string, max: number): string {
  const flat = text.replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s'"`)\]]+|\/(?:[^\s'"`)\]/]+\/)+[^\s'"`)\]/]*)/g

/**
 * Reduce an engine or script error to what is safe to show a model: the first line only, absolute
 * host paths replaced, unsafe characters escaped, and the length capped. The full text belongs in the log.
 * @param text - the raw error text, possibly a stack trace.
 * @param max - the most characters kept.
 * @returns a short, path-free, single-line message.
 */
export function modelFacingError(text: string, max = 300): string {
  const first = text.split('\n', 1)[0] ?? ''
  const clean = escapeUnsafe(first.replace(ABSOLUTE_PATH, '<path>')).trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean
}
