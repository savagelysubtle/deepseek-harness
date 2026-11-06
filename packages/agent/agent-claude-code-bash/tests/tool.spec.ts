import { createSeatMcpServer, SeatToolTemplate } from '@deepseek-ai/dsh-agent-claude-code-tools'
import type { SeatTool, SeatToolResult } from '@deepseek-ai/dsh-agent-claude-code-tools'
import { SeatRefusalError } from '@deepseek-ai/dsh-sandbox-local'
import type { SeatProfileSpec } from '@deepseek-ai/dsh-sandbox-local'
import { describe, expect, it, vi } from 'vitest'
import { SandboxHost } from '../src/host.ts'
import type { PreflightDeps } from '../src/preflight.ts'
import { bashDescription, bashSchema, createBashToolFactory } from '../src/tool.ts'
import { FakeHandle, FakeWorld, GIB, makeConfig, makeContext, makePlan, makePreflightDeps } from './helpers.ts'

interface Rig {
  readonly world: FakeWorld
  readonly host: SandboxHost
  readonly specs: SeatProfileSpec[]
  readonly context: ReturnType<typeof makeContext>
  readonly tool: SeatTool
  readonly deps: PreflightDeps
  readonly call: (input: unknown, signal?: AbortSignal) => Promise<SeatToolResult>
}

/** The first line of every text block of a result. */
const blocks = (result: SeatToolResult): string[] => result.content.map(block => block.text)

async function rig(options: { plan?: (spec: SeatProfileSpec) => ReturnType<ReturnType<typeof makePreflightDeps>['plan']>; stdout?: string } = {}): Promise<Rig> {
  const world = new FakeWorld()
  world.stopExit = 0
  world.makeLaunch = () => {
    const handle = new FakeHandle({ stdout: options.stdout ?? 'ok\n' })
    handle.exit(0)
    return handle
  }
  const specs: SeatProfileSpec[] = []
  const base = makePreflightDeps(world)
  const deps = {
    ...base,
    plan: options.plan ?? ((spec: SeatProfileSpec) => {
      specs.push(spec)
      return { ok: true as const, plan: makePlan({ chdir: spec.workdir ?? spec.cwd }) }
    }),
  }
  const host = new SandboxHost(makeConfig(), deps, () => undefined)
  await host.start()
  specs.length = 0
  const context = makeContext()
  const tool = createBashToolFactory(host)(context)
  return { world, host, specs, context, tool, deps, call: (input, signal) => tool.handler(input, signal) }
}

describe('bash tool: definition', () => {
  it('is named bash and declares the always taint, with a closed object schema', async () => {
    const { tool } = await rig()
    expect(tool.name).toBe('bash')
    expect(tool.taint).toBe('always')
  })

  it('describes the sandbox the way the plan requires', () => {
    const text = bashDescription(120, 600)
    for (const needle of [
      'NO network', 'any command runs', 'READ-ONLY', 'git add', 'default 120 s', 'at most 600 s', 'timeout_s', 'killed',
      '64 KiB', 'Redirect long output into a file', 'Run vitest from the clone root', 'packages/*/*/tests', 'status block written by the host', 'one at a time',
    ]) {
      expect(text, needle).toContain(needle)
    }
  })

  it('is registered through a template and served as a closed schema; the server taints the session before the handler runs', async () => {
    const { host, context } = await rig()
    const template = new SeatToolTemplate()
    template.register('bash', createBashToolFactory(host))
    const server = createSeatMcpServer({ seat: 'coder-one', tools: ['bash'], template, context })
    type Handler = (request: unknown, extra: unknown) => Promise<unknown>
    const handlers = (server.instance as unknown as { server: { _requestHandlers: Map<string, Handler> } }).server._requestHandlers
    const listed = await handlers.get('tools/list')?.({ method: 'tools/list', params: {} }, {}) as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }
    expect(listed.tools).toHaveLength(1)
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['command'] })
    const result = await handlers.get('tools/call')?.({ method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo ok' } } }, { signal: new AbortController().signal }) as SeatToolResult
    expect(context.marks).toEqual(['tool:bash'])
    expect(blocks(result)[1]).toBe('[dsh-bash stdout]\nok\n')
  })
})

