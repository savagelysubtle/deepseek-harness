/**
 * Built packages must not import raw .ts across package boundaries because
 * Node's strip-only loader cannot execute parameter properties (found
 * 2026-11-06 in agent-claude-code-driver).
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const forbiddenSpecifier = /^@deepseek-ai\/dsh-[a-z0-9-]+\/src\//
const excludedFragments = ['/tests/', '.spec.ts', '.e2e.ts', 'node_modules', 'lib/']
const fromImportPattern = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/
const bareImportPattern = /\bimport\s*['"]([^'"]+)['"]/
const importPattern = new RegExp(
  `${fromImportPattern.source}|${dynamicImportPattern.source}|${bareImportPattern.source}`,
  'gs',
)

const paths = globSync(['packages/**/*.ts', 'apps/**/*.ts'], { cwd: root })
  .sort()
  .filter(relative => !excludedFragments.some(fragment => relative.includes(fragment)))

const failures: string[] = []
for (const relative of paths) {
  const source = stripComments(readFileSync(resolve(root, relative), 'utf8'))
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier === undefined || !forbiddenSpecifier.test(specifier)) continue
    failures.push(`${relative}:${lineOf(source, match.index)}: imports ${specifier}`)
  }
}

if (failures.length > 0) {
  console.error('verify-no-cross-package-src-imports: cross-package src imports found:')
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

console.log(`verify-no-cross-package-src-imports: OK (${paths.length} files)`)

function stripComments(content: string): string {
  let stripped = ''
  let index = 0
  while (index < content.length) {
    const character = content[index] ?? ''
    const next = content[index + 1] ?? ''
    if (character === '/' && next === '*') {
      const end = content.indexOf('*/', index + 2)
      const stop = end === -1 ? content.length : end + 2
      stripped += content.slice(index, stop).replace(/[^\n]/g, ' ')
      index = stop
      continue
    }
    if (character === '/' && next === '/') {
      const stop = content.indexOf('\n', index)
      const lineEnd = stop === -1 ? content.length : stop
      stripped += ' '.repeat(lineEnd - index)
      index = lineEnd
      continue
    }
    stripped += character
    index += 1
  }
  return stripped
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}
