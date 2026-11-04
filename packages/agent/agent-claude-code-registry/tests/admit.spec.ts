/**
 * The admission hook: the row's sender list and class list, applied to every mail the driver is handed,
 * failing closed when it cannot read the row.
 */

import { describe, expect, it } from 'vitest'
import type { MailAdmissionRequest } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { createAdmission } from '../src/index.ts'
import { fakeRows, row, world } from './helpers.ts'

const request = (overrides: Partial<MailAdmissionRequest> = {}): MailAdmissionRequest => ({
  seat: 'ops', from: 'peer', path: 'send', externalHops: [], tainted: false, turnTainted: false, ...overrides,
})

describe('claudeCodeMailHooks.admit', () => {
  const w = world()
  const rows = fakeRows({
    ops: row(w, { admit_from: ['peer', 'lead'], admit_sender_classes: ['seat'] }),
    open: row(w, { admit_from: ['peer', 'steve'], admit_sender_classes: ['seat', 'unverified'] }),
    nobody: row(w, { admit_from: [] }),
    bare: { cwd: w.cwd, driver: 'claude-code' },
  })
  const admit = createAdmission(() => rows)

  it('admits a listed seat sender whose class the row lists', () => {
    expect(admit(request())).toEqual({ allow: true })
    expect(admit(request({ from: 'lead', path: 'steer' }))).toEqual({ allow: true })
  })

  it('denies a sender that is not in admit_from, naming the part that failed', () => {
    const verdict = admit(request({ from: 'intruder' }))
    expect(verdict).toMatchObject({ allow: false })
    expect((verdict as { reason: string }).reason).toContain('sender "intruder" is not in admit_from')
  })

  it('denies everyone for a row with an empty or absent admit_from', () => {
    expect((admit(request({ seat: 'nobody' })) as { reason: string }).reason).toContain('admit_from is empty')
    expect(admit(request({ seat: 'bare' }))).toMatchObject({ allow: false })
  })

  it('denies an unverified sender unless the row lists that class, even when the sender is named', () => {
    const verdict = admit(request({ from: 'steve', externalHops: ['unverified'] }))
    expect(verdict).toMatchObject({ allow: false })
    expect(admit(request({ seat: 'open', from: 'steve', externalHops: ['unverified'] }))).toEqual({ allow: true })
    expect(admit(request({ seat: 'open', from: 'peer' }))).toEqual({ allow: true })
  })

  it('denies a hop class a registry row has no name for (portal, web form, anything else)', () => {
    const verdict = admit(request({ seat: 'open', externalHops: ['portal'] }))
    expect(verdict).toMatchObject({ allow: false })
    expect((verdict as { reason: string }).reason).toContain('sender class "portal" is not a class a registry row can admit')
    expect(admit(request({ seat: 'open', externalHops: ['unverified', 'stripe'] }))).toMatchObject({ allow: false })
  })

  it('denies mail that names no sender', () => {
    const { from: _from, ...anonymous } = request()
    expect((admit(anonymous) as { reason: string }).reason).toContain('names no sender')
  })

  it('fails closed on an unknown seat and on a missing row service', () => {
    expect((admit(request({ seat: 'ghost' })) as { reason: string }).reason).toContain('seat "ghost" has no current valid registry row')
    const down = createAdmission(() => undefined)
    expect((down(request()) as { reason: string }).reason).toContain('mailboxSeatRows service is not available')
  })

  it('reads the live row on every call, so a tightened row takes effect without a restart', () => {
    const live = fakeRows({ ops: row(w) })
    const hook = createAdmission(() => live)
    expect(hook(request())).toEqual({ allow: true })
    live.table['ops'] = row(w, { admit_from: [] })
    expect(hook(request())).toMatchObject({ allow: false })
  })
})
