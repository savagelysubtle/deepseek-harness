import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isGroupAlive, killProcessGroup, ProcessLedger, readBootId, readProcessStartTime, SYSTEM_PROCESS_OPS,
} from '../src/ledger.ts'
import type { LedgerEntry } from '../src/ledger.ts'
import { cleanTempDirs, ledgerOps, tempDir } from './fakes.ts'

afterEach(() => { cleanTempDirs() })

/** A ledger in a fresh private directory; `table` maps live pids to their start times. */
function fresh(table: Map<number, string>, killed: number[] = [], extra: Parameters<typeof ledgerOps>[2] = {}) {
  const file = join(tempDir('cc-ledger-'), 'nested', 'pids.json')
  return { file, ledger: new ProcessLedger(file, ledgerOps(table, killed, extra)) }
}

const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
  seat: 's', pid: 10, startTime: 'tick-1', hostPid: 500, hostStartTime: 'host-1', bootId: 'boot-1', ...overrides,
})

describe('process ledger records', () => {
  it('records host pid, host start time and boot id, keeps several entries per seat, and replaces only the same pid', () => {
    const { ledger } = fresh(new Map([[10, 'a'], [11, 'b'], [777, 'host-tick']]))
    expect(ledger.entries()).toEqual([])
    ledger.record('seat-a', 10)
    ledger.record('seat-a', 11)
    ledger.record('seat-b', 11)
    ledger.record('seat-a', 10)
    expect(ledger.entries().map(row => [row.seat, row.pid])).toEqual([['seat-a', 11], ['seat-b', 11], ['seat-a', 10]])
    expect(ledger.entries()[0]).toEqual({ seat: 'seat-a', pid: 11, startTime: 'b', hostPid: 777, hostStartTime: 'host-tick', bootId: 'boot-1' })
    ledger.clear('seat-a', 10)
    expect(ledger.entries()).toHaveLength(2)
    ledger.clear('seat-a', 99)
    ledger.clear('seat-a', 11)
    expect(ledger.entries().map(row => row.seat)).toEqual(['seat-b'])
  })

  it('writes a private directory (0700) and file (0600), leaving no temporary file behind', () => {
    const { file, ledger } = fresh(new Map([[10, 'a']]))
    ledger.record('s', 10)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700)
    expect(readFileSync(file, 'utf8')).toContain('"seat":"s"')
  })

  it('stores an empty start time when it cannot be read, and an empty host start time too', () => {
    const { ledger } = fresh(new Map(), [], { hostPid: 5 })
    ledger.record('unknown', 77)
    expect(ledger.entries()[0]).toMatchObject({ startTime: '', hostStartTime: '', hostPid: 5 })
  })
})

describe('process ledger reaping', () => {
  const seed = (ledger: ProcessLedger, file: string, rows: LedgerEntry[]) => {
    ledger.record('seed', 1)
    writeFileSync(file, JSON.stringify(rows), { mode: 0o600 })
  }

  it('kills a child whose boot id, start time and (dead) owner all check out, and drops the entries', () => {
    const killed: number[] = []
    const { file, ledger } = fresh(new Map([[10, 'tick-1']]), killed)
    seed(ledger, file, [entry({ seat: 'same' })])
    expect(ledger.reapStale()).toEqual({ reaped: ['same'], stale: [], skipped: [], survivors: [], failed: [] })
    expect(killed).toEqual([10])
    expect(ledger.entries()).toEqual([])
  })

  it('reaps entries written by an earlier incarnation of this same host pid', () => {
    const killed: number[] = []
    const { file, ledger } = fresh(new Map([[10, 'tick-1'], [777, 'host-tick']]), killed)
    seed(ledger, file, [entry({ hostPid: 777, hostStartTime: 'host-tick' })])
    expect(ledger.reapStale().reaped).toEqual(['s'])
    expect(killed).toEqual([10])
  })

  it('never acts on an entry from an earlier boot, a recycled pid, a gone child, or an unknown start time', () => {
    const killed: number[] = []
    const { file, ledger } = fresh(new Map([[11, 'tick-999'], [13, 'tick-1']]), killed)
    seed(ledger, file, [
      entry({ seat: 'old-boot', pid: 13, bootId: 'boot-0' }),
      entry({ seat: 'recycled', pid: 11 }),
      entry({ seat: 'gone', pid: 12 }),
      entry({ seat: 'unknown', pid: 13, startTime: '' }),
    ])
    const report = ledger.reapStale()
    expect(report.stale).toEqual(['old-boot', 'recycled', 'gone', 'unknown'])
    expect(report.reaped).toEqual([])
    expect(killed).toEqual([])
  })

  it('skips and keeps an entry whose owning host is still alive and is not this process', () => {
    const killed: number[] = []
    const { file, ledger } = fresh(new Map([[10, 'tick-1'], [500, 'host-1']]), killed)
    seed(ledger, file, [entry({ seat: 'theirs' }), entry({ seat: 'ownerless', pid: 10, hostStartTime: '' }), entry({ seat: 'owner-recycled', hostStartTime: 'host-OTHER' })])
    const report = ledger.reapStale()
    expect(report.skipped).toEqual(['theirs'])
    expect(report.reaped).toEqual(['ownerless', 'owner-recycled'])
    expect(ledger.entries().map(row => row.seat)).toEqual(['theirs'])
    expect(killed).toEqual([10, 10])
  })

  it('reports survivors of a dead leader without killing them, and keeps going after one kill fails', () => {
    const killed: number[] = []
    const { file, ledger } = fresh(new Map([[10, 'tick-1'], [14, 'tick-1']]), killed, {
      groupAlive: pid => pid === 12,
      killGroup: (pid) => {
        if (pid === 10) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        killed.push(pid)
      },
    })
    seed(ledger, file, [
      entry({ seat: 'denied', pid: 10 }),
      entry({ seat: 'orphaned-members', pid: 12 }),
      entry({ seat: 'ok', pid: 14 }),
    ])
    expect(ledger.reapStale()).toEqual({
      reaped: ['ok'], stale: [], skipped: [], survivors: ['orphaned-members'], failed: ['denied'],
    })
    expect(killed).toEqual([14])
  })
})

