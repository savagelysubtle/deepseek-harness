import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers the package with the invariant registry and returns its disposer', async () => {
    const dispose = vi.fn()
    let installer: InvariantInstaller | undefined
    const register = vi.fn((_pkg: string, install: InvariantInstaller) => {
      installer = install
      return dispose
    })
    const disposer = await apply({ invariants: { register } } as unknown as Context)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-agent-claude-code-bash', expect.any(Function))
    expect(disposer).toBe(dispose)
    expect(name).toBe('agent-claude-code-bash-invariant')
    expect(inject).toEqual(['invariants'])
    expect(installer).toBeDefined()
    ;(installer as unknown as () => void)()
  })
})
