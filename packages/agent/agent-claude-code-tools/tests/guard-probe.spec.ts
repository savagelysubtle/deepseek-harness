import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attestFile } from '../src/attest-guard.ts'
import { createGuardProbe, RESERVED_PROBE_SEAT } from '../src/guard-probe.ts'
import type { GuardProbeDeps, GuardProbeResult } from '../src/guard-probe.ts'
import { installGuardCopy } from '../src/guard-copy.ts'
import { installRealGuard, makeSandbox } from './helpers.ts'
import type { Sandbox } from './helpers.ts'

let box: Sandbox
let node: string
let guard: string
let policyDir: string

beforeEach(() => {
  box = makeSandbox()
  ;({ node, guard } = installRealGuard(box.root))
  policyDir = join(box.root, 'policy')
})
afterEach(() => {
  box.cleanup()
})

function deps(over: Partial<GuardProbeDeps> = {}): GuardProbeDeps {
  return {
    policyDir,
    home: box.home,
    attest: () => ({ node: attestFile(node, { access: 'exec' }), guard: installGuardCopy(policyDir, attestFile(guard, { access: 'read' })) }),
    policyIntact: () => true,
    ...over,
  }
}

/** A guard script that denies the unknown tool correctly and behaves as told for the other two payloads. */
function fakeGuard(edit: 'allow' | 'wrong' | 'protected', read: 'allow' | 'deny' | 'noisy', extra = ''): void {
  writeFileSync(guard, `
const chunks = []
process.stdin.on('data', c => chunks.push(c))
process.stdin.on('end', () => {
  const name = JSON.parse(Buffer.concat(chunks).toString()).tool_name
  const deny = (text) => { process.stderr.write('seat-guard: denied: ' + text); process.exit(2) }
  if (name === '__seat_guard_probe__') deny('tool __seat_guard_probe__ is not granted to this seat')
  if (name === 'Edit') {
    if ('${edit}' === 'protected') deny('file_path: path is inside the protected location /x/.git')
    if ('${edit}' === 'wrong') deny('something else')
    process.exit(0)
  }
  ${extra}
  if ('${read}' === 'deny') deny('file_path: path is inside the protected location /x/.git')
  if ('${read}' === 'noisy') process.stderr.write('noise')
  process.exit(0)
})
`)
}

async function run(over: Partial<GuardProbeDeps> = {}, signal?: AbortSignal): Promise<GuardProbeResult> {
  return createGuardProbe(deps(over)).probe(signal)
}

function failure(result: GuardProbeResult): { code: string; reason: string } {
  if (result.ok) throw new Error('expected a failed probe')
  return result
}

