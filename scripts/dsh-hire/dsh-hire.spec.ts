/**
 * dsh-hire candidate: the claude-code seat path (OP #292 S3 Step 7) and the
 * guarantee that a default hire is unchanged. Every run uses a temp HOME, a
 * temp registry (hire ignores DSH_HOME and reads DSH_ORG_REGISTRY) and PATH
 * shims for `dsh`, `curl` and `claude`; nothing here touches ~/.dsh or a live
 * host. The one comparison against the installed original is skipped when
 * that file does not exist.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'dsh-hire')
const ORIGINAL = '/home/steve/.local/bin/dsh-hire'
const SEAT_CONFIG = join(HERE, '../../packages/agent/agent-claude-code-driver/src/seat-config.ts')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  readonly root: string
  readonly home: string
  readonly registry: string
  readonly shims: string
  readonly dshLog: string
  /** Project directories by seat name. */
  readonly project: (seat: string) => string
}

const HEADER = '# org registry — hand-edited, keep this comment\n'

/** Block-style registry with comments, an existing default seat and an edge. */
const BASE_REGISTRY = `${HEADER}baseDir: @ROOT@
seats:
  # the lead
  alfred:
    cwd: alfred
    sessionId: named-alfred
  batman:
    cwd: batman # trailing comment kept
# edges between seats
edges:
- - alfred
  - batman
callUp: []
`

