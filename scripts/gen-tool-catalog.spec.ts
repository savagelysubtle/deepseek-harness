/**
 * Coverage for the boot-manifest completeness guard's discovery rule
 * (`assertManifestComplete`): the guard must catch an on-disk tool package no
 * matter which of the two shapes it takes — a `tool-*` directory (the
 * original, back-compat glob) OR a package whose `exports` map declares a
 * subpath ending in `/tool` (how `@deepseek-ai/dsh-session-title/tool` and
 * `@deepseek-ai/dsh-memory/tool` are actually mounted — SWD-150). Each case
 * builds a throwaway fixture tree so it never depends on the real repo's
 * current package set.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertManifestComplete, unwrapDescription } from './gen-tool-catalog.ts'
import type { ToolPackage } from './gen-tool-catalog.ts'
import { parseMarkdown, visitMarkdown } from './markdown.ts'

/**
 * The exact invariant `scripts/verify-md-wrap.ts` enforces: no `paragraph`
 * node in the parsed tree may span more than one source line. Checking this
 * on the OUTPUT (rather than trusting the collapsing logic's own reasoning)
 * is the real test — see `.agents/notes` history: a line-heuristic version of
 * this function passed its own hand-picked cases while still producing
 * multi-line paragraph nodes on inputs the heuristic could not see.
 */
function hasMultilineParagraph(markdown: string): boolean {
  let found = false
  visitMarkdown(parseMarkdown(markdown), (node) => {
    if (node.type !== 'paragraph' || found) return
    if (node.position !== undefined && node.position.end.line > node.position.start.line) found = true
    return false
  })
  return found
}

