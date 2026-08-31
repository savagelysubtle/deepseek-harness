import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_TCP_PORT,
  MIN_TCP_PORT,
  PortAllocationError,
  PortAllocator,
  probeFailure,
  resolvePortAllocatorConfig,
} from '@deepseek-ai/dsh-port-allocator'

/** Servers a test opened; every one is closed after each test. */
const heldServers: Server[] = []

afterEach(async () => {
  await Promise.all(heldServers.splice(0).map(server =>
    new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  ))
})

/**
 * Listen on `port` for loopback and keep the server open, simulating a foreign
 * process that holds the port.
 * @param port - the port to hold.
 * @returns the listening server; closed again in `afterEach`.
 */
async function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      heldServers.push(server)
      resolve(server)
    })
  })
}

/** Probe one port for bindability, mirroring what the allocator's probe sees. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => { resolve(true) })
    })
  })
}

/**
 * Find a base port whose next `size` consecutive ports are all currently
 * bindable, so test fixtures never fight unrelated listeners on this host.
 * @param size - number of consecutive ports the fixture needs.
 * @returns the base port of a free consecutive run.
 */
async function findFreeRange(size: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = 20_000 + Math.floor(Math.random() * 30_000)
    const free = await Promise.all(
      Array.from({ length: size }, (_, offset) => canBind(base + offset)),
    )
    if (free.every(Boolean)) return base
  }
  throw new Error('no free consecutive port range found for the fixture')
}

describe('resolvePortAllocatorConfig', () => {
  it('resolves an explicit probeHost and seeds the in-use set', () => {
    const config = resolvePortAllocatorConfig({
      min: 3100,
      max: 3199,
      maxAttempts: 4,
      probeHost: '0.0.0.0',
      inUse: [3101, 3101, 3102],
    })
    expect(config).toEqual({
      min: 3100,
      max: 3199,
      maxAttempts: 4,
      probeHost: '0.0.0.0',
      inUse: new Set([3101, 3102]),
    })
  })

  it('defaults probeHost to loopback, the interface harness consumers bind', () => {
    const config = resolvePortAllocatorConfig({ min: 3100, max: 3199, maxAttempts: 1 })
    expect(config.probeHost).toBe('127.0.0.1')
    expect(config.inUse.size).toBe(0)
  })

  it('rejects a min below the legal TCP range', () => {
    expect(() => resolvePortAllocatorConfig({ min: MIN_TCP_PORT - 1, max: 3100, maxAttempts: 1 }))
      .toThrow(/port allocator: min must be an integer between 1 and 65535, received 0/)
  })

  it('rejects a non-integer min', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3.5, max: 3100, maxAttempts: 1 }))
      .toThrow(/port allocator: min must be an integer between 1 and 65535, received 3\.5/)
  })

  it('rejects a max above the legal TCP range', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3100, max: MAX_TCP_PORT + 1, maxAttempts: 1 }))
      .toThrow(/port allocator: max must be an integer between 1 and 65535, received 65536/)
  })

  it('rejects min equal to max', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3100, max: 3100, maxAttempts: 1 }))
      .toThrow('port allocator: min (3100) must be less than max (3100)')
  })

  it('rejects min greater than max', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3200, max: 3100, maxAttempts: 1 }))
      .toThrow('port allocator: min (3200) must be less than max (3100)')
  })

  it('rejects a maxAttempts below 1', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3100, max: 3199, maxAttempts: 0 }))
      .toThrow(/port allocator: maxAttempts must be an integer of at least 1, received 0/)
  })

  it('rejects a non-integer maxAttempts', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3100, max: 3199, maxAttempts: 1.5 }))
      .toThrow(/port allocator: maxAttempts must be an integer of at least 1, received 1\.5/)
  })

  it('rejects an unknown probeHost', () => {
    expect(() => resolvePortAllocatorConfig({
      min: 3100,
      max: 3199,
      maxAttempts: 1,
      probeHost: 'example.com',
    })).toThrow(/port allocator: probeHost must be '0\.0\.0\.0' or '127\.0\.0\.1', received "example\.com"/)
  })

  it('rejects an inUse entry outside the legal TCP range', () => {
    expect(() => resolvePortAllocatorConfig({ min: 3100, max: 3199, maxAttempts: 1, inUse: [0] }))
      .toThrow(/port allocator: inUse entry must be an integer between 1 and 65535, received 0/)
  })
})

describe('probeFailure', () => {
  it('keeps the error code when the error carries one', () => {
    const error: NodeJS.ErrnoException = new Error('listen EADDRINUSE: address already in use')
    error.code = 'EADDRINUSE'
    expect(probeFailure(3100, error)).toEqual({
      port: 3100,
      code: 'EADDRINUSE',
      message: 'listen EADDRINUSE: address already in use',
    })
  })

  it('falls back to UNKNOWN when the error carries no code', () => {
    expect(probeFailure(3100, new Error('boom'))).toMatchObject({ port: 3100, code: 'UNKNOWN' })
  })
})

