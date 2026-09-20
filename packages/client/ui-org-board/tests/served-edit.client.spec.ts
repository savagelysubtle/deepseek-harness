/**
 * Pure served-address editor coverage: add-if-absent, remove-if-present, a
 * no-op removal of an absent name, and immutability of the input list across
 * every call. No RPC, no React, no store.
 */
import { describe, expect, it } from 'vitest'
import { nextServedAddresses } from '../src/client/served-edit.ts'

describe('nextServedAddresses', () => {
  it('adds the name when served is true and it is absent', () => {
    const current = ['alfred', 'batman']
    const next = nextServedAddresses(current, 'robin', true)
    expect(next).toEqual(['alfred', 'batman', 'robin'])
  })

  it('removes the name when served is false and it is present', () => {
    const current = ['alfred', 'batman', 'robin']
    const next = nextServedAddresses(current, 'batman', false)
    expect(next).toEqual(['alfred', 'robin'])
  })

  it('is a no-op removing a name that is already absent', () => {
    const current = ['alfred', 'batman']
    const next = nextServedAddresses(current, 'robin', false)
    expect(next).toEqual(['alfred', 'batman'])
  })

  it('is a no-op adding a name that is already present', () => {
    const current = ['alfred', 'batman']
    const next = nextServedAddresses(current, 'alfred', true)
    expect(next).toEqual(['alfred', 'batman'])
  })

  it('never mutates the input array, on add', () => {
    const current = ['alfred', 'batman']
    const snapshot = [...current]
    nextServedAddresses(current, 'robin', true)
    expect(current).toEqual(snapshot)
  })

  it('never mutates the input array, on remove', () => {
    const current = ['alfred', 'batman', 'robin']
    const snapshot = [...current]
    nextServedAddresses(current, 'batman', false)
    expect(current).toEqual(snapshot)
  })

  it('never mutates the input array, on a no-op', () => {
    const current = ['alfred', 'batman']
    const snapshot = [...current]
    nextServedAddresses(current, 'robin', false)
    expect(current).toEqual(snapshot)
  })
})
