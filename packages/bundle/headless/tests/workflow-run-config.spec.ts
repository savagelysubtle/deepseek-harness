/**
 * Guard: the headless bundle must configure `tool-workflow-run` as headless, so an approval node is
 * rejected at once instead of holding the workspace writer lock for the whole approval window.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  config?: Record<string, unknown>
}

describe('dsh-headless workflow_run config', () => {
  it('overrides the base tool-workflow-run row with headless: true', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../cordis.patch.yml')
    const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new TypeError('headless patch must parse to a list')
    const row = (parsed as PatchRow[]).find(candidate => candidate.id === 'tool-workflow-run')
    expect(row?.config?.['headless']).toBe(true)
  })
})