describe('PortAllocator — allocate, bind, release cycle', () => {
  it('allocates the lowest in-range port, hands it to a real consumer bind, and reuses it after release', async () => {
    const base = await findFreeRange(2)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 3 })

    const first = await allocator.allocate()
    expect(first).toBe(base)

    // The consumer's real bind must succeed exactly where the probe said free.
    const consumer = await holdPort(first)
    await new Promise<void>((resolve) => { consumer.close(() => { resolve() }) })

    allocator.release(first)
    await expect(allocator.allocate()).resolves.toBe(base)
  })

  it('skips ports seeded as in-use', async () => {
    const base = await findFreeRange(2)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 3, inUse: [base] })
    await expect(allocator.allocate()).resolves.toBe(base + 1)
  })

  it('never hands out a port twice for consecutive allocations', async () => {
    const base = await findFreeRange(2)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 3 })
    const first = await allocator.allocate()
    await expect(allocator.allocate()).resolves.toBe(first + 1)
  })

  it('skips a port held by a foreign process even though it is not marked in-use', async () => {
    const base = await findFreeRange(2)
    await holdPort(base)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 3 })
    // base is free in the allocator's view but the kernel holds it for another
    // process: the probe must skip it and fall through to the next candidate.
    await expect(allocator.allocate()).resolves.toBe(base + 1)
  })

  it('serializes concurrent allocations into distinct ports', async () => {
    const base = await findFreeRange(3)
    const allocator = new PortAllocator({ min: base, max: base + 2, maxAttempts: 3 })
    const ports = await Promise.all([
      allocator.allocate(),
      allocator.allocate(),
      allocator.allocate(),
    ])
    expect(new Set(ports).size).toBe(3)
    expect(ports).toEqual([base, base + 1, base + 2])
  })

  it('rejects a release of a port this allocator never allocated', async () => {
    const base = await findFreeRange(2)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 1 })
    expect(() => { allocator.release(base) }).toThrow(
      `port allocator: release() called for port ${base}, which this allocator has not allocated`,
    )
  })

  it('rejects a release outside the legal TCP range', () => {
    const allocator = new PortAllocator({ min: 3100, max: 3199, maxAttempts: 1 })
    expect(() => { allocator.release(0) }).toThrow(/port allocator: port must be an integer between 1 and 65535, received 0/)
    expect(() => { allocator.release(1.5) }).toThrow(/port allocator: port must be an integer between 1 and 65535, received 1\.5/)
  })
})

describe('PortAllocator — exhaustion', () => {
  it('throws with every failed probe listed when foreign holders exhaust the range', async () => {
    const base = await findFreeRange(2)
    await holdPort(base)
    await holdPort(base + 1)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 2 })

    const error = await allocator.allocate().then(
      () => { throw new Error('allocation unexpectedly succeeded') },
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(PortAllocationError)
    const exhausted = error as PortAllocationError
    expect(exhausted.attempts.map(attempt => attempt.port)).toEqual([base, base + 1])
    expect(exhausted.attempts.every(attempt => attempt.code === 'EADDRINUSE')).toBe(true)
    expect(exhausted.message).toBe(
      `no bindable port in [${base}, ${base + 1}]: probe failures — ${base} (EADDRINUSE), ${base + 1} (EADDRINUSE); `
      + '0 port(s) already allocated by this allocator, 0 seeded as in-use',
    )
  })

  it('stops probing at the configured attempt bound', async () => {
    const base = await findFreeRange(3)
    await holdPort(base)
    await holdPort(base + 1)
    await holdPort(base + 2)
    const allocator = new PortAllocator({ min: base, max: base + 2, maxAttempts: 2 })

    const error = await allocator.allocate().then(
      () => { throw new Error('allocation unexpectedly succeeded') },
      (failure: unknown) => failure,
    ) as PortAllocationError
    expect(error.attempts).toHaveLength(2)
    expect(error.attempts.map(attempt => attempt.port)).toEqual([base, base + 1])
  })

  it('throws the consumed-range summary when the allocator itself holds every port', async () => {
    const base = await findFreeRange(2)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 5 })
    await allocator.allocate()
    await allocator.allocate()

    const error = await allocator.allocate().then(
      () => { throw new Error('allocation unexpectedly succeeded') },
      (failure: unknown) => failure,
    ) as PortAllocationError
    expect(error.attempts).toEqual([])
    expect(error.message).toBe(
      `no free port in [${base}, ${base + 1}]: all 2 ports are already allocated by this allocator or seeded as in-use`,
    )
  })

  it('throws with the partial probe failures when candidates run out before the attempt bound', async () => {
    const base = await findFreeRange(2)
    await holdPort(base)
    const allocator = new PortAllocator({ min: base, max: base + 1, maxAttempts: 5, inUse: [base + 1] })

    const error = await allocator.allocate().then(
      () => { throw new Error('allocation unexpectedly succeeded') },
      (failure: unknown) => failure,
    ) as PortAllocationError
    expect(error.attempts).toHaveLength(1)
    expect(error.attempts[0]).toMatchObject({ port: base, code: 'EADDRINUSE' })
    expect(error.message).toContain('no bindable port')
  })

  it('keeps allocating after a failed allocation', async () => {
    const base = await findFreeRange(2)
    await holdPort(base)
    await holdPort(base + 1)
    const blocked = new PortAllocator({ min: base, max: base + 1, maxAttempts: 1 })
    await expect(blocked.allocate()).rejects.toBeInstanceOf(PortAllocationError)

    // A later allocation on a fresh allocator over the same range works: the
    // failed one left no poisoned state behind.
    await closeHeld(base)
    await closeHeld(base + 1)
    const healthy = new PortAllocator({ min: base, max: base + 1, maxAttempts: 1 })
    await expect(healthy.allocate()).resolves.toBe(base)
  })
})

/**
 * Close the foreign holder on `port` that `holdPort` opened, removing it from
 * the afterEach list so it is not closed twice.
 * @param port - the held port to release.
 */
async function closeHeld(port: number): Promise<void> {
  const index = heldServers.findIndex(server => (server.address() as { port: number }).port === port)
  const server = heldServers.splice(index, 1)[0]
  if (server === undefined) throw new Error(`no held server on port ${port}`)
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}