/** A manifest entry with every field the guard needs, overridable per case. */
function toolPackage(over: Partial<ToolPackage> = {}): ToolPackage {
  return {
    pkg: '@deepseek-ai/dsh-tool-demo',
    dir: 'tool-demo',
    source: 'packages/demo/tool-demo/src/index.ts',
    requires: [],
    writes: [],
    async mount() {},
    ...over,
  }
}

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Lay out an on-disk `tool-*` package directory (no exports needed — the dir glob alone must find it). */
function writeToolDirPackage(root: string, group: string, dir: string): void {
  const pkgDir = join(root, 'packages', group, dir)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/dsh-${dir}`,
    exports: { '.': './lib/index.js' },
  }))
}

/** Lay out a package named for its DOMAIN whose `exports` map subpath-exports a tool at `./tool`. */
function writeSubpathToolPackage(root: string, group: string, dir: string, pkgName: string): void {
  const pkgDir = join(root, 'packages', group, dir)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: pkgName,
    exports: {
      '.': './lib/index.js',
      './tool': './lib/tool.js',
    },
  }))
}

describe('assertManifestComplete', () => {
  it('passes when every on-disk package (either shape) is listed', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    writeSubpathToolPackage(root, 'demo', 'demo-domain', '@deepseek-ai/dsh-demo-domain')
    const packages = [
      toolPackage({ dir: 'tool-demo' }),
      toolPackage({ pkg: '@deepseek-ai/dsh-demo-domain', dir: 'demo-domain' }),
    ]
    expect(() => { assertManifestComplete(packages, root) }).not.toThrow()
  })

  it('still catches a plain `tool-*` directory missing from the manifest (back-compat)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    expect(() => { assertManifestComplete([], root) }).toThrow('tool-demo')
  })

  it('discovers a subpath-exported tool (package.json `exports["./tool"]`) on a non-`tool-*` directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    // The domain-named directory alone would never match `packages/*/tool-*`.
    writeSubpathToolPackage(root, 'session', 'session-title', '@deepseek-ai/dsh-session-title')
    expect(() => { assertManifestComplete([], root) }).toThrow('session-title')
  })

  it('fails the guard when a subpath-exported tool is omitted from the manifest, even with the `tool-*` case covered', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    writeToolDirPackage(root, 'demo', 'tool-demo')
    writeSubpathToolPackage(root, 'memory', 'memory', '@deepseek-ai/dsh-memory')
    // Only the tool-* case is listed — the subpath-exported one is left out,
    // mirroring the exact gap this fix closes.
    const packages = [toolPackage({ dir: 'tool-demo' })]
    expect(() => { assertManifestComplete(packages, root) })
      .toThrow('gen-tool-catalog: 1 tool package(s) not in the boot manifest: memory.')
  })

  it('does not mistake an ordinary `.` main-entry package for a subpath-exported tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    const pkgDir = join(root, 'packages', 'demo', 'not-a-tool')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-not-a-tool',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
    }))
    expect(() => { assertManifestComplete([], root) }).not.toThrow()
  })

  it('tolerates an unreadable or malformed package.json instead of crashing discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-catalog-guard-'))
    roots.push(root)
    const pkgDir = join(root, 'packages', 'demo', 'broken')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{ not valid json')
    expect(() => { assertManifestComplete([], root) }).not.toThrow()
  })
})

describe('unwrapDescription', () => {
  it('collapses a hard-wrapped paragraph while leaving an adjacent fenced block byte-verbatim', () => {
    // No blank line before OR after the fence: a fenced code block can
    // interrupt a paragraph, and plain text can follow one, with neither
    // requiring a blank line — so this input has no blank lines anywhere,
    // exactly the shape a naive "collapse this blank-line-delimited block"
    // heuristic would misread as one block spanning the fence.
    const fence = ['```js', 'const x = 1;', 'const y = 2;', '```'].join('\n')
    const input = ['Some prose spanning', 'two lines here.', fence, 'Trailing prose all on one line.'].join('\n')
    const output = unwrapDescription(input)
    expect(output).toContain(fence)
    expect(output).toContain('Some prose spanning two lines here.')
    expect(output).toContain('Trailing prose all on one line.')
    expect(hasMultilineParagraph(output)).toBe(false)
  })

  it('collapses prose directly followed by a list with no blank line, leaving the list untouched', () => {
    // A bullet list can interrupt a paragraph without a blank line, so this
    // is genuinely ONE paragraph node ("Do the thing\ncarefully.") followed
    // by a separate list node — a line heuristic scanning for a list-marker
    // line anywhere in the same blank-line-delimited block would (wrongly)
    // leave the whole thing untouched.
    const input = ['Do the thing', 'carefully.', '- a', '- b'].join('\n')
    const output = unwrapDescription(input)
    expect(output).toBe(['Do the thing carefully.', '- a', '- b'].join('\n'))
    expect(hasMultilineParagraph(output)).toBe(false)
  })

  it('collapses a lazy continuation line trailing a list item', () => {
    // "trailing text" satisfies none of the block starts that could
    // interrupt a paragraph, so CommonMark's lazy-continuation rule folds it
    // into the last list item's own paragraph, making THAT paragraph node
    // span two lines — nested inside the list, not a top-level block.
    const input = ['- a', '- b', 'trailing continuation text'].join('\n')
    const output = unwrapDescription(input)
    expect(output).toBe(['- a', '- b trailing continuation text'].join('\n'))
    expect(hasMultilineParagraph(output)).toBe(false)
  })

  it('collapses a paragraph containing a mid-block `10.`-style line (only `1.` may interrupt a paragraph)', () => {
    // CommonMark lets an ordered list interrupt a paragraph only when it
    // starts at 1; "10." here is not a list marker at all — it is plain text
    // inside one two-line paragraph. A regex that treats any `\d+[.)]\s` as
    // a list marker gets this backwards and leaves a real violation wrapped.
    const input = ['Explanation text', '10. something more.'].join('\n')
    const output = unwrapDescription(input)
    expect(output).toBe('Explanation text 10. something more.')
    expect(hasMultilineParagraph(output)).toBe(false)
  })

  it('collapses a CRLF-delimited paragraph without leaving stray carriage returns', () => {
    const input = 'Line one\r\nline two continues.'
    const output = unwrapDescription(input)
    expect(output).toBe('Line one line two continues.')
    expect(output).not.toContain('\r')
    expect(hasMultilineParagraph(output)).toBe(false)
  })

  it('leaves an already-single-line paragraph containing emphasis untouched, verbatim', () => {
    const input = '*Note* this matters.'
    expect(unwrapDescription(input)).toBe(input)
    expect(hasMultilineParagraph(unwrapDescription(input))).toBe(false)
  })

  it('collapses the memory tool description\'s actual shape (packages/memory/memory/src/tool.ts)', () => {
    // Reproduced verbatim from TOOL_DESCRIPTION there: nine lines, no blank
    // line anywhere, i.e. one nine-line paragraph node.
    const input = [
      'Read, write, list, and search DURABLE project memory: plain-markdown notes scoped to',
      'the current workspace that persist across sessions, restarts, and seats — yours and',
      'your teammates\' co-edit them on disk.',
      'Use write() to record decisions, environment gotchas, session state worth carrying',
      'forward, or canonical locations; use read()/list()/search() instead of asking the user',
      'to repeat context the memory already holds. Paths are scope-relative with forward',
      'slashes (`todo/auth.md`, `spec/decisions.md`); parent traversal is rejected.',
      'Content costs prompt tokens only when you read or search it, so prefer list() first,',
      'then read() the specific entries you need.',
    ].join('\n')
    const output = unwrapDescription(input)
    expect(output).toBe(
      'Read, write, list, and search DURABLE project memory: plain-markdown notes scoped to the current workspace '
      + 'that persist across sessions, restarts, and seats — yours and your teammates\' co-edit them on disk. '
      + 'Use write() to record decisions, environment gotchas, session state worth carrying forward, or canonical '
      + 'locations; use read()/list()/search() instead of asking the user to repeat context the memory already holds. '
      + 'Paths are scope-relative with forward slashes (`todo/auth.md`, `spec/decisions.md`); parent traversal is '
      + 'rejected. Content costs prompt tokens only when you read or search it, so prefer list() first, then read() '
      + 'the specific entries you need.',
    )
    expect(hasMultilineParagraph(output)).toBe(false)
  })
})
