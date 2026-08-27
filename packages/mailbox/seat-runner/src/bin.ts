/**
 * `dsh-seat-runner` entrypoint: open the mailbox store, load the org
 * registry, and run the wake loop until interrupted. Flags override the
 * validated defaults; a misconfigured flag fails loud at boot.
 *
 * @module @deepseek-ai/dsh-seat-runner/bin
 */

import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadOrgRegistry } from '@deepseek-ai/dsh-mailbox'
import { openLocalMailbox, SqliteMailboxStore } from '@deepseek-ai/dsh-mailbox-local'
import { resolveSeatRunnerConfig, startSeatRunner } from './runner.ts'
import type { SeatRunnerConfig, WakeRequest } from './runner.ts'

/** Writable mirror of the config, for flag assembly before validation. */
type WritableConfig = { -readonly [K in keyof SeatRunnerConfig]: SeatRunnerConfig[K] }

/**
 * Flags for the daemon; every long-form flag maps to one config field.
 * @param argv - raw process arguments.
 * @returns the flag-derived config; absent flags stay absent.
 * @throws when a flag is unknown or missing its value.
 */
function parseFlags(argv: readonly string[]): SeatRunnerConfig {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (flag !== '--registry' && flag !== '--store' && flag !== '--poll-interval-ms' && flag !== '--stale-claim-ms' && flag !== '--entrypoint' && flag !== '--backoff-base-ms') {
      throw new Error(`unknown flag ${JSON.stringify(flag)}; expected --registry, --store, --poll-interval-ms, --stale-claim-ms, --entrypoint, or --backoff-base-ms`)
    }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`flag ${flag} requires a value`)
    values.set(flag, value)
  }
  const config: WritableConfig = {}
  const registryPath = values.get('--registry')
  if (registryPath !== undefined) config.registryPath = registryPath
  const storePath = values.get('--store')
  if (storePath !== undefined) config.storePath = storePath
  const entrypoint = values.get('--entrypoint')
  if (entrypoint !== undefined) config.entrypoint = entrypoint
  const pollIntervalMs = values.get('--poll-interval-ms')
  if (pollIntervalMs !== undefined) config.pollIntervalMs = Number(pollIntervalMs)
  const staleClaimMs = values.get('--stale-claim-ms')
  if (staleClaimMs !== undefined) config.staleClaimMs = Number(staleClaimMs)
  const backoffBaseMs = values.get('--backoff-base-ms')
  if (backoffBaseMs !== undefined) config.backoffBaseMs = Number(backoffBaseMs)
  return config
}

/**
 * Issue one wake as a real child process: the standard headless command a
 * human runs by hand, in the seat's workspace.
 * @param request - the registry-resolved wake.
 * @returns resolves when the run exits 0; rejects on a nonzero exit or spawn failure.
 */
function spawnWake(request: WakeRequest): Promise<void> {
  return new Promise((resolveWake, rejectWake) => {
    const child = spawn(
      request.entrypoint,
      ['--profile', 'headless', '--session-name', request.name, '--mailbox-namespace', request.namespace, request.task],
      { cwd: request.cwd, stdio: 'ignore' },
    )
    child.once('error', rejectWake)
    child.once('exit', (code) => {
      if (code === 0) resolveWake()
      else rejectWake(new Error(`headless run exited ${code ?? 'by signal'}`))
    })
  })
}

/**
 * Run the daemon until interrupted: store open, registry load, tick loop,
 * then a clean stop on SIGINT/SIGTERM. Natural exit waits out in-flight
 * wakes, whose exit handlers keep the event loop alive.
 */
async function main(): Promise<void> {
  const config = resolveSeatRunnerConfig(parseFlags(process.argv.slice(2)))
  const registry = await loadOrgRegistry(config.registryPath)
  const store = new SqliteMailboxStore(openLocalMailbox(config.storePath))
  const log = (line: string): void => {
    process.stdout.write(`[seat-runner] ${new Date().toISOString()} ${line}\n`)
  }
  log(`started: registry=${config.registryPath} store=${config.storePath} poll=${config.pollIntervalMs}ms seats=${Object.keys(registry.seats).length}`)
  const runner = startSeatRunner(
    { store, registry, wake: spawnWake, clock: Date.now, log },
    config,
  )
  const stop = (): void => {
    log('stopping; in-flight wakes finish independently')
    runner.stop()
    store.close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

const invoked = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`dsh-seat-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
