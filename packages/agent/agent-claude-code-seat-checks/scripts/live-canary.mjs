#!/usr/bin/env node
/**
 * S7 live canary (OP-292): proves the seat checks against the REAL node binary, the REAL built
 * guard copy and the
 * REAL git. Model-free and network-free: it never starts a Claude CLI, never touches ~/.dsh, the
 * registry, a mailbox
 * store or a live seat, and works only inside one throwaway directory it removes at the end.
 *
 * What it does, in order:
 * 1. mounts the policy provider (real node, real `lib/seat-guard.js`) and records
 * `readiness().missing`;
 * 2. mounts the seat checks (guard probe through `/bin/sh`, checker self-test, registrations) and
 * records the log lines
 * and the new `readiness().missing` (expected: only `sandbox`, which the bash package provides);
 *   3. runs the guard probe once more by hand and prints its attested hashes;
 * 4. makes a real `git clone --no-hardlinks` clone and shows the clone check pass it, then refuse a
 * planted
 * `reference-transaction` hook, a `core.hooksPath` key and a `config.worktree`, each with its code;
 * 5. shows `extend()` refusing a coder (sandbox is not mounted here) with the readiness error text.
 * What it does NOT prove: that the Claude CLI invokes the hook or honours exit 2 (that is
 * `live-probe.mjs` at S8).
 *
 * Usage (from the repo root, after `pnpm run build:lib:host`):
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     packages/agent/agent-claude-code-seat-checks/scripts/live-canary.mjs
 * Exit code 0 when every expectation held, 1 otherwise.
 *
 * @module live-canary
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as Tools from '@deepseek-ai/dsh-agent-claude-code-tools'
import { assertCloneHookState, mountSeatChecks } from '../lib/index.js'

const GIT = '/usr/bin/git'
const failures = []
const say = (line) => { console.log(line) }
const expect = (label, ok, detail = '') => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const git = (cwd, ...args) => execFileSync(GIT, ['-c', 'user.name=canary', '-c',
  'user.email=canary@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8' })
const refusal = (fn) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-live-canary-')))
const remoteUrlAllow = [`${root}/`]
try {
  const ctx = new Context()
  const lines = []
  for (const level of ['info', 'warn',
    'error']) ctx.logger[level] = (message) => { lines.push(`${level}: ${String(message)}`) }
  const policyDir = join(root, 'policy')
  await ctx.plugin(Tools, Tools.Config({ policyDir, home: root, nodePath: process.execPath,
    guardPath: Tools.guardScriptPath() }))
  const policy = ctx.get('claudeCodePolicy')
  say(`node   ${process.execPath}`)
  say(`guard  ${Tools.guardScriptPath()}`)
  say(`before readiness().missing = ${JSON.stringify(policy.readiness().missing)}`)
  expect('before the seat checks, canary and rules-hooks are missing', ['sandbox', 'canary',
    'rules-hooks'].every(id => policy.readiness().missing.includes(id)))

  const mounted = await mountSeatChecks(ctx, { remoteUrlAllow })
  for (const line of lines) say(`  log ${line}`)
  say(`after  readiness().missing = ${JSON.stringify(policy.readiness().missing)}`)
  expect('the seat checks mounted', mounted === true)
  expect('only sandbox is still missing (the bash package provides it)',
    JSON.stringify(policy.readiness().missing) === '["sandbox"]')
  expect('no error was logged', !lines.some(line => line.startsWith('error:')))

  const probe = await ctx.claudeCodeGuardProbe.probe()
  say(`probe  ${JSON.stringify(probe)}`)
  expect('a second guard probe passes with attested hashes', probe.ok === true
    && /^[0-9a-f]{64}$/.test(probe.guardSha256))

  const source = join(root, 'source')
  const clone = join(root, 'clone')
  execFileSync(GIT, ['init', '-q', source])
  writeFileSync(join(source, 'file.txt'), 'x\n')
  git(source, 'add', 'file.txt')
  git(source, 'commit', '-q', '-m', 'init')
  execFileSync(GIT, ['clone', '-q', '--no-hardlinks', source, clone])
  expect('a real `git clone --no-hardlinks` clone passes the clone check',
    refusal(() => assertCloneHookState(clone, { remoteUrlAllow })) === undefined)

  const hook = join(clone, '.git', 'hooks', 'reference-transaction')
  writeFileSync(hook, '#!/bin/sh\nexit 0\n')
  chmodSync(hook, 0o755)
  const hookRefusal = refusal(() => assertCloneHookState(clone, { remoteUrlAllow }))
  expect('a planted reference-transaction hook is refused', hookRefusal?.code === 'hook-entry',
    hookRefusal?.code)
  rmSync(hook)

  git(clone, 'config', 'core.hooksPath', '/tmp/nowhere')
  const keyRefusal = refusal(() => assertCloneHookState(clone, { remoteUrlAllow }))
  expect('a core.hooksPath key is refused', keyRefusal?.code === 'config-key', keyRefusal?.code)
  say(`  reason: ${keyRefusal?.reason}`)
  git(clone, 'config', '--unset', 'core.hooksPath')

  writeFileSync(join(clone, '.git', 'config.worktree'), '[core]\n')
  const worktreeRefusal = refusal(() => assertCloneHookState(clone, { remoteUrlAllow }))
  expect('a config.worktree file is refused', worktreeRefusal?.code === 'forbidden-entry',
    worktreeRefusal?.code)
  rmSync(join(clone, '.git', 'config.worktree'))
  expect('the cleaned clone passes again', refusal(() => assertCloneHookState(clone,
    { remoteUrlAllow })) === undefined)

  const emptyList = refusal(() => assertCloneHookState(clone))
  expect('an empty remoteUrlAllow refuses the clone (fail closed)',
    emptyList?.code === 'remote-url-not-allowed', emptyList?.code)

  const extendRefusal = refusal(() => policy.extend({ seat: 'live-canary', role: 'coder',
    cwd: clone }))
  say(`  extend(coder): ${extendRefusal?.message}`)
  expect('extend() still refuses a coder, naming only sandbox',
    String(extendRefusal?.message).includes('missing: sandbox'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

say(failures.length === 0
  ? '\nlive canary: ALL PASS'
  : `\nlive canary: ${failures.length} FAILED: ${failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
