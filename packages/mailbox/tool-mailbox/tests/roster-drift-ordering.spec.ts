/**
 * SWD-118 ordering guarantee: the roster-drift alarm's registry read must
 * never be able to delay this mount's actual job of making the mailbox
 * tools callable. Mocks `loadRegistrySeatNames` to a promise that never
 * settles — the stalled filesystem read `checkRosterDrift`'s try/catch
 * cannot help with, since nothing throws — and proves all four tools are
 * already registered while that read is still outstanding and `apply()`
 * itself has not resolved.
 *
 * Mocking the whole `@deepseek-ai/dsh-mailbox` package (kept to this one
 * file) is what lets the never-resolving promise be expressed at all: real
 * disk I/O has no reliable way to "start and never finish" inside a test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import MailboxRegistry from '@deepseek-ai/dsh-mailbox'

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
const tool = await import('../src/index.ts')

describe('roster-drift ordering: the alarm never gates this mount\'s real job', () => {
  it('registers all four mailbox tools while the registry read is still outstanding, and apply() itself stays pending', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MailboxRegistry, {})

    let mountSettled = false
    void ctx.plugin(tool, {
      addresses: ['target'],
      orgRegistryPath: '/nonexistent/roster-drift-ordering-registry.yml',
    }).then(() => { mountSettled = true })

    // A short real delay: `ctx.plugin` schedules `apply` through Cordis's
    // own fiber/inject machinery, not a plain function call, so a fixed
    // number of microtask ticks is not reliably enough to flush it — unlike
    // the bridge's ordering test, which calls `apply` directly.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ctx.tools.get('mailbox_send')).toBeDefined()
    expect(ctx.tools.get('mailbox_check_inbox')).toBeDefined()
    expect(ctx.tools.get('mailbox_await')).toBeDefined()
    expect(ctx.tools.get('mailbox_directory')).toBeDefined()

    // The alarm's own await is still hanging on the mocked registry read;
    // apply() — and thus a caller's `await ctx.plugin(tool, ...)` — never
    // gets to see that as blocking the tools becoming callable.
    expect(mountSettled).toBe(false)
  })
})
