import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { internals, runOwners } from '../src/owners.ts'

/** Three seats, alpha and beta overlapping under src/shared; gamma disjoint. */
describe('runOwners', () => {
  let dirs: string[] = []
  const saved = { stdout: internals.stdout, stderr: internals.stderr }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
    Object.assign(internals, saved)
  })

  function setup(registryExtra = ''): { root: string; registryPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cli-owners-'))
    dirs.push(root)
    for (const file of ['src/a.ts', 'src/shared/s.ts', 'lib/x.ts', 'other/o.txt']) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), 'x')
    }
    const registryPath = join(root, 'registry.yml')
    writeFileSync(registryPath, [
      `baseDir: ${root}`,
      'seats:',
      '  alpha: { cwd: ., owns: ["src/**"] }',
      '  beta: { cwd: ., owns: ["src/shared"] }',
      '  gamma: { cwd: ., owns: ["lib/*.ts"] }',
      registryExtra,
      '',
    ].join('\n'))
    return { root, registryPath }
  }

  async function run(request: { path: string | undefined; overlaps: boolean }, options: Parameters<typeof runOwners>[1]) {
    let out = ''
    let err = ''
    Object.assign(internals, {
      stdout: { write: (text: string) => (out += text, true) },
      stderr: { write: (text: string) => (err += text, true) },
    })
    const code = await runOwners(request, options)
    return { code, out, err }
  }

  it('prints owned, unowned and doubly owned answers with exit 0', async () => {
    const { root, registryPath } = setup()
    expect(await run({ path: join(root, 'lib/x.ts'), overlaps: false }, { registryPath }))
      .toEqual({ code: 0, out: `${join(root, 'lib/x.ts')}: owned by gamma\n`, err: '' })
    expect(await run({ path: join(root, 'other/o.txt'), overlaps: false }, { registryPath }))
      .toEqual({ code: 0, out: `${join(root, 'other/o.txt')}: unowned\n`, err: '' })
    expect(await run({ path: join(root, 'src/shared/s.ts'), overlaps: false }, { registryPath }))
      .toEqual({ code: 0, out: `${join(root, 'src/shared/s.ts')}: doubly owned by alpha, beta\n`, err: '' })
  })

  it('resolves a relative path against the injected cwd and does not need it to exist', async () => {
    const { root, registryPath } = setup()
    const result = await run({ path: 'src/not-there.ts', overlaps: false }, { registryPath, cwd: root })
    expect(result).toEqual({ code: 0, out: `${join(root, 'src/not-there.ts')}: owned by alpha\n`, err: '' })
  })

  it('--overlaps lists the one overlapping pair and exits 1', async () => {
    const { root, registryPath } = setup()
    const result = await run({ path: undefined, overlaps: true }, { registryPath })
    expect(result.code).toBe(1)
    expect(result.err).toBe('')
    expect(result.out).toBe(`1 path(s) are owned by more than one seat.\nalpha and beta: 1 shared paths, e.g. ${join(root, 'src/shared/s.ts')}\n`)
  })

  it('--overlaps exits 0 with plain words when nothing overlaps', async () => {
    const { root } = setup()
    const registryPath = join(root, 'disjoint.yml')
    writeFileSync(registryPath, `baseDir: ${root}\nseats:\n  a: { cwd: ., owns: ["lib"] }\n  b: { cwd: ., owns: ["other"] }\n`)
    expect(await run({ path: undefined, overlaps: true }, { registryPath }))
      .toEqual({ code: 0, out: 'No overlaps: no path is owned by more than one seat.\n', err: '' })
  })

  it('--overlaps exits 2 and says so when the scan is capped', async () => {
    const { registryPath } = setup()
    const result = await run({ path: undefined, overlaps: true }, { registryPath, maxFiles: 1 })
    expect(result.code).toBe(2)
    expect(result.out).toMatch(/^The scan was capped after 1 files;/)
  })

  it('exits 2 on a usage error and on an unreadable registry, writing to stderr only', async () => {
    const { root, registryPath } = setup()
    const both = await run({ path: 'x', overlaps: true }, { registryPath })
    expect(both.code).toBe(2)
    expect(both.out).toBe('')
    expect(both.err).not.toBe('')
    const neither = await run({ path: undefined, overlaps: false }, { registryPath })
    expect(neither.code).toBe(2)
    const missing = await run({ path: 'x', overlaps: false }, { registryPath: join(root, 'nope.yml') })
    expect(missing.code).toBe(2)
    expect(missing.out).toBe('')
    expect(missing.err).toContain('cannot read the org registry')
  })

  it('writes nothing to disk: the registry file is untouched', async () => {
    const { registryPath } = setup()
    const { readFileSync } = await import('node:fs')
    const before = readFileSync(registryPath)
    await run({ path: undefined, overlaps: true }, { registryPath })
    expect(readFileSync(registryPath)).toEqual(before)
  })
})
