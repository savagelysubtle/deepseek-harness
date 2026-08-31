/**
 * Per-session TCP port allocation over a configured range. The allocator
 * reserves ports in memory, verifies actual bindability with a real listen
 * before handing a port out, and reclaims ports on release. It is a library,
 * not a service or plugin: no `ctx`, no registration, no events.
 * @module @deepseek-ai/dsh-port-allocator
 */

import { createServer } from 'node:net'
import { assertTcpPort } from './validate.ts'

export { MAX_TCP_PORT, MIN_TCP_PORT } from './validate.ts'

/** Interface a bindability probe listens on. */
export type ProbeHost = '0.0.0.0' | '127.0.0.1'

/** Raw allocator configuration as a consumer supplies it; validated by {@link resolvePortAllocatorConfig}. */
export interface PortAllocatorInput {
  /** Inclusive lower bound of the allocation range. */
  readonly min: number
  /** Inclusive upper bound of the allocation range; must be greater than `min`. */
  readonly max: number
  /** Maximum bindability probes a single {@link PortAllocator.allocate} performs before giving up. */
  readonly maxAttempts: number
  /**
   * Interface the bindability probe listens on, as the raw Config supplied it;
   * a raw string because this module validates it against the two supported
   * interfaces at the boundary. Resolved to `127.0.0.1` when absent.
   */
  readonly probeHost?: string
  /** Ports treated as unavailable regardless of bindability (holds known before this allocator started). */
  readonly inUse?: readonly number[]
}

/** Validated allocator configuration produced by {@link resolvePortAllocatorConfig}. */
export interface PortAllocatorConfig {
  /** Validated inclusive lower bound. */
  readonly min: number
  /** Validated inclusive upper bound, greater than `min`. */
  readonly max: number
  /** Validated probe bound, at least 1. */
  readonly maxAttempts: number
  /** Probe interface; `0.0.0.0` detects a holder on any interface, `127.0.0.1` only loopback holders. */
  readonly probeHost: ProbeHost
  /** Validated seed of ports this allocator must never hand out. */
  readonly inUse: ReadonlySet<number>
}

/**
 * Resolve the raw `probeHost` Config value to its validated interface. The
 * default lives in this owning resolve step, not at a call site: it is
 * `127.0.0.1` because harness consumers bind loopback, and a loopback probe
 * detects exactly the holders those consumers will conflict with; choose
 * `0.0.0.0` only for a consumer that binds all interfaces, which it
 * over-detects for (safe: it skips ports a loopback bind could still use).
 *
 * @param raw - the probeHost value as the raw Config supplied it.
 * @returns the validated probe interface.
 * @throws when `raw` is neither supported interface.
 */
function resolveProbeHost(raw: string | undefined): ProbeHost {
  if (raw === undefined) return '127.0.0.1'
  if (raw === '0.0.0.0' || raw === '127.0.0.1') return raw
  throw new Error(
    `port allocator: probeHost must be '0.0.0.0' or '127.0.0.1', received ${JSON.stringify(raw)}`,
  )
}

/**
 * Resolve and validate allocator configuration. This is the module's config
 * boundary: range bounds must be integers inside the legal TCP range with
 * `min < max`, the probe bound must be a positive integer, and every seeded
 * in-use port must be a legal port number.
 *
 * @param input - raw configuration, typically resolved from consumer Config.
 * @returns the validated configuration.
 * @throws when any field is outside its stated range or shape.
 */
export function resolvePortAllocatorConfig(input: PortAllocatorInput): PortAllocatorConfig {
  assertTcpPort(input.min, 'port allocator', 'min')
  assertTcpPort(input.max, 'port allocator', 'max')
  if (input.min >= input.max) {
    throw new Error(`port allocator: min (${input.min}) must be less than max (${input.max})`)
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error(
      `port allocator: maxAttempts must be an integer of at least 1, received ${input.maxAttempts}`,
    )
  }
  const inUse = new Set<number>()
  for (const port of input.inUse ?? []) {
    assertTcpPort(port, 'port allocator', 'inUse entry')
    inUse.add(port)
  }
  return {
    min: input.min,
    max: input.max,
    maxAttempts: input.maxAttempts,
    probeHost: resolveProbeHost(input.probeHost),
    inUse,
  }
}

/** One failed bindability probe: the probed port and the listen error. */
export interface PortProbeFailure {
  /** The port whose bind attempt failed. */
  readonly port: number
  /** The listen error's `code` (`EADDRINUSE`, `EACCES`, ...), or `UNKNOWN` when the error carries none. */
  readonly code: string
  /** The listen error's message. */
  readonly message: string
}

/** Thrown when {@link PortAllocator.allocate} cannot hand out a port. */
export class PortAllocationError extends Error {
  override name = 'PortAllocationError'

  /**
   * Construct the exhaustion failure.
   * @param attempts - every bindability probe that failed during the allocation, in probe order.
   * @param message - human-readable summary of why no port was available.
   */
  constructor(readonly attempts: readonly PortProbeFailure[], message: string) {
    super(message)
  }
}

type ProbeOutcome = { ok: true } | { ok: false; failure: PortProbeFailure }

/**
 * Normalize one listen error into a probe failure record.
 * @param port - the probed port the error belongs to.
 * @param error - the error the listen attempt produced.
 * @returns the failure record; the code falls back to `UNKNOWN` when the error carries none.
 */
