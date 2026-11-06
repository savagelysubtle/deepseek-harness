import { describe, expect, it } from 'vitest'
import { checkConfigRecords } from '../src/allowlist.ts'
import type { ConfigRecord } from '../src/allowlist.ts'

const ALLOW_ALL = ['/', 'https://', 'ssh://', 'git@example.com:org/repo.git', 'example.com:repo',
  'host:/abs/path']
type Verdict = ReturnType<typeof checkConfigRecords>
const check = (records: readonly ConfigRecord[]): Verdict => checkConfigRecords(records, ALLOW_ALL)
const rec = (key: string, value?: string): ConfigRecord => ({ key, value })

describe('allowlist: keys', () => {
  it('passes the keys of a fresh clone', () => {
    expect(check([
      rec('core.repositoryformatversion', '0'), rec('core.filemode', 'true'), rec('core.bare',
        'false'),
      rec('core.logallrefupdates', 'true'), rec('core.ignorecase', 'true'),
      rec('core.precomposeunicode', 'true'), rec('core.symlinks', 'false'),
      rec('remote.origin.url', '/srv/x.git'), rec('remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*'),
      rec('branch.main.remote', 'origin'), rec('branch.main.merge', 'refs/heads/main'),
      rec('user.name', 'A'), rec('user.email', 'a@b.c'), rec('init.defaultBranch', 'main'),
    ])).toBeUndefined()
  })

  it('passes an empty record list', () => {
    expect(check([])).toBeUndefined()
  })

  it.each([
    'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.gitproxy', 'include.path',
    'includeif.gitdir:/x.path', 'filter.x.clean',
    'diff.external', 'credential.helper', 'protocol.ext.allow', 'extensions.worktreeconfig',
    'remote.o.uploadpack', 'remote.o.pushurl',
    'merge.dsh-translation-pairing.driver', 'alias.x', 'url.x.insteadof',
  ])('refuses %s and names the key', (key) => {
    expect(check([rec(key, 'x')])).toMatchObject({ code: 'config-key', key })
  })

  it('matches keys case-insensitively and names the key as git printed it', () => {
    expect(check([rec('Core.HooksPath', '/x')])).toMatchObject({ code: 'config-key',
      key: 'Core.HooksPath' })
    expect(check([rec('CORE.FileMode', 'true')])).toBeUndefined()
  })

  it('stops at the first violation', () => {
    expect(check([rec('core.filemode', 'true'), rec('core.hookspath', '/x'), rec('core.fsmonitor',
      'x')])).toMatchObject({ key: 'core.hookspath' })
  })
})

describe('allowlist: core.bare', () => {
  it.each(['false', 'FALSE', 'no', 'off', '0', ''])('accepts %j', (value) => {
    expect(check([rec('core.bare', value)])).toBeUndefined()
  })

  it.each(['true', 'yes', 'on', '1', 'maybe'])('refuses %j', (value) => {
    expect(check([rec('core.bare', value)])).toMatchObject({ code: 'config-value',
      key: 'core.bare' })
  })

  it('refuses the bare boolean (no =), which git reads as true', () => {
    expect(check([rec('core.bare')])).toMatchObject({ code: 'config-value', key: 'core.bare' })
  })
})