describe('bash tool: input schema', () => {
  const schema = bashSchema(600)
  it('accepts a minimal and a full input', () => {
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true)
    expect(schema.safeParse({ command: 'ls', cwd: '/work/clone/sub', timeout_s: 600 }).success).toBe(true)
  })

  it('rejects unknown keys instead of stripping them', () => {
    for (const key of ['from', 'seat', 'tainted', 'env', 'stdin']) {
      expect(schema.safeParse({ command: 'ls', [key]: 'x' }).success, key).toBe(false)
    }
  })

  it('rejects empty, oversized and NUL-containing commands', () => {
    expect(schema.safeParse({ command: '' }).success).toBe(false)
    expect(schema.safeParse({ command: 'x'.repeat(16_000) }).success).toBe(true)
    expect(schema.safeParse({ command: 'x'.repeat(16_001) }).success).toBe(false)
    expect(schema.safeParse({ command: 'a\0b' }).success).toBe(false)
    expect(schema.safeParse({ command: 5 }).success).toBe(false)
  })

  it('rejects an empty or oversized cwd and a bad timeout', () => {
    expect(schema.safeParse({ command: 'ls', cwd: '' }).success).toBe(false)
    expect(schema.safeParse({ command: 'ls', cwd: '/'.repeat(4097) }).success).toBe(false)
    for (const timeout_s of [0, -1, 601, 1.5, '5']) {
      expect(schema.safeParse({ command: 'ls', timeout_s }).success, String(timeout_s)).toBe(false)
    }
    expect(bashSchema(60).safeParse({ command: 'ls', timeout_s: 61 }).success).toBe(false)
  })

  it('answers invalid input with an error result naming the field, without running anything', async () => {
    const { call, world } = await rig()
    const spawned = world.spawns.length
    const result = await call({ command: '' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('bash: invalid input (command:')
    expect(world.spawns).toHaveLength(spawned)
  })
})

describe('bash tool: a call', () => {
  it('runs the command verbatim with the default deadline and the seat cwd, and returns status then output', async () => {
    const { call, specs, world } = await rig({ stdout: 'listing\n' })
    const result = await call({ command: 'ls -la "$HOME"' })
    expect(result.isError).toBeUndefined()
    expect(blocks(result)).toEqual([expect.stringMatching(/^\[dsh-bash\] status=exited exit_code=0 signal=none duration_ms=\d+$/), '[dsh-bash stdout]\nlisting\n'])
    // specs[0] is the first-call re-test with the real directory; specs[1] is the real command.
    expect(specs.map(spec => spec.command)).toEqual(['true', 'ls -la "$HOME"'])
    expect(specs[1]).toMatchObject({ seat: 'coder-one', cwd: '/work/clone', deadlineS: 120 })
    expect(specs[1]?.workdir).toBe('/work/clone')
    expect(specs[1]?.callId).toMatch(/^c[0-9a-f]{12}$/)
    expect(world.spawns.filter(spec => spec.argv[0] === 'systemd-run').length).toBeGreaterThanOrEqual(3)
  })

  it('passes timeout_s as the deadline', async () => {
    const { call, specs } = await rig()
    await call({ command: 'true', timeout_s: 45 })
    expect(specs.at(-1)?.deadlineS).toBe(45)
  })

  it('re-tests the clone only on the first call', async () => {
    const { call, specs } = await rig()
    await call({ command: 'a' })
    await call({ command: 'b' })
    expect(specs.map(spec => spec.command)).toEqual(['true', 'a', 'b'])
  })

  it('a non-zero exit is reported, not an error', async () => {
    const { call, world } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => {
      const handle = new FakeHandle()
      handle.exit(3)
      return handle
    }
    const result = await call({ command: 'false' })
    expect(result.isError).toBeUndefined()
    expect(blocks(result)[0]).toContain('exit_code=3')
  })

  it('refuses a cwd argument that could leave the clone before planning anything', async () => {
    const { call, specs } = await rig()
    const refused = await call({ command: 'ls', cwd: '-rf' })
    expect(refused.isError).toBe(true)
    expect(blocks(refused)[0]).toContain('code=cwd-refused')
    expect(specs).toHaveLength(0)
  })

  it('refuses a second call of the same seat while one is running, and clears the flag afterwards', async () => {
    const { call, host, context } = await rig()
    host.acquire('coder-one')
    const refused = await call({ command: 'ls' })
    expect(refused.isError).toBe(true)
    expect(blocks(refused)[0]).toContain('code=busy')
    expect(context.warnings.at(-1)).toContain('refused (busy)')
    host.release('coder-one')
    expect((await call({ command: 'ls' })).isError).toBeUndefined()
    expect(host.acquire('coder-one')).toBe(true)
  })

  it('answers a rejected run with a refusal block, degrades the host, and clears the busy flag', async () => {
    const { call, host, context } = await rig()
    await call({ command: 'warm' })
    host.run = () => Promise.reject(new Error('boom'))
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('status=refused code=sandbox-runner-error')
    expect(blocks(result)[0]).toContain('the runner threw: boom')
    expect(context.warnings.join('\n')).toContain('sandbox-runner-error')
    expect(host.acquire('coder-one')).toBe(true)
    host.release('coder-one')
    expect(await host.ensureReady()).toBeUndefined()
  })

  it('refuses when the call was cancelled before it started', async () => {
    const { call, world } = await rig()
    const controller = new AbortController()
    controller.abort()
    const spawned = world.spawns.length
    const result = await call({ command: 'ls' }, controller.signal)
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('code=aborted')
    expect(world.spawns).toHaveLength(spawned)
  })

  it('reports a call cancelled between the checks and the spawn as aborted', async () => {
    const { call, world, host } = await rig()
    await call({ command: 'warm' })
    const controller = new AbortController()
    world.makeLaunch = () => {
      controller.abort()
      return new FakeHandle()
    }
    const result = await call({ command: 'ls' }, controller.signal)
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('status=aborted')
    expect(host.acquire('coder-one')).toBe(true)
  })

  it('reports a timeout as an error with the tail captured so far', async () => {
    const { call, world } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => new FakeHandle({ stdout: 'tail so far' })
    const result = await call({ command: 'sleep 100', timeout_s: 1 })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('status=timeout')
    expect(blocks(result)[0]).toContain('killed after the 1 s deadline')
    expect(blocks(result)[1]).toBe('[dsh-bash stdout]\ntail so far')
  })

  it('warns when the disk watchdog killed the command and when the disk is still low afterwards', async () => {
    const { call, world, context } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => new FakeHandle()
    world.free = () => GIB / 2
    const result = await call({ command: 'dd if=/dev/zero of=big' })
    expect(blocks(result)[0]).toContain('status=disk-floor')
    expect(blocks(result)[0]).toContain('further commands are refused')
    expect(context.warnings.join('\n')).toContain('killed, free disk space fell below the floor')
    expect(context.warnings.join('\n')).toContain('free disk space is below the floor after the call')
  })
})

describe('bash tool: the sandbox cannot start', () => {
  it('refuses with a visible result and a warning when the preflight failed, and never falls back', async () => {
    const world = new FakeWorld()
    world.stopExit = 0
    const deps = makePreflightDeps(world, { attest: () => undefined })
    const host = new SandboxHost(makeConfig(), deps, () => undefined)
    await host.start()
    const context = makeContext()
    const tool = createBashToolFactory(host)(context)
    const result = await tool.handler({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(blocks(result)[0]?.split('\n')[0]).toBe('[dsh-bash] status=refused code=sandbox-unavailable the command did not run')
    expect(result.content[0]?.text).toContain('the sandbox cannot start: binary-missing')
    expect(result.content[0]?.text).toContain('There is no fallback shell')
    expect(context.warnings.at(-1)).toContain('refused (sandbox-unavailable)')
    expect(world.spawns.filter(spec => spec.argv[0] === 'systemd-run')).toHaveLength(0)
  })

  it('shows the profile builder\'s code, reason and remedy when it refuses a call', async () => {
    const refusal = new SeatRefusalError('not-provisioned', 'clone not provisioned: missing node_modules/.vite', 'create it after install')
    let calls = 0
    const { call, context } = await rig({
      plan: (spec) => {
        calls += 1
        return calls === 1 ? { ok: true, plan: makePlan({ chdir: spec.cwd }) } : { ok: false, refusal }
      },
    })
    // plan call 1 is the preflight probe; the re-test passes through the same function and is refused.
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('code=sandbox-plan-refused')
    expect(result.content[0]?.text).toContain('not-provisioned: clone not provisioned')
    expect(result.content[0]?.text).toContain('create it after install')
    expect(context.warnings.at(-1)).toContain('refused (sandbox-plan-refused)')
  })

  it('refuses with the builder\'s own code once the clone passed the re-test', async () => {
    const refusal = new SeatRefusalError('disk-floor', 'fewer than 1 GiB free', 'free disk space')
    let calls = 0
    const { call } = await rig({
      plan: (spec) => {
        calls += 1
        return calls <= 2 ? { ok: true, plan: makePlan({ chdir: spec.cwd }) } : { ok: false, refusal }
      },
    })
    const result = await call({ command: 'ls' })
    expect(result.content[0]?.text).toContain('status=refused code=disk-floor')
    expect(result.content[0]?.text).toContain('free disk space')
  })

  it('a launch that fails the re-test degrades the host, and the next call proves the sandbox again', async () => {
    const { call, world, host } = await rig()
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stderr: 'bwrap: nope' })
      handle.exit(1)
      return handle
    }
    const failed = await call({ command: 'ls' })
    expect(failed.content[0]?.text).toContain('code=sandbox-launch-failed')
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stdout: 'back' })
      handle.exit(0)
      return handle
    }
    const again = await call({ command: 'ls' })
    expect(again.isError).toBeUndefined()
    expect(host.acquire('coder-one')).toBe(true)
  })

  it('a runner failure degrades the host and is reported as an error', async () => {
    const { call, world, host } = await rig()
    await call({ command: 'warm' })
    world.stopSequence = [1]
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('status=runner-failure')
    // Calls are refused until a preflight passes; here the environment is fine again, so the next call re-proves it.
    const next = await call({ command: 'ls' })
    expect(next.isError).toBeUndefined()
    expect(host).toBeDefined()
  })

  it('a bwrap diagnostic on stderr degrades the host so the next call re-proves the sandbox', async () => {
    const { call, world } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stderr: 'bwrap: execvp: No such file' })
      handle.exit(1)
      return handle
    }
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('the command may not have run')
    const spawns = world.spawns.length
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stdout: 'fine' })
      handle.exit(0)
      return handle
    }
    expect((await call({ command: 'ls' })).isError).toBeUndefined()
    expect(world.spawns.length).toBeGreaterThan(spawns + 2)
  })
})