export function probeFailure(port: number, error: NodeJS.ErrnoException): PortProbeFailure {
  return { port, code: error.code ?? 'UNKNOWN', message: error.message }
}

/**
 * Probe one port by actually listening on `host` and closing immediately — a
 * port absent from the in-use set may still be held by a foreign process, and
 * only the kernel knows. The probe uses Node's own server defaults, so its
 * outcome predicts a later `net.Server` bind by the consumer on the same host.
 *
 * @param port - the port to probe.
 * @param host - the interface to bind; a loopback probe detects the holders a loopback
 *   consumer conflicts with, a wildcard probe also detects holders on other interfaces.
 * @returns `{ ok: true }` when the port accepted a listen and closed cleanly, otherwise the failure.
 */
function probeBindability(port: number, host: ProbeHost): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const server = createServer()
    // A failed bind leaves no handle behind: the error IS the outcome, so the
    // server needs no close() here. A late second settlement would be a no-op:
    // a promise resolves exactly once.
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, failure: probeFailure(port, error) })
    })
    server.listen(port, host, () => {
      server.close(() => { resolve({ ok: true }) })
    })
  })
}

/**
 * Allocate per-session TCP ports from one validated range. Candidates are
 * scanned lowest-first, skipping ports this allocator has already handed out
 * and ports seeded as in-use; each remaining candidate is probed for actual
 * bindability before it is handed out. Concurrent `allocate()` calls are
 * serialized so two sessions can never receive the same port.
 */
export class PortAllocator {
  private readonly config: PortAllocatorConfig
  private readonly allocatedPorts = new Set<number>()
  /** Tail of the allocation chain; concurrent allocations queue behind it. */
  private allocationTail: Promise<unknown> = Promise.resolve()

  /**
   * Construct an allocator.
   * @param input - raw configuration; validated through {@link resolvePortAllocatorConfig}.
   * @throws when `input` fails validation.
   */
  constructor(input: PortAllocatorInput) {
    this.config = resolvePortAllocatorConfig(input)
  }

  /**
   * Allocate the next free port for one session. A candidate is free when it
   * is inside the range, not already allocated by this allocator, not seeded
   * as in-use, and actually bindable on the configured probe host. The port is
   * reserved before the promise settles; return it to the pool with
   * {@link PortAllocator.release} when the session ends.
   *
   * @returns the allocated port number.
   * @throws {@link PortAllocationError} (as a rejection) listing every failed probe when
   *   the probe bound is reached, or when no candidate remains in the range.
   */
  async allocate(): Promise<number> {
    // Serialize: the probe is async, so two concurrent calls could otherwise
    // probe and win the same lowest candidate. The chain keeps the failure of
    // one allocation from poisoning later ones.
    const run = this.allocationTail.then(() => this.allocateExclusively())
    // Swallowed by design: `run` itself is returned to its caller, who observes
    // the failure; the tail only needs a settled placeholder to queue behind.
    this.allocationTail = run.catch(() => undefined)
    return run
  }

  /**
   * Release a port allocated by this allocator, making it a candidate again.
   * The port is NOT probed on release; a lingering foreign grab is caught by
   * the next allocation's probe.
   *
   * @param port - a port previously returned by {@link PortAllocator.allocate} on this instance.
   * @returns nothing.
   * @throws when `port` is not a legal TCP port or was not allocated by this allocator.
   */
  release(port: number): void {
    assertTcpPort(port, 'port allocator', 'port')
    if (!this.allocatedPorts.delete(port)) {
      throw new Error(`port allocator: release() called for port ${port}, which this allocator has not allocated`)
    }
  }

  /**
   * Run one allocation while holding the allocator's serialization. Only ever
   * called from the allocation chain {@link PortAllocator.allocate} builds.
   *
   * @returns the allocated port number.
   * @throws {@link PortAllocationError} when no bindable candidate remains.
   */
  private async allocateExclusively(): Promise<number> {
    const { min, max, maxAttempts, probeHost, inUse } = this.config
    const failures: PortProbeFailure[] = []
    for (let port = min; port <= max; port += 1) {
      if (inUse.has(port) || this.allocatedPorts.has(port)) continue
      if (failures.length >= maxAttempts) break
      const outcome = await probeBindability(port, probeHost)
      if (outcome.ok) {
        this.allocatedPorts.add(port)
        return port
      }
      failures.push(outcome.failure)
    }
    throw new PortAllocationError(failures, this.exhaustedMessage(failures))
  }

  /**
   * Build the exhaustion summary: the failed probes with their error codes,
   * plus how the range's ports were otherwise consumed.
   *
   * @param failures - the failed probes of the exhausted allocation.
   * @returns the complete exhaustion message.
   */
  private exhaustedMessage(failures: readonly PortProbeFailure[]): string {
    const { min, max, inUse } = this.config
    const range = `[${min}, ${max}]`
    if (failures.length === 0) {
      return `no free port in ${range}: all ${max - min + 1} ports are already allocated by this allocator or seeded as in-use`
    }
    const probed = failures.map(failure => `${failure.port} (${failure.code})`).join(', ')
    return `no bindable port in ${range}: probe failures — ${probed}; `
      + `${this.allocatedPorts.size} port(s) already allocated by this allocator, ${inUse.size} seeded as in-use`
  }
}
