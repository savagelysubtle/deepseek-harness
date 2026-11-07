/**
 * `dsh open [--port N]` — print a fresh one-use access link for a running `dsh web` host (OP-270).
 * The launcher's first link expires after 10 minutes; this asks the running host for another. It reads
 * the host's per-boot relink key from a 0600 file in `$XDG_RUNTIME_DIR` and presents it to the
 * loopback `/api/auth.relink` endpoint. Anyone who can read that file as this user can do the same.
 * @module apps/cli/src/open
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTH_RELINK_PATH, RELINK_KEY_FILE_PREFIX, RELINK_KEY_FILE_SUFFIX, RELINK_KEY_HEADER,
} from '@deepseek-ai/dsh-web-app'

/** Output sinks the runner writes to; tests substitute captures. */
export const internals: {
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
} = { stdout: process.stdout, stderr: process.stderr }

/** What args.ts decided. */
export interface OpenRequest {
  /** Port of the host to ask; absent means the only running host found. */
  readonly port: number | undefined
}

/** Injection points for tests. */
export interface OpenOptions {
  readonly runtimeDir?: string | undefined
  readonly fetch?: typeof fetch
}

const KEY_FILE_PATTERN = new RegExp(`^${RELINK_KEY_FILE_PREFIX}(\\d+)${RELINK_KEY_FILE_SUFFIX.replace('.', '\\.')}$`)

/**
 * Ask the running host for a fresh access link and print it.
 * @param request - the parsed request from args.ts.
 * @param options - optional injections for tests.
 * @returns 0 after printing the link, 1 when no host answers or refuses, 2 on usage problems.
 */
export async function runOpen(request: OpenRequest, options: OpenOptions = {}): Promise<number> {
  const runtimeDir = 'runtimeDir' in options ? options.runtimeDir : process.env['XDG_RUNTIME_DIR']
  if (runtimeDir === undefined || runtimeDir === '') {
    internals.stderr.write('dsh open: XDG_RUNTIME_DIR is not set, so there is no relink key to read.\n')
    return 2
  }
  let ports: number[]
  try {
    ports = readdirSync(runtimeDir)
      .map(name => KEY_FILE_PATTERN.exec(name)?.[1])
      .filter((port): port is string => port !== undefined)
      .map(Number)
  } catch (error) {
    internals.stderr.write(`dsh open: cannot read ${runtimeDir}: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const port = request.port ?? (ports.length === 1 ? ports[0] : undefined)
  if (port === undefined || !ports.includes(port)) {
    internals.stderr.write(ports.length === 0
      ? 'dsh open: no running dsh web host found (no relink key file). Start dsh web first.\n'
      : request.port === undefined
        ? `dsh open: several hosts are running (ports ${ports.join(', ')}); choose one with --port.\n`
        : `dsh open: no relink key for port ${String(request.port)}; running hosts: ${ports.join(', ')}.\n`)
    return 2
  }
  const key = readFileSync(join(runtimeDir, `${RELINK_KEY_FILE_PREFIX}${String(port)}${RELINK_KEY_FILE_SUFFIX}`), 'utf8').trim()
  const base = `http://127.0.0.1:${String(port)}`
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${base}${AUTH_RELINK_PATH}`, {
      method: 'POST',
      headers: { [RELINK_KEY_HEADER]: key },
    })
  } catch (error) {
    internals.stderr.write(`dsh open: the host on port ${String(port)} did not answer (${error instanceof Error ? error.message : String(error)}). The key file may be left from a host that stopped.\n`)
    return 1
  }
  if (!response.ok) {
    internals.stderr.write(`dsh open: the host refused (HTTP ${String(response.status)}): ${await response.text()}\n`)
    return 1
  }
  const body = await response.json() as { code?: unknown }
  if (typeof body.code !== 'string' || body.code === '') {
    internals.stderr.write('dsh open: the host answered without a launch code.\n')
    return 1
  }
  internals.stdout.write(`${base}/#dsh-boot=${body.code}\n`)
  return 0
}
