/**
 * The two boot proofs. The guard canary asks the tools package's `claudeCodeGuardProbe` to run the real hook
 * command and wraps it with a timeout; the checker self-test builds throwaway clones in a temporary directory and
 * requires the clone check to pass the clean one and refuse every hostile one for the expected reason. Neither
 * needs a model or the network. The canary proves the generated command denies through `/bin/sh`; it does NOT
 * prove the Claude CLI invokes the hook or honours exit 2 (that is the S8 live probe).
 *
 * @module @deepseek-ai/dsh-agent-claude-code-seat-checks/canary
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloneCheckError } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { GuardProbe, GuardProbeResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { inspectCloneState } from './clone-state.ts'
import type { CloneInspectDeps } from './clone-state.ts'

const SELF_TEST_SEAT = 'dsh-checker-selftest'

/**
 * Run the guard probe with the configured per-hook timeout. Never rejects.
 * @param probe - the `claudeCodeGuardProbe` service.
 * @param timeoutMs - the longest each hook run of the probe may take.
 * @returns the probe result (a timed-out run is reported by the probe as code `timeout`).
 */
export async function runBootCanary(probe: GuardProbe, timeoutMs: number): Promise<GuardProbeResult> {
  try {
    return await probe.probe(undefined, timeoutMs)
  } catch (error: unknown) {
    return { ok: false, code: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

const CLEAN_CONFIG = [
  '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
  '[remote "origin"]', '\turl = /srv/example.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[branch "main"]', '\tremote = origin', '\tmerge = refs/heads/main', '',
].join('\n')

interface Scenario {
  readonly name: string
  readonly expect: string | undefined
  readonly build: (git: string) => void
}

const appendConfig = (git: string, text: string): void => { writeFileSync(join(git, 'config'), `${CLEAN_CONFIG}${text}\n`) }

const SCENARIOS: readonly Scenario[] = [
  { name: 'clean clone', expect: undefined, build: () => {} },
  { name: 'core.hooksPath', expect: 'config-key', build: (git) => { appendConfig(git, '[core]\n\thooksPath = /tmp/hooks') } },
  { name: 'filter driver', expect: 'config-key', build: (git) => { appendConfig(git, '[filter "x"]\n\tclean = /bin/true') } },
  { name: 'include.path', expect: 'config-key', build: (git) => { appendConfig(git, '[include]\n\tpath = /tmp/extra') } },
  { name: 'remote uploadpack', expect: 'config-key', build: (git) => { appendConfig(git, '[remote "o"]\n\tuploadpack = /bin/true') } },
  { name: 'core.bare true', expect: 'config-value', build: (git) => { appendConfig(git, '[core]\n\tbare = true') } },
  { name: 'remote helper url', expect: 'config-value', build: (git) => { appendConfig(git, '[remote "o"]\n\turl = ext::sh -c true') } },
  {
    name: 'executable pre-commit',
    expect: 'hook-entry',
    build: (git) => {
      writeFileSync(join(git, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(git, 'hooks', 'pre-commit'), 0o755)
    },
  },
  { name: 'reference-transaction', expect: 'hook-entry', build: (git) => { writeFileSync(join(git, 'hooks', 'reference-transaction'), '#!/bin/sh\n') } },
  { name: 'config.worktree', expect: 'forbidden-entry', build: (git) => { writeFileSync(join(git, 'config.worktree'), '[core]\n') } },
  {
    name: 'symlinked config',
    expect: 'config-not-regular',
    build: (git) => {
      writeFileSync(join(git, 'real-config'), CLEAN_CONFIG)
      rmSync(join(git, 'config'))
      symlinkSync(join(git, 'real-config'), join(git, 'config'))
    },
  },
]

/**
 * Prove the clone check works before it is registered: it passes a clean clone and refuses each hostile one for the expected code.
 * @param deps - git path, how git is run, filesystem calls.
 * @param tmp - the directory the throwaway clones are created in; default the OS temp directory.
 * @throws {Error} naming the scenario when a verdict is wrong; any error from git itself (missing, timeout) propagates.
 */
export function selfTestCloneChecker(deps: CloneInspectDeps, tmp: string = tmpdir()): void {
  const base = mkdtempSync(join(realpathSync(tmp), 'dsh-checker-selftest-'))
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      const cwd = join(base, String(index))
      const git = join(cwd, '.git')
      mkdirSync(join(git, 'hooks'), { recursive: true })
      writeFileSync(join(git, 'config'), CLEAN_CONFIG)
      writeFileSync(join(git, 'hooks', 'pre-commit.sample'), '#!/bin/sh\n')
      scenario.build(git)
      let code: string | undefined
      try {
        inspectCloneState(SELF_TEST_SEAT, cwd, deps)
      } catch (error: unknown) {
        if (!(error instanceof CloneCheckError)) throw error
        if (['git-missing', 'timeout', 'enobufs', 'eacces', 'git-error', 'git-signal', 'git-exit', 'git-stderr', 'parse'].includes(error.code)) throw error
        code = error.code
      }
      if (code !== scenario.expect) {
        throw new Error(`checker self-test: scenario "${scenario.name}" expected ${scenario.expect ?? 'a pass'} but got ${code ?? 'a pass'}`)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