describe('process ledger file trust', () => {
  it('ignores malformed entries, including legacy entries without host fields', () => {
    const { file, ledger } = fresh(new Map())
    ledger.record('x', 1)
    writeFileSync(file, JSON.stringify([entry({ seat: 'ok' }), { seat: 'legacy', pid: 5, startTime: 't' }, { seat: 1 }, null, 'str']))
    expect(ledger.entries().map(row => row.seat)).toEqual(['ok'])
  })

  it.each(['{}', '{not json', ''])('names the path and the remedy for a corrupt ledger (%j)', (content) => {
    const { file, ledger } = fresh(new Map())
    ledger.record('x', 1)
    writeFileSync(file, content)
    expect(() => ledger.entries()).toThrow(new RegExp(`process ledger ${file.replaceAll('.', '\\.')} is corrupt.*pgrep -f claude.*delete the file`))
    expect(readFileSync(file, 'utf8')).toBe(content)
  })

  it('rethrows a read error that is not "missing"', () => {
    const { file, ledger } = fresh(new Map())
    ledger.record('x', 1)
    chmodSync(file, 0o000)
    try {
      expect(() => ledger.entries()).toThrow(/EACCES/)
    } finally {
      chmodSync(file, 0o600)
    }
  })

  it('refuses a ledger path that is a directory, a file open to others, a foreign-owned file, or a bad directory', () => {
    const directory = tempDir()
    expect(() => new ProcessLedger(directory).entries()).toThrow(/not a regular file/)
    const { file, ledger } = fresh(new Map())
    ledger.record('x', 1)
    chmodSync(file, 0o644)
    expect(() => ledger.entries()).toThrow(/accessible by group or others/)
    chmodSync(file, 0o600)
    const foreign = new ProcessLedger(file, ledgerOps(new Map(), []), (process.getuid?.() ?? 0) + 1)
    expect(() => foreign.entries()).toThrow(/owned by uid/)
    const dir = join(file, '..')
    chmodSync(dir, 0o755)
    expect(() => { ledger.record('y', 2) }).toThrow(/accessible by group or others/)
    chmodSync(dir, 0o700)
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'file'), 'not a directory')
    expect(() => new ProcessLedger(join(dir, 'sub', 'file', 'x.json')).entries()).toThrow(/ENOTDIR/)
  })
})

describe('process facts', () => {
  it('reads this process start time and boot id, and tolerates missing pids and files', () => {
    if (process.platform === 'linux') {
      expect(readProcessStartTime(process.pid)).toMatch(/^\d+$/)
      expect(readBootId()).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(SYSTEM_PROCESS_OPS.bootId()).toBe(readBootId())
    expect(SYSTEM_PROCESS_OPS.hostPid).toBe(process.pid)
    expect(readProcessStartTime(2 ** 30)).toBeUndefined()
    expect(readBootId(join(tempDir(), 'missing'))).toBe('')
  })

  it('kills groups tolerantly and rethrows anything but "already gone"', () => {
    expect(() => { killProcessGroup(2 ** 30) }).not.toThrow()
    for (const pid of [0, 1, -5, 1.5]) expect(() => { killProcessGroup(pid) }).not.toThrow()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) })
    try {
      expect(() => { killProcessGroup(4242) }).toThrow('not permitted')
    } finally {
      kill.mockRestore()
    }
  })

  it('probes a process group with signal 0: ESRCH is gone, EPERM is alive, a quiet success is alive, junk pids are not groups', () => {
    for (const pid of [0, 1, -5, 1.5]) expect(isGroupAlive(pid)).toBe(false)
    expect(isGroupAlive(2 ** 30)).toBe(false)
    const kill = vi.spyOn(process, 'kill')
    try {
      kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
      expect(isGroupAlive(4242)).toBe(true)
      kill.mockImplementation(() => true)
      expect(isGroupAlive(4242)).toBe(true)
      expect(kill).toHaveBeenLastCalledWith(-4242, 0)
    } finally {
      kill.mockRestore()
    }
  })
})
