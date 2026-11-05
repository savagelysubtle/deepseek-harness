/**
 * The example profile patch parses, its driver and tools-provider rows pass their packages' own Config schemas, and the glue
 * row carries no config (host config is founder-owned; the registry row carries routing and admission only).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import * as Driver from '@deepseek-ai/dsh-agent-claude-code-driver'
import * as Tools from '@deepseek-ai/dsh-agent-claude-code-tools'

interface Row {
  id: string
  name: string
  config?: Record<string, unknown>
}

function rows(): Row[] {
  const parsed = yaml.load(readFileSync(fileURLToPath(new URL('./fixtures/profile.cordis.patch.yml', import.meta.url)), 'utf8'))
  if (!Array.isArray(parsed)) throw new TypeError('the patch must parse to a list')
  return (parsed as Array<{ insert?: Row[] }>).flatMap(patch => patch.insert ?? [])
}

describe('profile.cordis.patch.yml', () => {
  it('inserts the driver row, the tools provider row and the glue row, in that order', () => {
    expect(rows().map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-agent-claude-code-driver',
      '@deepseek-ai/dsh-agent-claude-code-tools',
      '@deepseek-ai/dsh-agent-claude-code-registry',
    ])
  })

  it('gives the driver row a Config the driver accepts, with the host seat under an allowed prefix', () => {
    const config = Driver.Config((rows()[0] as Row).config as never)
    expect(config.stateDir).toBe('claude-code')
    const prefixes = config.claudePathPrefixes ?? []
    expect(prefixes).toHaveLength(1)
    const seat = config.hostSeats?.['mail-triage']
    expect(seat).toMatchObject({ role: 'mail-only', model: 'haiku', admit_from_ceiling: ['ops-lead'], max_turns: 20, fable_ok: false })
    expect(seat?.claude_path.startsWith(`${prefixes[0] as string}/`)).toBe(true)
    expect(seat?.session_id).toBeUndefined()
  })

  it('gives the tools provider row a Config the provider accepts', () => {
    const config = Tools.Config((rows()[1] as Row).config as never)
    expect(config.policyDir).toBe('/home/me/.dsh/claude-code/policy')
    expect(config.nodePath).toBeUndefined()
    expect(config.guardPath).toBeUndefined()
    expect(Tools.name).toBe('agent-claude-code-tools')
  })

  it('gives the registry glue row no config at all', () => {
    const glue = rows()[2] as Row
    expect('config' in glue).toBe(false)
  })
})
