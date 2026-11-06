import { describe, expect, it } from 'vitest'
import { checkConfigRecords } from '../src/allowlist.ts'
import type { ConfigRecord } from '../src/allowlist.ts'

const rec = (key: string, value?: string): ConfigRecord => ({ key, value })

describe('allowlist: keys', () => {
  it('passes the keys of a fresh clone', () => {
    expect(checkConfigRecords([
      rec('core.repositoryformatversion', '0'), rec('core.filemode', 'true'), rec('core.bare', 'false'),
      rec('core.logallrefupdates', 'true'), rec('core.ignorecase', 'true'), rec('core.precomposeunicode', 'true'), rec('core.symlinks', 'false'),
      rec('remote.origin.url', '/srv/x.git'), rec('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'),
      rec('branch.main.remote', 'origin'), rec('branch.main.merge', 'refs/heads/main'),
      rec('user.name', 'A'), rec('user.email', 'a@b.c'), rec('init.defaultBranch', 'main'),
    ])).toBeUndefined()
  })

  it('passes an empty record list', () => {
    expect(checkConfigRecords([])).toBeUndefined()
  })

  it.each([
    'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.gitproxy', 'include.path', 'includeif.gitdir:/x.path', 'filter.x.clean',
    'diff.external', 'credential.helper', 'protocol.ext.allow', 'extensions.worktreeconfig', 'remote.o.uploadpack', 'remote.o.pushurl',
    'merge.dsh-translation-pairing.driver', 'alias.x', 'url.x.insteadof',
  ])('refuses %s and names the key', (key) => {
    expect(checkConfigRecords([rec(key, 'x')])).toMatchObject({ code: 'config-key', key })
  })

  it('matches keys case-insensitively and names the key as git printed it', () => {
    expect(checkConfigRecords([rec('Core.HooksPath', '/x')])).toMatchObject({ code: 'config-key', key: 'Core.HooksPath' })
    expect(checkConfigRecords([rec('CORE.FileMode', 'true')])).toBeUndefined()
  })

  it('stops at the first violation', () => {
    expect(checkConfigRecords([rec('core.filemode', 'true'), rec('core.hookspath', '/x'), rec('core.fsmonitor', 'x')])).toMatchObject({ key: 'core.hookspath' })
  })
})

describe('allowlist: core.bare', () => {
  it.each(['false', 'FALSE', 'no', 'off', '0', ''])('accepts %j', (value) => {
    expect(checkConfigRecords([rec('core.bare', value)])).toBeUndefined()
  })

  it.each(['true', 'yes', 'on', '1', 'maybe'])('refuses %j', (value) => {
    expect(checkConfigRecords([rec('core.bare', value)])).toMatchObject({ code: 'config-value', key: 'core.bare' })
  })

  it('refuses the bare boolean (no =), which git reads as true', () => {
    expect(checkConfigRecords([rec('core.bare')])).toMatchObject({ code: 'config-value', key: 'core.bare' })
  })
})

describe('allowlist: remote urls', () => {
  it.each([
    '/srv/x.git', '/srv/with space/x.git', 'https://example.com/a/b.git', 'ssh://git@example.com:22/a.git', 'ssh://example.com/a', 'https://example.com',
    'git@example.com:org/repo.git', 'example.com:repo', 'host:/abs/path',
  ])('accepts %s', (value) => {
    expect(checkConfigRecords([rec('remote.o.url', value)])).toBeUndefined()
  })

  it.each([
    ['ext::sh -c true', '::'], ['fd::5', '::'], ['https::x', '::'], ['/srv/x::y', '::'],
    ['file:///srv/x', 'must be'], ['http://example.com/x', 'must be'], ['relative/path', 'must be'], ['-oProxyCommand=x:y', 'must be'],
    ['ssh://-oProxyCommand=x@host/y', 'must be'], ['/srv/x\nrm', 'control character'], ['', 'must be'],
  ])('refuses %j', (value, why) => {
    const violation = checkConfigRecords([rec('remote.o.url', value)])
    expect(violation).toMatchObject({ code: 'config-value', key: 'remote.o.url' })
    expect(violation?.reason).toContain(why)
  })

  it('refuses a url key written without a value', () => {
    expect(checkConfigRecords([rec('remote.o.url')])).toMatchObject({ code: 'config-value', reason: 'the key has no value' })
  })

  it('accepts a remote.<n>.fetch refspec and refuses a control character in it', () => {
    expect(checkConfigRecords([rec('remote.o.fetch', '+refs/heads/*:refs/remotes/o/*')])).toBeUndefined()
    expect(checkConfigRecords([rec('remote.o.fetch', 'a\u0007b')])).toMatchObject({ code: 'config-value', key: 'remote.o.fetch' })
    expect(checkConfigRecords([rec('remote.o.fetch')])).toMatchObject({ code: 'config-value' })
  })

  it('accepts a remote name that contains dots', () => {
    expect(checkConfigRecords([rec('remote.a.b.url', '/srv/x')])).toBeUndefined()
  })
})

describe('allowlist: branch tracking', () => {
  it('accepts a plain remote name and any merge ref', () => {
    expect(checkConfigRecords([rec('branch.feat/x.remote', 'origin'), rec('branch.feat/x.merge', 'refs/heads/feat/x')])).toBeUndefined()
  })

  it.each(['', '.', '-x', 'a b', '/abs', 'ext::x', 'a\nb'])('refuses branch.<n>.remote %j', (value) => {
    expect(checkConfigRecords([rec('branch.main.remote', value)])).toMatchObject({ code: 'config-value', key: 'branch.main.remote' })
  })

  it('refuses a control character in merge and a missing value', () => {
    expect(checkConfigRecords([rec('branch.main.merge', 'refs\u0000x')])).toMatchObject({ code: 'config-value', key: 'branch.main.merge' })
    expect(checkConfigRecords([rec('branch.main.merge')])).toMatchObject({ code: 'config-value' })
    expect(checkConfigRecords([rec('branch.main.remote')])).toMatchObject({ code: 'config-value' })
  })
})
