/**
 * Latent mount-ordering fault: sibling loader entries mount CONCURRENTLY
 * (`Promise.allSettled` over the group — `vendor/loader/src/config/group.ts`),
 * so nothing in a profile's row order guarantees `@deepseek-ai/dsh-mailbox-local`
 * registers its `local` provider before `mailbox-bridge`'s own `apply()` runs
 * its deliberately inline first drain (see the doc comment on `apply()` in
 * `../src/index.ts`). Without a real `inject` edge on `mailboxLocal`, a
 * composition where the local provider is slow to register makes the bridge
 * lose that race and fail its mount outright, throwing out of
 * `MailboxRegistry`'s `resolveDefault` (`../../mailbox/src/index.ts`).
 *
 * This goes through the REAL Loader/Include machinery rather than calling
 * `bridge.apply()` directly (the way `roster-drift-ordering.spec.ts` does for
 * an unrelated ordering question): the race under test lives in Cordis's own
 * concurrent sibling mounting and its fiber-pending `inject` wait
 * (`vendor/cordis/src/fiber.ts`), neither of which a direct `apply()` call
 * exercises — that would skip straight past the very mechanism this test
 * proves.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import MailboxLocal from '@deepseek-ai/dsh-mailbox-local'
import * as bridge from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Mount `dsh-mailbox`, a deliberately slow-to-register local provider, and
 * `dsh-mailbox-bridge` as concurrent siblings through the real Loader.
 * `agents` is stubbed synchronously on the root context, before the Loader
 * even starts, so it can never be the source of a race — this composition
 * isolates the ONE race under test, the local provider's registration.
 *
 * The local provider is wrapped in a tiny synthetic plugin that awaits a real
 * `setTimeout` gap before constructing the actual `MailboxLocal` class, so
 * the sibling-registration delay is real async time passing through the real
 * loader, not a mock standing in for it.
 * @param localDelayMs - artificial delay before the real `MailboxLocal`
 *   constructs and registers the `local` provider on `ctx.mailbox`.
 */
async function bootMountOnly(localDelayMs: number): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-mailbox-bridge-mount-ordering-'))
  roots.push(configDir)

  const delayedLocalPath = join(configDir, 'delayed-local.mjs')
  await writeFile(delayedLocalPath, [
    'export const name = "test-mailbox-local-delayed"',
    'export const inject = ["mailbox"]',
    'export async function apply(ctx, config) {',
    `  await new Promise((resolve) => { setTimeout(resolve, ${localDelayMs}) })`,
    '  await globalThis.__mountRealMailboxLocal(ctx, config)',
    '}',
    '',
  ].join('\n'))

  const configPath = join(configDir, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-mailbox'",
    '  config:',
    '    defaultProvider: local',
    `- name: ${JSON.stringify(pathToFileURL(delayedLocalPath).href)}`,
    '  config:',
    '    path: ":memory:"',
    "- name: '@deepseek-ai/dsh-mailbox-bridge'",
    '  config:',
    '    addresses: ["target"]',
    '    pollIntervalMs: 5',
    // Never the operator's real ~/.dsh/org/registry.yml — a test that reads
    // live operator state is both flaky and a way to mutate it by accident.
    // The path does not exist, which `checkRosterDrift` already treats as
    // "nothing to check" and never warns about (see its own doc comment).
    `    orgRegistryPath: ${JSON.stringify(join(configDir, 'nonexistent-registry.yml'))}`,
    '',
  ]
  await writeFile(configPath, rows.join('\n'))

  const globals = globalThis as unknown as {
    __mountRealMailboxLocal?: (ctx: ContextType, config: unknown) => Promise<unknown>
  }
  globals.__mountRealMailboxLocal = async (ctx, config) => { await ctx.plugin(MailboxLocal, config as never) }

  const ctx = new Context()
  // Stubbed directly on the root, synchronously, before the Loader ever
  // starts: this test isolates the `mailboxLocal` race specifically, and
  // `agents` readiness must not be a second, unrelated source of flakiness.
  ctx.provide('agents', {} as never)
  ctx.baseUrl = pathToFileURL(configDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-mailbox', MailboxRegistry],
    ['@deepseek-ai/dsh-mailbox-bridge', bridge],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (modules.has(specifier)) return modules.get(specifier)
      if (specifier.startsWith('file:')) return import(specifier) as Promise<unknown>
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  try {
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('mailbox-bridge mount ordering: the sibling race on the local provider', () => {
  it(
    'mounts successfully even when the local provider is slow to register, because `mailboxLocal` is a real inject edge',
    { timeout: 30_000 },
    async () => {
      // The local provider takes 200ms to register. Without the `mailboxLocal`
      // edge, the bridge's `apply()` would start as soon as `mailbox` and
      // `agents` are ready — both near-instant here — and its inline first
      // drain would call into `ctx.mailbox` well before the provider exists.
      // With the edge, `apply()` cannot even start until `mailboxLocal`
      // itself is live, which happens only once the real `MailboxLocal`
      // constructor has already run (and, in the same synchronous
      // constructor, already registered the `local` provider — see the
      // edge's doc comment in `../src/index.ts` for why that ordering is
      // guaranteed, not incidental).
      await expect(bootMountOnly(200)).resolves.toBeUndefined()
    },
  )
})
