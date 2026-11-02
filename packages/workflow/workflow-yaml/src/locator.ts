/**
 * Maps document paths and in-scalar offsets to 1-based line and column positions using the
 * `yaml` parser's node ranges, so every diagnostic points at the exact text the author wrote.
 * @module @deepseek-ai/dsh-workflow-yaml/locator
 */

import { isMap, isScalar, isSeq, Scalar } from 'yaml'
import type { Document, LineCounter, Node } from 'yaml'
import type { Diagnostic } from './diagnostics.ts'

/** A path from the document root. */
export type Path = (string | number)[]

/** Where a diagnostic anchors relative to a path: the key text, the value, or the container. */
export type Anchor = 'key' | 'value'

/** A located range. */
export interface Position {
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

/** Resolves paths and scalar offsets to positions. */
export class Locator {
  constructor(
    private readonly doc: Document.Parsed,
    private readonly lines: LineCounter,
    private readonly text: string,
  ) {}

  /**
   * Position of an absolute character offset.
   * @param offset - absolute character offset
   * @param end - optional absolute end offset
   * @returns the 1-based position
   */
  at(offset: number, end?: number): Position {
    const start = this.lines.linePos(offset)
    if (end === undefined) return { line: start.line, column: start.col }
    const stop = this.lines.linePos(end)
    return { line: start.line, column: start.col, endLine: stop.line, endColumn: stop.col }
  }

  private resolve(path: Path): { node: Node | null; key: Node | undefined } {
    let cur: unknown = this.doc.contents
    let key: Node | undefined
    for (const seg of path) {
      if (isMap(cur)) {
        const pair = cur.items.find(p => isScalar(p.key) && String(p.key.value) === String(seg))
        if (pair === undefined) return { node: cur, key: undefined }
        key = pair.key as Node
        cur = pair.value
      } else if (isSeq(cur)) {
        key = undefined
        cur = cur.items[seg as number]
      } else {
        return { node: cur as Node | null, key }
      }
    }
    return { node: (cur ?? null) as Node | null, key }
  }

  /**
   * Position of the key (`'key'`) or value (`'value'`) at `path`.
   * @param path - path from the document root
   * @param anchor - whether to point at the key or the value
   * @returns the 1-based position
   */
  pos(path: Path, anchor: Anchor): Position {
    const { node, key } = this.resolve(path)
    const target = anchor === 'key' ? (key ?? node) : (node ?? key)
    if (target?.range == null) return { line: 1, column: 1 }
    return this.at(target.range[0], target.range[1])
  }

  /**
   * Position of character `offset` inside the scalar at `path` (best effort for escapes).
   * @param path - path to a string scalar
   * @param offset - character offset inside the scalar value
   * @param length - span length in characters
   * @returns the 1-based position
   */
  inScalar(path: Path, offset: number, length = 1): Position {
    const { node } = this.resolve(path)
    if (node == null || !isScalar(node) || node.range == null) return this.pos(path, 'value')
    const value = typeof node.value === 'string' ? node.value : ''
    const [start, valueEnd] = node.range
    const source = this.text.slice(start, valueEnd)
    const type = node.type
    const quoted = type === Scalar.QUOTE_SINGLE || type === Scalar.QUOTE_DOUBLE
    if ((type === Scalar.PLAIN && source === value) || (quoted && source.slice(1, -1) === value)) {
      const shift = type === Scalar.PLAIN ? 0 : 1
      return this.at(start + shift + offset, start + shift + Math.min(offset + length, value.length))
    }
    if (type === Scalar.BLOCK_LITERAL) {
      const newline = source.indexOf('\n')
      if (newline !== -1) {
        const body = source.slice(newline + 1).split('\n')
        const first = body.find(line => line.trim().length > 0) ?? ''
        const indent = first.length - first.trimStart().length
        const valueLines = value.split('\n')
        let remaining = offset
        for (let i = 0; i < valueLines.length; i++) {
          const lineLength = valueLines[i]?.length ?? 0
          if (remaining <= lineLength) {
            const lineStart = start + newline + 1 + body.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0)
            const from = lineStart + indent + remaining
            return this.at(from, from + Math.min(length, lineLength - remaining))
          }
          remaining -= lineLength + 1
        }
      }
    }
    return this.pos(path, 'value')
  }

  /**
   * Build a diagnostic anchored at a path.
   * @param severity - error or warning
   * @param code - stable machine code
   * @param message - human-readable text
   * @param path - path from the document root
   * @param anchor - key or value
   * @param nodeId - owning node id, if any
   * @returns the located diagnostic
   */
  diag(
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    path: Path,
    anchor: Anchor,
    nodeId?: string,
  ): Diagnostic {
    return { severity, code, message, ...this.pos(path, anchor), ...(nodeId === undefined ? {} : { nodeId }), path }
  }
}
