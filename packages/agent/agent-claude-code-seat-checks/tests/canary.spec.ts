import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GuardProbe, GuardProbeResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBootCanary, selfTestCloneChecker } from '../src/canary.ts'
import type { CloneInspectDeps } from '../src/clone-state.ts'
import { realCloneFs } from '../src/fingerprint.ts'
import { realRunGit } from '../src/git-config.ts'
import type { RunGit } from '../src/git-config.ts'
import { errorWithCode, GIT, okResult, tempRoot } from './helpers.ts'
import type { TempRoot } from './helpers.ts'

let box: TempRoot
beforeEach(() => { box = tempRoot() })
afterEach(() => { box.cleanup() })

const OK: GuardProbeResult = { ok: true, nodeSha256: 'a'.repeat(64), guardSha256: 'b'.repeat(64),
  policySha256: 'c'.repeat(64) }
const real: CloneInspectDeps = { gitPath: GIT, run: realRunGit, fs: realCloneFs,
  remoteUrlAllow: ['/srv/'] }

describe('runBootCanary', () => {
  it('passes the per-hook timeout to the probe and returns its result unchanged', async () => {
    const probe = vi.fn((_signal?: AbortSignal, _timeoutMs?: number) => Promise.resolve(OK))
    expect(await runBootCanary({ probe } satisfies GuardProbe, 1234)).toBe(OK)
    expect(probe).toHaveBeenCalledWith(undefined, 1234)
  })

  it('returns a failed result unchanged', async () => {
    const failed: GuardProbeResult = { ok: false, code: 'exit', reason: 'wrong exit code' }
    expect(await runBootCanary({ probe: () => Promise.resolve(failed) }, 10)).toBe(failed)
  })

  it('maps a rejecting probe to code error (the service is supposed never to reject)', async () => {
    expect(await runBootCanary({ probe: () => Promise.reject(new Error('bang')) },
      10)).toEqual({ ok: false, code: 'error', reason: 'bang' })
    const reason: unknown = 'text'
    expect(await runBootCanary({ probe: () => { throw reason } }, 10)).toEqual({ ok: false,
      code: 'error', reason: 'text' })
  })
})

describe('selfTestCloneChecker', () => {
  it('passes with real git and leaves no temporary directory behind', () => {
    expect(() => { selfTestCloneChecker(real, box.root) }).not.toThrow()
    expect(readdirSync(box.root)).toEqual([])
  })

  it('fails naming the scenario when the checker accepts a hostile clone', () => {
    // A runner that reports a clean config whatever the file holds cannot see the config-based
    // hostile scenarios.
    const blind: RunGit = () => okResult('core.filemode\ntrue\0')
    expect(() => { selfTestCloneChecker({ ...real,
      run: blind }) }).toThrow(/scenario "core\.hooksPath" expected config-key but got a pass/)
  })

  it('fails when the checker refuses the clean clone', () => {
    const paranoid: RunGit = () => okResult('core.hookspath\n/x\0')
    expect(() => { selfTestCloneChecker({ ...real,
      run: paranoid }) }).toThrow(/scenario "clean clone" expected a pass but got config-key/)
  })

  it('fails when a hostile scenario is refused for the wrong reason', () => {
    const wrong: RunGit = (gitPath, args) => (
      readFileSync(args[2] as string,
        'utf8').includes('hooksPath') ? okResult('core.bare\ntrue\0') : realRunGit(gitPath, args)
    )
    expect(() => { selfTestCloneChecker({ ...real, run: wrong }) })
      .toThrow(/scenario "core\.hooksPath" expected config-key but got config-value/)
  })

  it.each([
    ['git-missing', 'ENOENT'], ['timeout', 'ETIMEDOUT'], ['enobufs', 'ENOBUFS'], ['eacces',
      'EACCES'],
  ])('propagates the environment failure %s instead of reporting a wrong verdict', (code,
    errno) => {
    const run: RunGit = () => ({ error: errorWithCode(errno), signal: null, status: null,
      stdout: '', stderr: '' })
    expect(() => { selfTestCloneChecker({ ...real,
      run }) }).toThrow(expect.objectContaining({ code }))
  })

  it.each([
    ['git-signal', { signal: 'SIGKILL' as const, status: null }], ['git-exit', { status: 2 }],
    ['git-stderr', { stderr: 'x' }],
    ['git-error', { error: errorWithCode('EIO') }], ['parse', { stdout: '' }],
  ])('propagates %s', (code, over) => {
    const run: RunGit = () => ({ ...okResult('core.filemode\ntrue\0'), ...over })
    expect(() => { selfTestCloneChecker({ ...real,
      run }) }).toThrow(expect.objectContaining({ code }))
  })

  it('propagates an unexpected non-check error and still cleans up', () => {
    const run: RunGit = () => { throw new TypeError('not a check error') }
    expect(() => { selfTestCloneChecker({ ...real, run }, box.root) }).toThrow(TypeError)
    expect(readdirSync(box.root)).toEqual([])
  })

  it('works through a wrapper script that behaves like git (sanity of the harness)', () => {
    const script = join(box.root, 'git')
    writeFileSync(script, '#!/bin/sh\nexec /usr/bin/git "$@"\n')
    chmodSync(script, 0o755)
    expect(existsSync(script)).toBe(true)
    expect(() => { selfTestCloneChecker({ ...real, gitPath: script }) }).not.toThrow()
  })
})