describe('bash tool: failures of the sandbox itself', () => {
  it('an unreadable cgroup.procs (EACCES) is an error result, degrades the host, and the next call is refused', async () => {
    const { call, world, host } = await rig()
    await call({ command: 'warm' })
    world.stopSequence = [0]
    world.cgroupExists = () => true
    world.procsThrows = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('status=runner-failure')
    expect(blocks(result)[0]).toContain('an unreadable process list (EACCES: permission denied)')
    const next = await call({ command: 'ls' })
    expect(next.isError).toBe(true)
    expect(blocks(next)[0]).toContain('status=refused code=sandbox-unavailable')
    expect(host.acquire('coder-one')).toBe(true)
  })

  it('a preflight that throws (a full disk, an unreadable sysctl) reaches the model as a refusal block, never a raw error', async () => {
    const { call, host, deps } = await rig()
    host.markDegraded('x')
    deps.makeScratch = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toMatch(/^\[dsh-bash\] status=refused code=sandbox-unavailable /)
    expect(blocks(result)[0]).toContain('preflight-error: the sandbox check could not complete: ENOSPC')
  })

  it('a systemd-run failure (exit 1, "Failed to ..." first on stderr) is a launcher failure that degrades the host', async () => {
    const { call, world } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stderr: 'Failed to start transient scope unit: Access denied\n' })
      handle.exit(1)
      return handle
    }
    const result = await call({ command: 'ls' })
    expect(result.isError).toBe(true)
    expect(blocks(result)[0]).toContain('sandbox launcher diagnostic')
    const spawns = world.spawns.length
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stdout: 'fine' })
      handle.exit(0)
      return handle
    }
    expect((await call({ command: 'ls' })).isError).toBeUndefined()
    expect(world.spawns.length).toBeGreaterThan(spawns + 2)
  })

  it('a command that prints "Failed to" later on stderr, or exits 0, is the command\'s own business', async () => {
    const { call, world } = await rig()
    await call({ command: 'warm' })
    world.makeLaunch = () => {
      const handle = new FakeHandle({ stderr: 'compiling\nFailed to open file x\n' })
      handle.exit(1)
      return handle
    }
    const spawns = world.spawns.length
    expect((await call({ command: 'make' })).isError).toBeUndefined()
    expect((await call({ command: 'make' })).isError).toBeUndefined()
    // Neither call re-ran the preflight: only launch and stop spawns happened.
    expect(world.spawns.length).toBe(spawns + 4)
  })

  it('unloading the plugin aborts a running call, whose sandbox is then stopped', async () => {
    for (const withSignal of [false, true]) {
      const { call, world, host } = await rig()
      await call({ command: 'warm' })
      world.makeLaunch = () => new FakeHandle()
      const before = world.spawns.length
      const running = call({ command: 'sleep 99' }, withSignal ? new AbortController().signal : undefined)
      await vi.waitFor(() => { expect(world.spawns.length).toBeGreaterThan(before) })
      host.unload()
      const result = await running
      expect(result.isError).toBe(true)
      expect(blocks(result)[0]).toContain('status=aborted')
      expect(world.spawns.at(-1)?.argv.slice(0, 3)).toEqual(['systemctl', '--user', 'stop'])
    }
  })
})
