/**
 * The local git provider: every worktree mechanic is one git invocation in
 * the main checkout. Git's own location variables are stripped from the child
 * environment so the harness can run from inside a worktree of the same
 * repository without the child inheriting a foreign `GIT_DIR`.
 *
 * @module @deepseek-ai/dsh-worktree/local-git
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorktreeError } from './errors.ts'
import type { WorktreeProvider } from './provider.ts'
import type { LocalGitWorktreeProviderOptions, WorktreeAddSpec, WorktreeListEntry } from './types.ts'

const execFileAsync = promisify(execFile)

/**
 * Git location variables that would redirect the child at the calling
 * process's repository instead of `cwd`. Stripped on every invocation.
 */
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const

/**
 * Build the child environment: the parent's variables minus git's location
 * overrides, so `-C`/cwd alone selects the repository.
 * @param parent - the calling process environment.
 * @returns a copy safe to hand to a git child process.
 */
function gitEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parent).filter(([name]) => !(GIT_LOCATION_VARS as readonly string[]).includes(name)),
  )
}

/** Executed command record carried by {@link GitExecError} for provider error mapping. */
interface GitInvocation {
  readonly args: readonly string[]
  readonly stderr: string
  readonly status: number | undefined
}

/** Non-zero git exit, carrying the invocation for mapping to {@link WorktreeError}. */
class GitExecError extends Error {
  constructor(readonly invocation: GitInvocation, cause: unknown) {
    super(`git ${invocation.args.join(' ')} exited ${invocation.status ?? 'unknown'}`)
    this.name = 'GitExecError'
    this.cause = cause
  }
}

/**
 * Raw git execution with the location variables stripped. Failures bubble as
 * the child-process error they are; {@link LocalGitWorktreeProvider.run} owns
 * the wrapping.
 * @param repoRoot - directory the invocation runs in.
 * @param args - git arguments, without the program name.
 * @param parentEnv - environment to derive the child environment from.
 * @returns stdout of the invocation.
 */
async function runGit(repoRoot: string, args: readonly string[], parentEnv: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: repoRoot,
    env: gitEnvironment(parentEnv),
    encoding: 'utf8',
  })
  return stdout
}

/**
 * Map a failed git invocation to a {@link WorktreeError} carrying git's own
 * diagnostic — the refusal reason must reach the caller, not die in stderr.
 * @param error - the failure thrown by {@link LocalGitWorktreeProvider.run}, which only throws {@link GitExecError}.
 * @returns the mapped error.
 */
function toWorktreeError(error: unknown): WorktreeError {
  const { args, stderr, status } = (error as GitExecError).invocation
  const trimmed = stderr.trim()
  return new WorktreeError(
    `git ${args.join(' ')} failed${trimmed.length > 0 ? `: ${trimmed}` : ` with exit code ${status ?? 'unknown'}`}`,
    'GIT_FAILED',
    { cause: error },
  )
}

/**
 * Local provider over the git CLI, addressing `repoRoot` for every call.
 */
export class LocalGitWorktreeProvider implements WorktreeProvider {
  readonly name = 'local-git'

  constructor(private readonly options: LocalGitWorktreeProviderOptions) {}

  /**
   * Execute one git invocation — the injected seam, or the real child process
   * with the location variables stripped — and wrap every failure in the
   * same {@link GitExecError} shape, whatever produced it.
   * @param args - git arguments, without the program name.
   * @returns stdout of the invocation.
   */
  private async run(args: readonly string[]): Promise<string> {
    try {
      if (this.options.exec !== undefined) return await this.options.exec(args)
      return await runGit(this.options.repoRoot, args, process.env)
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException & { code?: number | string; stderr?: string }
      throw new GitExecError(
        { args, stderr: err.stderr ?? '', status: typeof err.code === 'number' ? err.code : undefined },
        error,
      )
    }
  }

  async add(spec: WorktreeAddSpec): Promise<void> {
    try {
      await this.run(['worktree', 'add', '--lock', '--reason', spec.lockReason, '-b', spec.branch, spec.path, spec.mainRef])
    } catch (error: unknown) {
      throw toWorktreeError(error)
    }
  }

  async lock(path: string, reason: string): Promise<void> {
    try {
      await this.run(['worktree', 'lock', '--reason', reason, path])
    } catch (error: unknown) {
      throw toWorktreeError(error)
    }
  }

  async unlock(path: string): Promise<void> {
    try {
      await this.run(['worktree', 'unlock', path])
    } catch (error: unknown) {
      throw toWorktreeError(error)
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.run(['worktree', 'remove', path])
    } catch (error: unknown) {
      throw toWorktreeError(error)
    }
  }

  pathExists(path: string): Promise<boolean> {
    return Promise.resolve(existsSync(path))
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      return true
    } catch (error: unknown) {
      // `rev-parse --verify --quiet` exits 1 exactly when the ref is absent;
      // every other failure is a real git error and keeps its diagnostic.
      if (error instanceof GitExecError && error.invocation.status === 1) return false
      throw toWorktreeError(error)
    }
  }

  async list(): Promise<readonly WorktreeListEntry[]> {
    let stdout: string
    try {
      stdout = await this.run(['worktree', 'list', '--porcelain'])
    } catch (error: unknown) {
      throw toWorktreeError(error)
    }
    return parsePorcelain(stdout)
  }
}

/**
 * Parse `git worktree list --porcelain` output into entries.
 * @param stdout - raw porcelain output.
 * @returns one entry per worktree block, in git's order.
 */
function parsePorcelain(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let path: string | undefined
  let branch: string | undefined
  let locked = false
  let lockReason: string | undefined
  const flush = (): void => {
    if (path === undefined) return
    entries.push({
      path,
      ...(branch !== undefined ? { branch } : {}),
      locked,
      ...(locked && lockReason !== undefined ? { lockReason } : {}),
    })
    path = undefined
    branch = undefined
    locked = false
    lockReason = undefined
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (line === 'locked') {
      locked = true
    } else if (line.startsWith('locked ')) {
      locked = true
      lockReason = line.slice('locked '.length)
    }
  }
  flush()
  return entries
}

/**
 * Mountable service form of the local git provider: registers one
 * {@link LocalGitWorktreeProvider} against the mounted {@link WorktreeService}'s
 * resolved repo root and unregisters it on fiber disposal. Consumers mount
 * this beside the worktree service; constructing the provider class directly
 * is for tests and embeddings that already own a service.
 */
export class LocalGitWorktrees extends Service {
  /** The worktree Service Definition this provider mounts onto. */
  static inject = ['worktrees'] as const

  constructor(ctx: Context) {
    super(ctx, 'worktreeLocalGit')
    ctx.effect(
      () => ctx.worktrees.registerProvider(new LocalGitWorktreeProvider({ repoRoot: ctx.worktrees.repoRoot })),
      'worktree-local-git.registerProvider',
    )
  }
}

export default LocalGitWorktrees