describe('allowlist: remote urls', () => {
  it.each([
    '/srv/x.git', '/srv/with space/x.git', 'https://example.com/a/b.git',
    'ssh://git@example.com:22/a.git', 'ssh://example.com/a', 'https://example.com',
    'git@example.com:org/repo.git', 'example.com:repo', 'host:/abs/path',
  ])('accepts %s', (value) => {
    expect(check([rec('remote.o.url', value)])).toBeUndefined()
  })

  it.each([
    ['ext::sh -c true', '::'], ['fd::5', '::'], ['https::x', '::'], ['/srv/x::y', '::'],
    ['file:///srv/x', 'must be'], ['http://example.com/x', 'must be'], ['relative/path', 'must be'],
    ['-oProxyCommand=x:y', 'must be'],
    ['ssh://-oProxyCommand=x@host/y', 'must be'], ['/srv/x\nrm', 'control character'], ['',
      'must be'],
  ])('refuses %j', (value, why) => {
    const violation = check([rec('remote.o.url', value)])
    expect(violation).toMatchObject({ code: 'config-value', key: 'remote.o.url' })
    expect(violation?.reason).toContain(why)
  })

  it('refuses a url key written without a value', () => {
    expect(check([rec('remote.o.url')])).toMatchObject({ code: 'config-value',
      reason: 'the key has no value' })
  })

  it('accepts a remote.<n>.fetch refspec and refuses a control character in it', () => {
    expect(check([rec('remote.o.fetch', '+refs/heads/*:refs/remotes/o/*')])).toBeUndefined()
    expect(check([rec('remote.o.fetch', 'a\u0007b')])).toMatchObject({ code: 'config-value',
      key: 'remote.o.fetch' })
    expect(check([rec('remote.o.fetch')])).toMatchObject({ code: 'config-value' })
  })

  it('accepts a remote name that contains dots', () => {
    expect(check([rec('remote.a.b.url', '/srv/x')])).toBeUndefined()
  })
})

describe('allowlist: branch tracking', () => {
  it('accepts a plain remote name and any merge ref', () => {
    expect(check([rec('branch.feat/x.remote', 'origin'), rec('branch.feat/x.merge',
      'refs/heads/feat/x')])).toBeUndefined()
  })

  it.each(['', '.', '-x', 'a b', '/abs', 'ext::x', 'a\nb'])('refuses branch.<n>.remote %j',
    (value) => {
      expect(check([rec('branch.main.remote', value)])).toMatchObject({ code: 'config-value',
        key: 'branch.main.remote' })
    })

  it('refuses a control character in merge and a missing value', () => {
    expect(check([rec('branch.main.merge', 'refs\u0000x')])).toMatchObject({ code: 'config-value',
      key: 'branch.main.merge' })
    expect(check([rec('branch.main.merge')])).toMatchObject({ code: 'config-value' })
    expect(check([rec('branch.main.remote')])).toMatchObject({ code: 'config-value' })
  })
})

describe('allowlist: remoteUrlAllow', () => {
  const url = (value: string): ConfigRecord[] => [rec('remote.o.url', value)]

  it('an empty list refuses every remote url, even a well-formed local path', () => {
    expect(checkConfigRecords(url('/srv/x.git'),
      [])).toMatchObject({ code: 'remote-url-not-allowed', key: 'remote.o.url' })
    expect(checkConfigRecords(url('https://example.com/x.git'),
      [])).toMatchObject({ code: 'remote-url-not-allowed' })
  })

  it('a config with no remote needs no allow list', () => {
    expect(checkConfigRecords([rec('core.filemode', 'true')], [])).toBeUndefined()
  })

  it('accepts an exact entry and refuses a longer or shorter url', () => {
    expect(checkConfigRecords(url('/srv/x.git'), ['/srv/x.git'])).toBeUndefined()
    expect(checkConfigRecords(url('/srv/x.git2'),
      ['/srv/x.git'])).toMatchObject({ code: 'remote-url-not-allowed' })
    expect(checkConfigRecords(url('/srv/x'),
      ['/srv/x.git'])).toMatchObject({ code: 'remote-url-not-allowed' })
  })

  it('accepts a prefix that ends in a slash and not one that does not', () => {
    expect(checkConfigRecords(url('https://example.com/org/repo.git'),
      ['https://example.com/org/'])).toBeUndefined()
    expect(checkConfigRecords(url('https://example.com/organisation/x'),
      ['https://example.com/org'])).toMatchObject({ code: 'remote-url-not-allowed' })
    expect(checkConfigRecords(url('https://example.com/other/x'),
      ['https://example.com/org/'])).toMatchObject({ code: 'remote-url-not-allowed' })
  })

  it('still applies the form checks first: an allowed prefix cannot launder a helper url', () => {
    expect(checkConfigRecords(url('ext::sh -c true'),
      ['ext::'])).toMatchObject({ code: 'config-value' })
  })

  it('does not apply to fetch refspecs or branch tracking', () => {
    expect(checkConfigRecords([rec('remote.o.fetch', '+refs/heads/*:refs/remotes/o/*'),
      rec('branch.m.remote', 'o')], [])).toBeUndefined()
  })
})