describe('guard probe', () => {
  it('passes the genuine built guard and returns the attested hashes', async () => {
    const result = await run()
    expect(result).toEqual({
      ok: true,
      nodeSha256: attestFile(node, { access: 'exec' }).sha256,
      guardSha256: attestFile(join(policyDir, 'seat-guard.js'), { access: 'read' }).sha256,
      policySha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    })
  })

  it('leaves nothing behind in the policy directory and writes no policy for a real seat name', async () => {
    await run()
    expect(readdirSync(policyDir).sort()).toEqual(['seat-guard.js'])
    expect(RESERVED_PROBE_SEAT).toBe('dsh-canary-probe')
  })

  it('cleans up after a failure too', async () => {
    fakeGuard('allow', 'allow')
    expect((await run()).ok).toBe(false)
    expect(readdirSync(policyDir).sort()).toEqual(['seat-guard.js'])
  })

  it('code attest: node or guard cannot be attested', async () => {
    const result = failure(await run({ attest: () => { throw new Error('cannot resolve it') } }))
    expect(result).toEqual({ ok: false, code: 'attest', reason: 'cannot resolve it' })
    expect(failure(await run({ attest: () => { throw 'plain' } })).reason).toBe('plain')
  })

  it('code spawn: the shell is missing (ENOENT) or not executable (EACCES)', async () => {
    expect(failure(await run({ shell: join(box.root, 'no-shell') }))).toMatchObject({ code: 'spawn', reason: expect.stringContaining('ENOENT') as string })
    const plain = join(box.root, 'plain')
    writeFileSync(plain, 'x')
    expect(failure(await run({ shell: plain }))).toMatchObject({ code: 'spawn', reason: expect.stringContaining('EACCES') as string })
  })

  it('code timeout: a hook that hangs is killed and never counted as a pass', async () => {
    const shell = join(box.root, 'hang-shell')
    writeFileSync(shell, '#!/bin/sh\nexec sleep 5\n')
    chmodSync(shell, 0o755)
    expect(failure(await run({ shell, timeoutMs: 150 })).code).toBe('timeout')
  })

  it('code spawn: an abort ends the run as a failure', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(failure(await run({}, controller.signal))).toMatchObject({ code: 'spawn', reason: expect.stringContaining('aborted') as string })
  })

  it('code exit: a guard that starts but allows (fails open) or cannot start', async () => {
    writeFileSync(guard, 'process.exit(0)\n')
    expect(failure(await run()).code).toBe('exit')
    writeFileSync(guard, 'this is not javascript (\n')
    expect(failure(await run()).code).toBe('exit')
  })

  it('code reason: a denial that is not the guard speaking about the unknown tool', async () => {
    writeFileSync(guard, 'process.stderr.write("seat-guard: denied: whatever"); process.exit(2)\n')
    expect(failure(await run()).code).toBe('reason')
  })

  it('refuses a guard that denies the unknown tool but allows an edit of .git/config', async () => {
    fakeGuard('allow', 'allow')
    expect(failure(await run())).toMatchObject({ code: 'exit', reason: expect.stringContaining('did not deny the probe (exit 0)') as string })
  })

  it('refuses a guard that denies the .git/config edit for the wrong reason', async () => {
    fakeGuard('wrong', 'allow')
    expect(failure(await run()).code).toBe('reason')
  })

  it('code control: an always-deny fake (it denies the granted read) is not a guard', async () => {
    fakeGuard('protected', 'deny')
    expect(failure(await run())).toMatchObject({ code: 'control', reason: expect.stringContaining('did not allow the granted control (exit 2)') as string })
  })

  it('code control: a granted read that writes to stderr is refused', async () => {
    fakeGuard('protected', 'noisy')
    expect(failure(await run()).code).toBe('control')
  })

  it('accepts a minimal fake that satisfies all three probes (the negative control is what defeats an always-deny fake)', async () => {
    fakeGuard('protected', 'allow')
    expect((await run()).ok).toBe(true)
  })

  it('code changed: the node binary changes while the probe runs', async () => {
    fakeGuard('protected', 'allow', `require('node:fs').appendFileSync(${JSON.stringify(node)}, '# swapped\\n')`)
    expect(failure(await run())).toMatchObject({ code: 'changed' })
  })

  it('code changed: the policy file no longer holds its bytes', async () => {
    expect(failure(await run({ policyIntact: () => false }))).toEqual({ ok: false, code: 'changed', reason: 'policy file changed' })
  })

  it('code error: a policy that cannot be generated (policy directory under a regular file)', async () => {
    const blocker = join(box.root, 'blocker')
    writeFileSync(blocker, 'x')
    const result = failure(await run({ policyDir: join(blocker, 'dir') }))
    expect(result.code).toBe('error')
  })

  it('code error: no temp directory (never rejects)', async () => {
    const saved = process.env['TMPDIR']
    process.env['TMPDIR'] = join(box.root, 'no-such-tmp')
    try {
      expect(failure(await run()).code).toBe('error')
    } finally {
      if (saved === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = saved
    }
  })

  it('does not leave its scratch directory in the temp directory', async () => {
    const before = readdirSync(process.env['TMPDIR'] ?? '/tmp').filter(name => name.startsWith('dsh-canary-')).length
    await run()
    expect(readdirSync(process.env['TMPDIR'] ?? '/tmp').filter(name => name.startsWith('dsh-canary-')).length).toBe(before)
    expect(existsSync(join(policyDir, 'dsh-canary-probe.json'))).toBe(false)
  })
})