function rig(registryText: string = BASE_REGISTRY): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-hire-spec-')))
  dirs.push(root)
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
  const home = join(root, 'home')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  const registry = join(root, 'registry.yml')
  writeFileSync(registry, registryText.replaceAll('@ROOT@', root))
  expect(registry.startsWith(tmpdir()) || registry.startsWith(realpathSync(tmpdir()))).toBe(true)
  const shims = join(root, 'shims')
  mkdirSync(shims)
  const dshLog = join(root, 'dsh.log')
  const shim = (name: string, body: string): void => {
    writeFileSync(join(shims, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  shim('dsh', `{ printf 'ARGS:'; printf ' [%s]' "$@"; printf '\\n'; env | grep '^GIT_' | sort; printf 'PWD:%s\\n' "$PWD"; } >> "${dshLog}"`)
  shim('curl', 'exit 7')
  shim('claude', 'echo claude-shim')
  for (const seat of ['alfred', 'batman', 'claudie', 'plain']) mkdirSync(join(root, seat))
  return { root, home, registry, shims, dshLog, project: seat => join(root, seat) }
}

function run(
  r: Rig,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  script: string = SCRIPT,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [script, ...args], {
    env: {
      PATH: `${r.shims}:/usr/local/bin:/usr/bin:/bin`,
      HOME: r.home,
      DSH_ORG_REGISTRY: r.registry,
      DSH_HOST: 'http://127.0.0.1:9',
      DSH_HIRE_TEST: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    input: '',
  })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

const readRegistry = (r: Rig): string => readFileSync(r.registry, 'utf8')
const backups = (r: Rig): string[] => readdirSync(r.root).filter(name => name.startsWith('registry.yml.bak-'))
const derivedId = (seat: string): string => `named-${createHash('sha256').update(seat).digest('hex').slice(0, 32)}`

const HIRE_CC = (r: Rig, ...extra: string[]): string[] => [
  'claudie', '--driver', 'claude-code', '--model', 'haiku', '--project', r.project('claudie'), ...extra,
]

describe('paths', () => {
  it('keeps HOME and the registry under the OS temp dir', () => {
    const r = rig()
    expect(realpathSync(r.home).startsWith(realpathSync(tmpdir()))).toBe(true)
    expect(realpathSync(r.registry).startsWith(realpathSync(tmpdir()))).toBe(true)
  })
})

describe('model allowlist mirror', () => {
  it('has bash regex text equal to ALLOWED_MODEL in seat-config.ts', () => {
    const source = readFileSync(SEAT_CONFIG, 'utf8').match(/^const ALLOWED_MODEL = \/(.+)\/$/m)?.[1]
    const bash = readFileSync(SCRIPT, 'utf8').match(/^ALLOWED_MODEL_RE='(.+)'$/m)?.[1]
    expect(source).toBeDefined()
    expect(bash).toBe(source)
  })
})

describe('claude-code hire', () => {
  it('dry run writes nothing and spawns nothing, but prints the plan and stanza', () => {
    const r = rig()
    const before = readRegistry(r)
    const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--dry-run'))
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('dry run')
    expect(out.stdout).toContain(`session id  ${derivedId('claudie')}`)
    expect(out.stdout).toContain('host-config stanza')
    expect(readRegistry(r)).toBe(before)
    expect(existsSync(r.dshLog)).toBe(false)
    expect(backups(r)).toEqual([])
  })

  it('inserts a block-style row before the next top-level key and preserves every comment', () => {
    const r = rig()
    const out = run(r, HIRE_CC(r, '--admit-from', 'alfred'))
    expect(out.status, out.stderr).toBe(0)
    const text = readRegistry(r)
    const expectedRow = [
      '  claudie:',
      `    cwd: "${r.project('claudie')}"`,
      `    sessionId: ${derivedId('claudie')}`,
      '    driver: claude-code',
      '    admit_from:',
      '    - alfred',
      '    admit_sender_classes:',
      '    - seat',
      '',
    ].join('\n')
    // The row sits directly above the comment that introduces the next top-level key.
    expect(text).toContain(`${expectedRow}# edges between seats\nedges:`)
    expect(text.startsWith(HEADER)).toBe(true)
    expect(text).toContain('  # the lead\n')
    expect(text).toContain('cwd: batman # trailing comment kept')
    // Removing the inserted row restores the original byte for byte.
    expect(text.replace(expectedRow, '')).toBe(BASE_REGISTRY.replaceAll('@ROOT@', r.root))
    expect(existsSync(r.dshLog)).toBe(false)
    expect(out.stdout).toContain('served by the mail bridge; first mail starts it; refused until the host-config stanza below is added')
    expect(out.stdout).toContain('no edge yet between claudie and: alfred')
  })

  it('writes test: true for a --test seat', () => {
    const r = rig()
    const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--test'))
    expect(out.status, out.stderr).toBe(0)
    expect(readRegistry(r)).toContain('    - seat\n    test: true\n')
  })

  it('writes a timestamped backup of the registry it replaced', () => {
    const r = rig()
    const before = readRegistry(r)
    expect(run(r, HIRE_CC(r)).status).toBe(0)
    const found = backups(r)
    expect(found).toHaveLength(1)
    expect(readFileSync(join(r.root, found[0] ?? ''), 'utf8')).toBe(before)
    expect(readRegistry(r)).toContain('admit_from: []')
  })

  it('prints the stanza with session_id, the pinned cwd, the resolved claude path and the A6 warning', () => {
    const r = rig()
    const out = run(r, HIRE_CC(r, '--admit-from', 'alfred'))
    expect(out.stdout).toContain(`session_id: ${derivedId('claudie')}`)
    expect(out.stdout).toContain(`cwd: ${r.project('claudie')}`)
    expect(out.stdout).toContain(`claude_path: ${join(r.shims, 'claude')}`)
    expect(out.stdout).toContain('admit_from_ceiling: [alfred]')
    expect(out.stdout).toContain('model: haiku')
    expect(out.stdout).toContain('role: mail-only')
    expect(out.stdout).toContain('must verify claude_path and its sha256 independently')
    expect(out.stdout).toContain('prefix in claudePathPrefixes limits the damage')
    expect(readRegistry(r)).not.toContain('claude_path')
    expect(readRegistry(r)).not.toContain('haiku')
  })

  it('accepts a lead: routing-only row, stanza carries the policy placeholders and the warnings', () => {
    const r = rig()
    const out = run(r, HIRE_CC(r, '--role', 'lead', '--admit-from', 'alfred'))
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('role: lead')
    expect(out.stdout).toContain('tools: [mailbox_send, mailbox_directory]')
    expect(out.stdout).toContain('send_to: []')
    expect(out.stdout).toContain('allow_blocking: false')
    expect(out.stdout).not.toMatch(/^\s+rules_dir:/m)
    expect(out.stdout).toContain('attests it is not externally exposed')
    expect(out.stdout).toContain('must verify claude_path and its sha256 independently')
    const row = readRegistry(r)
    for (const key of ['tools', 'send_to', 'allow_blocking', 'rules_dir', 'role', 'mailbox_send']) {
      expect(row).not.toMatch(new RegExp(`^\\s+${key}:`, 'm'))
    }
    expect(row).toContain('driver: claude-code')
    expect(row).toContain('admit_from:')
  })

  it('a mail-only stanza has no policy fields', () => {
    const r = rig()
    const out = run(r, HIRE_CC(r))
    expect(out.stdout).not.toContain('send_to:')
    expect(out.stdout).not.toContain('tools: [')
    expect(out.stdout).toContain('attests it is not externally exposed')
  })

  it('is idempotent: an existing matching row is left alone', () => {
    const r = rig()
    expect(run(r, HIRE_CC(r, '--admit-from', 'alfred')).status).toBe(0)
    // The edge cannot exist before the row does; the founder adds it afterwards.
    writeFileSync(r.registry, readRegistry(r).replace('- - alfred\n  - batman\n', '- - alfred\n  - batman\n- - alfred\n  - claudie\n'))
    const after = readRegistry(r)
    const again = run(r, HIRE_CC(r, '--admit-from', 'alfred'))
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('already matches')
    expect(readRegistry(r)).toBe(after)
  })

  describe('refusals', () => {
    it.each([
      ['coder', ['--role', 'coder'], 'coder rows are refused until the sandbox (S6) and canary (S7) readiness exist'],
      ['a policy key on the command line (tools)', ['--role', 'lead', '--tools', 'x'], 'belong in the host profile only'],
      ['a policy key on the command line (send-to)', ['--role', 'lead', '--send-to', 'x'], 'the driver refuse the seat at create'],
      ['a policy key on the command line (allow-blocking)', ['--role', 'lead', '--allow-blocking'], 'belong in the host profile only'],
      ['a policy key on the command line (rules-dir)', ['--role', 'lead', '--rules-dir', 'x'], 'belong in the host profile only'],
      ['an unknown role', ['--role', 'boss'], 'unknown role'],
      ['a fable model', ['--model', 'fable-5'], 'fable'],
      ['a mixed-case fable model', ['--model', 'Claude-FABLE-1'], 'fable'],
      ['an off-allowlist model', ['--model', 'gpt-5'], 'allowlist'],
      ['a model with a newline', ['--model', 'haiku\nopus'], 'newline'],
      ['unverified', ['--admit', 'unverified'], 'S3 admits roster seats only; guest admission is an S8 item'],
      ['unverified even with --test', ['--admit', 'seat,unverified', '--test'], 'guest admission is an S8 item'],
      ['an unknown class', ['--admit', 'guest'], 'guest admission is an S8 item'],
    ])('refuses %s and writes nothing', (_name, extra, message) => {
      const r = rig()
      const before = readRegistry(r)
      const args = HIRE_CC(r, ...extra)
      // A later --model/--role replaces the earlier default; the last one wins.
      const out = run(r, args)
      expect(out.status).toBe(1)
      expect(out.stderr).toContain(message)
      expect(readRegistry(r)).toBe(before)
      expect(backups(r)).toEqual([])
    })

    it('refuses --admit-from naming a seat that is not in the registry', () => {
      const r = rig()
      const out = run(r, HIRE_CC(r, '--admit-from', 'ghost'))
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('"ghost", which is not a seat')
    })

    it('has no --claude-path or --effort', () => {
      const r = rig()
      expect(run(r, HIRE_CC(r, '--claude-path', '/bin/claude')).stderr).toContain('unknown option: --claude-path')
      expect(run(r, HIRE_CC(r, '--effort', 'high')).stderr).toContain('unknown option: --effort')
    })

    it('rejects claude-code-only flags on a default hire', () => {
      const r = rig()
      const out = run(r, ['alfred', '--model', 'haiku', '--dry-run'])
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('--model only applies with --driver claude-code')
    })

    it('refuses to change an existing default seat into claude-code', () => {
      const r = rig()
      const before = readRegistry(r)
      const out = run(r, ['batman', '--driver', 'claude-code', '--model', 'haiku', '--project', r.project('batman')])
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('never changes an existing driver')
      expect(readRegistry(r)).toBe(before)
    })
  })

  describe('an existing claude-code row', () => {
    const EXISTING = BASE_REGISTRY.replace('# edges between seats', `  claudie:
    cwd: @ROOT@/claudie
    sessionId: named-oldoldoldoldoldoldoldoldoldoldol
    driver: claude-code
    admit_from:
    - alfred
    admit_sender_classes:
    - seat
# edges between seats`).replace('- - alfred\n  - batman\n', '- - alfred\n  - batman\n- - alfred\n  - claudie\n')

    it('refuses a mismatching request and writes nothing', () => {
      const r = rig(EXISTING)
      const before = readRegistry(r)
      const out = run(r, HIRE_CC(r))
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('already exists with a different row')
      expect(out.stderr).toContain('admit_from')
      expect(readRegistry(r)).toBe(before)
    })

    it('refuses --admit-from without an edge when the seat already exists', () => {
      const r = rig(EXISTING.replace('- - alfred\n  - claudie\n', ''))
      const out = run(r, HIRE_CC(r, '--admit-from', 'alfred'))
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('have no edge to "claudie"')
    })

    it('accepts a matching request, reusing the recorded session id', () => {
      const r = rig(EXISTING)
      const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--dry-run'))
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toContain('session id  named-oldoldoldoldoldoldoldoldoldoldol')
    })

    describe('--reseed', () => {
      it('is refused without a terminal or DSH_HIRE_FOUNDER=1', () => {
        const r = rig(EXISTING)
        const before = readRegistry(r)
        const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--reseed'))
        expect(out.status).toBe(1)
        expect(out.stderr).toContain('founder action')
        expect(readRegistry(r)).toBe(before)
      })

      it('is allowed with DSH_HIRE_FOUNDER=1: new id pinned, old log left, guidance printed', () => {
        const r = rig(EXISTING)
        const oldId = 'named-oldoldoldoldoldoldoldoldoldoldol'
        const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--reseed'), { DSH_HIRE_FOUNDER: '1' })
        expect(out.status, out.stderr).toBe(0)
        const text = readRegistry(r)
        expect(text).not.toContain(oldId)
        const fresh = text.match(/sessionId: (named-[0-9a-f]{32})\n {4}driver: claude-code/)?.[1]
        expect(fresh).toBeDefined()
        expect(out.stdout).toContain(`old session id  ${oldId}`)
        expect(out.stdout).toContain(`new session id  ${fresh}`)
        expect(out.stdout).toContain(`session_id: ${fresh}`)
        expect(out.stdout).toContain('call-window counters are pinned per seat')
        expect(out.stdout).toContain('the pause resets on the next restart')
        expect(out.stdout).toContain('git-identity email changes')
        expect(backups(r)).toHaveLength(1)
        // Everything else is untouched.
        expect(text.replace(fresh ?? '', oldId)).toBe(EXISTING.replaceAll('@ROOT@', r.root))
      })

      it('warns loudly when the old session lock shows a live holder', () => {
        const r = rig(EXISTING)
        const locks = join(r.home, '.dsh', 'headless', 'locks')
        mkdirSync(locks, { recursive: true })
        writeFileSync(join(locks, 'oldoldoldoldoldoldoldoldoldoldol.lock'), JSON.stringify({ pid: process.pid }))
        const out = run(r, HIRE_CC(r, '--admit-from', 'alfred', '--reseed'), { DSH_HIRE_FOUNDER: '1' })
        expect(out.status, out.stderr).toBe(0)
        expect(out.stdout).toContain('WARNING: the OLD session')
        expect(out.stdout).toContain(`LIVE process (pid ${String(process.pid)})`)
      })

      it('needs an existing row', () => {
        const r = rig()
        const out = run(r, HIRE_CC(r, '--reseed'), { DSH_HIRE_FOUNDER: '1' })
        expect(out.status).toBe(1)
        expect(out.stderr).toContain('needs an existing claude-code row')
      })
    })
  })

  describe('input hygiene', () => {
    it.each([
      ['whitespace in --admit-from', ['--admit-from', 'alfred, batman'], 'without whitespace'],
      ['a newline in --admit', ['--admit', 'seat\nunverified'], 'without whitespace'],
      ['an empty --admit-from entry', ['--admit-from', 'alfred,,batman'], 'empty entries'],
      ['a trailing comma', ['--admit', 'seat,'], 'empty entries'],
      ['an empty --admit', ['--admit', ''], '--admit needs classes'],
    ])('refuses %s', (_n, extra, message) => {
      const r = rig()
      const out = run(r, HIRE_CC(r, ...extra))
      expect(out.status).toBe(1)
      expect(out.stderr).toContain(message)
    })

    it('ignores the test seams unless DSH_HIRE_TEST=1', () => {
      const r = rig()
      const out = run(r, HIRE_CC(r), { DSH_HIRE_TEST: '0', DSH_HIRE_FORCE_VERIFY_FAIL: '1' })
      expect(out.status, out.stderr).toBe(0)
    })
  })

  describe('lost update', () => {
    it('refuses to write over a change that landed after planning, leaving the concurrent edit', () => {
      const r = rig()
      const hookPath = join(r.root, 'before-writer.sh')
      writeFileSync(hookPath, '#!/usr/bin/env bash\nprintf "# landed first\\n" >> "$1"\n')
      chmodSync(hookPath, 0o755)
      const original = readRegistry(r)
      const out = run(r, HIRE_CC(r), { DSH_HIRE_HOOK_BEFORE_WRITE: hookPath })
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('registry changed while this run was planned; nothing written')
      expect(readRegistry(r)).toBe(`${original}# landed first\n`)
      expect(backups(r).length).toBeGreaterThan(0)
    })
  })

  describe('failed verify', () => {
    const hook = (r: Rig, line: string): string => {
      const path = join(r.root, 'concurrent-writer.sh')
      writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s\\n' "${line}" >> "$1"\n`)
      chmodSync(path, 0o755)
      return path
    }

    it('removes only the inserted row and leaves a concurrent edit intact', () => {
      const r = rig()
      const original = readRegistry(r)
      const out = run(r, HIRE_CC(r, '--admit-from', 'alfred'), {
        DSH_HIRE_FORCE_VERIFY_FAIL: '1',
        DSH_HIRE_HOOK_AFTER_WRITE: hook(r, '# concurrent UI edit'),
      })
      expect(out.status).toBe(1)
      expect(out.stderr).toContain('removed only the inserted row')
      expect(readRegistry(r)).toBe(`${original}# concurrent UI edit\n`)
      expect(backups(r)).toHaveLength(1)
    })

    it('restores only the sessionId line on a failed reseed', () => {
      const existing = BASE_REGISTRY.replace('# edges between seats', `  claudie:
    cwd: @ROOT@/claudie
    sessionId: named-oldoldoldoldoldoldoldoldoldoldol
    driver: claude-code
    admit_from: []
    admit_sender_classes:
    - seat
# edges between seats`)
      const r = rig(existing)
      const original = readRegistry(r)
      const out = run(r, HIRE_CC(r, '--reseed'), {
        DSH_HIRE_FOUNDER: '1',
        DSH_HIRE_FORCE_VERIFY_FAIL: '1',
        DSH_HIRE_HOOK_AFTER_WRITE: hook(r, '# concurrent UI edit'),
      })
      expect(out.status).toBe(1)
      expect(readRegistry(r)).toBe(`${original}# concurrent UI edit\n`)
    })
  })
})

describe('default hire is unchanged', () => {
  const FLOW = `baseDir: @ROOT@
seats:
  plain: { cwd: plain }
`

  it('spawns dsh with the same command line, environment and registry pin as before', () => {
    const r = rig(FLOW)
    const out = run(r, ['plain', '--generic'])
    expect(out.status, out.stderr).toBe(0)
    const id = derivedId('plain')
    const log = readFileSync(r.dshLog, 'utf8')
    expect(log).toContain(`ARGS: [--profile] [headless] [--session-name] [plain] [--session-id] [${id}] [You are plain. Write a memory recording your seat name and that you were hired on `)
    expect(log).toContain('GIT_AUTHOR_NAME=plain')
    expect(log).toContain(`GIT_AUTHOR_EMAIL=plain+${id}@steveweb.dev`)
    expect(log).toContain(`PWD:${r.project('plain')}`)
    expect(out.stdout).toContain(`identity pinned in registry: plain -> ${id}`)
    expect(readRegistry(r)).toContain(`plain: { cwd: plain, sessionId: ${id} }`)
  })

  it('--dry-run spawns nothing', () => {
    const r = rig(FLOW)
    const out = run(r, ['plain', '--generic', '--dry-run'])
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('dry run — nothing spawned')
    expect(existsSync(r.dshLog)).toBe(false)
  })

  it.skipIf(!existsSync(ORIGINAL))('matches the installed original byte for byte under the same shims', () => {
    const stable = { 'date-free': '1' }
    const a = rig(FLOW)
    const b = rig(FLOW)
    // Same project paths in the output need the same root: run each in its own rig and
    // normalise only the rig root.
    const mine = run(a, ['plain', '--generic', '--no-spawn'], stable)
    const theirs = run(b, ['plain', '--generic', '--no-spawn'], stable, ORIGINAL)
    const norm = (text: string, root: string): string => text.replaceAll(root, '<ROOT>').replace(/(memory +~\/\.dsh\/memory\/)\S+/, '$1<MEM>')
    expect(mine.status).toBe(theirs.status)
    expect(norm(mine.stdout, a.root)).toBe(norm(theirs.stdout, b.root))
    expect(norm(mine.stderr, a.root)).toBe(norm(theirs.stderr, b.root))
    expect(norm(readRegistry(a), a.root)).toBe(norm(readRegistry(b), b.root))
    const spawnA = run(a, ['plain', '--generic'], stable)
    const spawnB = run(b, ['plain', '--generic'], stable, ORIGINAL)
    expect(spawnA.status).toBe(spawnB.status)
    const strip = (text: string, root: string): string => text.replaceAll(root, '<ROOT>')
    expect(strip(readFileSync(a.dshLog, 'utf8'), a.root)).toBe(strip(readFileSync(b.dshLog, 'utf8'), b.root))
  })
})
