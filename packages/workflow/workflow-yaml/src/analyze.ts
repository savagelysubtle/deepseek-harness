/**
 * `analyze()`: parse (core schema only, no anchors, aliases, or tags), validate, and describe a
 * workflow file. Never throws on bad input; every problem is a located diagnostic.
 * @module @deepseek-ai/dsh-workflow-yaml/analyze
 */

import { isAlias, isNode, LineCounter, parseDocument, visit } from 'yaml'
import type { Diagnostic } from './diagnostics.ts'
import { buildManifest, describeGraph } from './graph.ts'
import { Locator } from './locator.ts'
import type { Position } from './locator.ts'
import { sha256Hex } from './sha256.ts'
import type { AnalyzeOptions, AnalyzeResult } from './types.ts'
import { validate } from './validate.ts'

/** Default size cap: 256 KiB of UTF-8. */
export const DEFAULT_MAX_BYTES = 262_144

/** Analyze workflow YAML text. */
export function analyze(text: string, options: AnalyzeOptions = {}): AnalyzeResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const byteLength = new TextEncoder().encode(text).length
  if (byteLength > maxBytes) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error', code: 'too-large', path: [], line: 1, column: 1,
        message: `workflow file is ${byteLength} bytes; the limit is ${maxBytes} bytes`,
      }],
    }
  }

  const hash = sha256Hex(text)
  const lines = new LineCounter()
  const doc = parseDocument(text, {
    lineCounter: lines,
    schema: 'core',
    version: '1.2',
    uniqueKeys: true,
    prettyErrors: false,
  })
  const loc = new Locator(doc, lines, text)
  const diagnostics: Diagnostic[] = []
  const at = (offset: number, end: number): Position => loc.at(offset, end)
  for (const error of doc.errors) {
    diagnostics.push({ severity: 'error', code: 'parse-error', message: error.message.split('\n')[0] ?? error.message, path: [],
      ...at(error.pos[0], error.pos[1]) })
  }
  for (const warning of doc.warnings) {
    if (warning.code === 'TAG_RESOLVE_FAILED') continue
    diagnostics.push({ severity: 'warning', code: 'yaml-warning', message: warning.message.split('\n')[0] ?? warning.message, path: [],
      ...at(warning.pos[0], warning.pos[1]) })
  }
  let unsafe = doc.errors.length > 0
  visit(doc, (_key, node) => {
    if (isAlias(node)) {
      unsafe = true
      const range = node.range ?? [0, 0, 0]
      diagnostics.push({ severity: 'error', code: 'alias-not-allowed',
        message: 'YAML aliases (*name) are not allowed in workflow files; write the value out', path: [], ...at(range[0], range[1]) })
    } else if (isNode(node)) {
      if (node.anchor !== undefined) {
        unsafe = true
        const range = node.range ?? [0, 0, 0]
        const start = Math.max(0, text.lastIndexOf(`&${node.anchor}`, range[0]))
        diagnostics.push({ severity: 'error', code: 'anchor-not-allowed',
          message: `YAML anchors (&${node.anchor}) are not allowed in workflow files`, path: [], ...at(start,
            start + node.anchor.length + 1) })
      }
      if (node.tag !== undefined) {
        unsafe = true
        const range = node.range ?? [0, 0, 0]
        const shorthand = node.tag.startsWith('tag:yaml.org,2002:') ? `!!${node.tag.slice(18)}` : node.tag
        const found = text.lastIndexOf(shorthand, range[0])
        const start = found === -1 ? range[0] : found
        diagnostics.push({ severity: 'error', code: 'tag-not-allowed',
          message: `YAML tags (${shorthand}) are not allowed in workflow files`, path: [], ...at(start, start + shorthand.length) })
      }
    }
  })
  if (doc.contents === null && !unsafe) {
    diagnostics.push({ severity: 'error', code: 'empty-document', message: 'the workflow file is empty', path: [], line: 1, column: 1 })
    unsafe = true
  }
  if (unsafe) return { ok: false, hash, diagnostics: sortDiagnostics(diagnostics) }

  const result = validate(doc.toJS({ maxAliasCount: 0 }) as unknown, loc, options)
  diagnostics.push(...result.diags)
  const sorted = sortDiagnostics(diagnostics)
  const ok = !sorted.some(d => d.severity === 'error')
  if (!ok || result.doc === undefined) return { ok: false, hash, diagnostics: sorted }
  return {
    ok: true,
    hash,
    diagnostics: sorted,
    doc: result.doc,
    graph: describeGraph(result.doc),
    manifest: buildManifest(result.doc),
    locations: result.locations,
  }
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort((a, b) => a.line - b.line || a.column - b.column)
}
