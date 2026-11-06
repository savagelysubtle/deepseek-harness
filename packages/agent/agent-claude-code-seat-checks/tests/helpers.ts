import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitRunResult, RunGit } from '../src/git-config.ts'

/** The config `git clone` writes, plus nothing else. */
export const CLEAN_CONFIG = [
  '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
  '[remote "origin"]', '\turl = /srv/example.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*',
  '[branch "main"]', '\tremote = origin', '\tmerge = refs/heads/main', '',
].join('\n')

/** The git the real-git tests use. */
export const GIT = '/usr/bin/git'

export interface TempRoot {
  readonly root: string
  readonly cleanup: () => void
}

export function tempRoot(): TempRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seat-checks-')))
  return { root, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** Build a clean clone at `<root>/<name>`; returns its cwd. */
export function makeClone(root: string, name = 'clone', config = CLEAN_CONFIG): string {
  const cwd = join(root, name)
  mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(cwd, '.git', 'config'), config)
  writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n')
  return cwd
}


export function writeConfig(cwd: string, text: string): void {
  writeFileSync(join(cwd, '.git', 'config'), text)
}

export function replaceWithSymlink(path: string, target: string): void {
  rmSync(path, { recursive: true, force: true })
  symlinkSync(target, path)
}

export function addHardlink(path: string, to: string): void {
  linkSync(path, to)
}

export function addExecutableHook(cwd: string, name: string): void {
  const path = join(cwd, '.git', 'hooks', name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

/** A git result that looks like a clean run. */
export function okResult(stdout: string): GitRunResult {
  return { error: undefined, signal: null, status: 0, stdout, stderr: '' }
}

export function failing(over: Partial<GitRunResult>): RunGit {
  return () => ({ ...okResult('core.filemode\ntrue\0'), ...over })
}

export function errorWithCode(code: string | undefined, message = 'boom'): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(message)
  if (code !== undefined) error.code = code
  return error
}
