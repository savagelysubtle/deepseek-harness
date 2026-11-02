import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config } from '@deepseek-ai/dsh-llm-deepseek'

// OP-205: the settings service validates a plugin Config by CALLING the schema
// directly (not through `~standard`), then rejects with the raw error and logs
// invalid stored sections. A credential pasted into a wrongly shaped slot must
// reach neither the rejection (message or stack) nor the logger.
const SECRET = 'sk-FAKE-0123456789abcdef'
const NS = settingsNamespace('llm-deepseek')

/** Minimal real provider that also lets a test publish an externally edited document. */
class TestProvider extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }

  publishDocument(doc: Record<string, unknown>): void {
    this.publish(doc)
  }
}

async function boot() {
  const ctx = new Context()
  const logged: string[] = []
  for (const level of ['warn', 'error', 'info'] as const) {
    vi.spyOn(ctx.logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(args.map(arg => inspect(arg, { depth: 6 })).join(' '))
    }) as never)
  }
  await ctx.plugin(TestProvider)
  const provider = ctx.get('settings') as TestProvider
  provider.register(NS, Config, { base: { baseURL: 'https://example.invalid' } })
  return { ctx, provider, logged }
}

/** Run a rejecting write and assert nothing it surfaces carries the canary. */
async function expectRedacted(run: () => Promise<void>): Promise<void> {
  const error = await run().then(() => undefined, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  const failure = error as Error
  expect(failure.message).toMatch(/expected \w+ \(received value withheld\)/)
  expect(failure.message).not.toContain(SECRET)
  expect(String(failure.stack)).not.toContain(SECRET)
}

describe('settings service validating a guarded Config', () => {
  it('canary: the raw schema call still echoes the value', () => {
    const call = Config as unknown as (data: unknown) => unknown
    expect(() => call({ models: SECRET })).toThrow(/expected array \(received value withheld\)/)
  })

  it('update withholds the value from the rejection and the logger', async () => {
    const { provider, logged } = await boot()
    await expectRedacted(() => provider.update(NS, { models: SECRET }))
    expect(logged.join('\n')).not.toContain(SECRET)
  })

  it('replace withholds the value from the rejection and the logger', async () => {
    const { provider, logged } = await boot()
    await expectRedacted(() => provider.replace(NS, { models: { nested: [SECRET] } }))
    expect(logged.join('\n')).not.toContain(SECRET)
  })

  it('mutate withholds the value from the rejection and the logger', async () => {
    const { provider, logged } = await boot()
    await expectRedacted(() => provider.mutate(NS, [{ op: 'set', path: ['apiKeyEnv'], value: [SECRET, 'x'] }]))
    expect(logged.join('\n')).not.toContain(SECRET)
  })

  it('withholds the value from the log when an invalid section arrives from storage', async () => {
    const { provider, logged } = await boot()
    provider.publishDocument({ [NS]: { models: SECRET } })
    const text = logged.join('\n')
    expect(text).toContain('keeping last good')
    expect(text).not.toContain(SECRET)
  })
})
