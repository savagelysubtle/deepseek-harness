/** Shared loopback-hostname semantics for the Host fence and browser UI. */

import { describe, expect, it } from 'vitest'
import { isLoopbackAddress, isLoopbackHostname } from '../src/loopback-hostname.ts'

describe('isLoopbackHostname', () => {
  it('accepts localhost, IPv6 loopback, and the whole IPv4 127/8 block', () => {
    for (const hostname of ['localhost', '[::1]', '127.0.0.1', '127.8.9.10', '127.255.255.255']) {
      expect(isLoopbackHostname(hostname)).toBe(true)
    }
  })

  it('refuses malformed and non-loopback hostnames', () => {
    for (const hostname of ['remote.localhost', '::1', '128.0.0.1', '127.0.0', '127.0.0.256', '127.0.0.-1']) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })
})

describe('isLoopbackAddress', () => {
  it('accepts every raw socket form of the local loopback peer', () => {
    for (const remoteAddress of [
      '127.0.0.1',
      '127.8.9.10',
      '127.255.255.255',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:127.255.255.255',
    ]) {
      expect(isLoopbackAddress(remoteAddress)).toBe(true)
    }
  })

  it('refuses an absent, empty, unspecified, routable, hostname, or zone-id address', () => {
    for (const remoteAddress of [
      undefined,
      '',
      '0.0.0.0',
      '::',
      '10.0.0.1',
      '::ffff:10.0.0.1',
      'localhost',
      '::1%eth0',
      '127.0.0.1%eth0',
    ]) {
      expect(isLoopbackAddress(remoteAddress)).toBe(false)
    }
  })
})
