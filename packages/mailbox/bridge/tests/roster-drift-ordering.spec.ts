/**
 * SWD-118 ordering guarantee: the roster-drift alarm's registry read must
 * never be able to delay the bridge's actual job of serving mail. Mocks
 * `loadRegistrySeatNames` to a promise that never settles — the stalled
 * filesystem read `checkRosterDrift`'s try/catch cannot help with, since
 * nothing throws — and proves the poll cycle is already live (the inline
 * first drain ran, and the interval keeps firing further drains) while that
 * read is still outstanding and `apply()` itself has not resolved.
 *
 * Mocking the whole `@deepseek-ai/dsh-mailbox` package (kept to this one
 * file) is what lets the never-resolving promise be expressed at all: real
 * disk I/O has no reliable way to "start and never finish" inside a test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'
import type { MailboxMessageId } from '@deepseek-ai/dsh-mailbox'

vi.mock('@deepseek-ai/dsh-mailbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mailbox')>()
  return {
    ...actual,
    // Never resolves and never rejects: the stalled-read case a thrown
    // error cannot express (see scripts/dev-web.ts's `--poll` rationale for
    // why a network-mounted read stalling rather than failing is real here).
    loadRegistrySeatNames: vi.fn(() => new Promise<never>(() => {})),
  }
})

// Imported after the mock so this module's own `loadRegistrySeatNames`
// import resolves to the mocked one above.
const bridge = await import('../src/index.ts')

describe('roster-drift ordering: the alarm never gates the bridge\'s real job', () => {
  it('keeps draining on schedule while the registry read never settles, and apply() itself stays pending', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(MailboxRegistry, { defaultProvider: 'local' })
      let claimCalls = 0
      ctx.mailbox.registerProvider({
        name: 'local',
        publish: async () => 'id' as MailboxMessageId,
        claim: async () => { claimCalls++; return [] },
        claimableAddresses: async () => [],
        settle: async () => {},
        lookupByTraceId: async () => [],
        lookupInboundSince: async () => [],
      })

      let mountSettled = false
      void bridge.apply(ctx, {
        addresses: ['target'],
        orgRegistryPath: '/nonexistent/roster-drift-ordering-registry.yml',
        pollIntervalMs: 5,
      }).then(() => { mountSettled = true })

      // Flush the microtask chain through the inline first drain, the timer
      // and effect setup, and into the hung `checkRosterDrift` await —
      // without advancing real or fake time yet.
      await vi.advanceTimersByTimeAsync(0)
      const claimsAfterMount = claimCalls
      expect(claimsAfterMount).toBeGreaterThanOrEqual(1)
      expect(mountSettled).toBe(false)

      // Advance past several poll intervals: the interval timer set up
      // BEFORE the roster-drift await must keep firing regardless.
      await vi.advanceTimersByTimeAsync(30)
      expect(claimCalls).toBeGreaterThan(claimsAfterMount)

      // The alarm's own await is still hanging on the mocked registry read;
      // apply() — and thus a caller's `await ctx.plugin(bridge, ...)` —
      // never gets to see that as blocking the bridge's actual service.
      expect(mountSettled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
