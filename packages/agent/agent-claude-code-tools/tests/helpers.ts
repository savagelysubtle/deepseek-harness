import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PolicyFileV1 } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { guardScriptPath } from '../src/hook-command.ts'

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

/**
 * The built guard script (`lib/seat-guard.js`). It is a gitignored build output, so a test that execs
 * the guard builds it first when it is absent (`tsc -b`, then the package's own tsdown config) instead
 * of assuming an earlier `pnpm run typecheck` left it behind.
 * @returns its absolute path.
 */
function ensureBuiltGuard(): string {
  const path = guardScriptPath()
  if (!existsSync(path)) {
    const pkg = dirname(dirname(path))
    const run = (args: string[], cwd: string): void => {
      const result = spawnSync('pnpm', ['exec', ...args], { cwd, encoding: 'utf8', timeout: 240_000 })
      if (result.status !== 0) throw new Error(`building the seat guard failed (pnpm exec ${args.join(' ')}): ${result.stdout}${result.stderr}`)
    }
    run(['tsc', '-b', pkg], join(pkg, '..', '..', '..'))
    run(['tsdown', '--config', join(pkg, 'tsdown.config.ts')], pkg)
  }
  return path
}

/**
 * Put an attestable copy of the built guard and a `node` wrapper (the attestation refuses the real node
 * because of where it is installed) into a sandbox.
 * @param root - directory to put them in.
 * @returns their paths.
 */
export function installRealGuard(root: string): { readonly node: string; readonly guard: string } {
  const node = join(root, 'node')
  const guard = join(root, 'seat-guard.js')
  writeFileSync(node, `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
  chmodSync(node, 0o755)
  copyFileSync(ensureBuiltGuard(), guard)
  chmodSync(guard, 0o755)
  return { node, guard }
}
