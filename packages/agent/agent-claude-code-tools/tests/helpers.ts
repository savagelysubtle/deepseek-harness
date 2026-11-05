import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PolicyFileV1 } from '@deepseek-ai/dsh-agent-claude-code-driver'

/** A throwaway directory tree: `<root>/home`, `<root>/proj` (the cwd) and `<root>/outside`. */
export interface Sandbox {
  readonly root: string
  readonly home: string
  readonly cwd: string
  readonly outside: string
  cleanup(): void
}

/**
 * Create a canonical sandbox under the real temp directory.
 * @returns the sandbox; call `cleanup` in `afterEach`.
 */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cct-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  const outside = join(root, 'outside')
  for (const dir of [home, cwd, outside]) mkdirSync(dir)
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true })
  }
  return { root, home, cwd, outside, cleanup }
}

/**
 * A coder-shaped policy for a sandbox.
 * @param box - the sandbox.
 * @param tools - the tool list.
 * @returns the policy.
 */
export function coderPolicy(box: Sandbox, tools: readonly string[] = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'mcp__dsh__mailbox_send']): PolicyFileV1 {
  return {
    v: 1,
    seat: 'coder-one',
    role: 'coder',
    cwd: box.cwd,
    allowedRoots: [box.cwd],
    deniedPrefixes: [join(box.cwd, '.git'), join(box.home, '.ssh')],
    tools: [...tools],
  }
}
