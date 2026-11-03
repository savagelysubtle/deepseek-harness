import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { analyze, compile, COMPILED_SCRIPT_CONTRACT, WorkflowCompileError } from '../src/index.ts'
import type { WorkflowDoc } from '../src/index.ts'
import { FEATURE_LOOP, MAIL_TRIAGE } from './fixtures.ts'
import { runScript } from './script-harness.ts'

const docOf = (text: string): WorkflowDoc => {
  const result = analyze(text)
  if (!result.ok || result.doc === undefined) throw new Error(JSON.stringify(result.diagnostics))
  return result.doc
}

const HEAD = 'version: 1\nname: demo\ndescription: Demo.\n'

describe('compile', () => {
  it('produces a script that parses under the engine vm wrapper', () => {
    for (const text of [FEATURE_LOOP, MAIL_TRIAGE]) {
      const compiled = compile(docOf(text))
      expect(() => new vm.Script(`(async () => {\n${compiled.script}\n})()`)).not.toThrow()
      expect(compiled.script).not.toMatch(/\beval\b|new Function|`/)
    }
  })

  it('is deterministic and carries meta, manifest, and phases', () => {
    const doc = docOf(FEATURE_LOOP)
    const a = compile(doc)
    expect(compile(doc).script).toBe(a.script)
    expect(a.meta).toEqual({
      name: 'feature-loop',
      description: 'Plan, implement until checks pass, review, and ask for approval.',
      whenToUse: 'Use for a self-contained feature with a typecheck and test command.',
      phases: [{ title: 'Plan' }, { title: 'Implement' }],
    })
    expect(a.manifest.map(m => `${m.nodeId}:${m.gateKind}`)).toEqual([
      'implement:until_bash', 'gate-tests:bash', 'review:verifier', 'pass-check:bash', 'approve:approval',
    ])
  })

  it('only calls hooks and passes options the contract declares', async () => {
    const hooks = new Set<string>(COMPILED_SCRIPT_CONTRACT.hooks)
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'async'])
    const builtins = new Set(['String', 'Number', 'Error', 'Boolean', 'cond', 'body',
      'check']) // builtins plus the prelude's callback parameters
    for (const text of [FEATURE_LOOP, MAIL_TRIAGE]) {
      const compiled = compile(docOf(text))
      const script = compiled.script
      const defined = new Set([...script.matchAll(/\bconst ([A-Za-z_$][\w$]*) =/g)].map(m => m[1] ?? ''))
      const called = new Set([...script.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\(/g)].map(m => m[1] ?? ''))
      const foreign = [...called].filter(name => !defined.has(name) && !keywords.has(name) && !builtins.has(name))
      expect(foreign.filter(name => !hooks.has(name))).toEqual([])
      expect(foreign.sort()).toEqual(expect.arrayContaining(['agent', 'bash', 'approve', 'gate', 'nodeStart', 'nodeEnd', 'parallel']))
      const { harness } = await runScript(compiled, {
        agent: (_p, opts) => (opts.nodeId === 'review' || opts.nodeId === 'classify' ? { pass: true, urgent: ['x'] } : 'text'),
      }, { feature: 'f' })
      const allowed = (list: readonly string[], seen: Record<string, unknown>[]): string[] =>
        [...new Set(seen.flatMap(o => Object.keys(o)))].filter(k => !list.includes(k))
      expect(allowed(COMPILED_SCRIPT_CONTRACT.agentOptions, harness.agentCalls.map(c => c.opts))).toEqual([])
      expect(allowed(COMPILED_SCRIPT_CONTRACT.bashOptions, harness.bashCalls.map(c => c.opts))).toEqual([])
      expect(allowed(COMPILED_SCRIPT_CONTRACT.approveRequest, harness.approvals)).toEqual([])
      const statuses = harness.events.filter(e => e.startsWith('end ')).map(e => e.split(' ')[2] ?? '')
      expect(statuses.filter(st => !(COMPILED_SCRIPT_CONTRACT.nodeStatuses as readonly string[]).includes(st))).toEqual([])
      const outcomes = harness.events.filter(e => e.startsWith('gate ')).map(e => e.split(' ')[3] ?? '')
      expect(outcomes.filter(o => !(COMPILED_SCRIPT_CONTRACT.gateOutcomes as readonly string[]).includes(o))).toEqual([])
    }
  })

  it('caps values passed to bash by UTF-8 bytes, keeping the tail on a code point boundary', async () => {
    const compiled = compile(docOf(`${HEAD}inputs:\n  big:\n    type: string\nnodes:\n  - id: a\n    kind: bash\n`
        + '    bash: echo "$inputs.big"\n'))
    const emoji = '\u{1F600}'.repeat(20_000)
    const { harness } = await runScript(compiled, {}, { big: emoji })
    const value = (harness.bashCalls[0]?.opts.env as Record<string, string>).WF_INPUT_BIG ?? ''
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(32_768)
    expect(new TextEncoder().encode(value).length).toBeGreaterThan(32_768 - 4)
    expect(value.replaceAll('\u{1F600}', '')).toBe('')
    const small = await runScript(compiled, {}, { big: 'héllo' })
    expect((small.harness.bashCalls[0]?.opts.env as Record<string, string>).WF_INPUT_BIG).toBe('héllo')
  })

  it('does not retry a done_when check command', async () => {
    const compiled = compile(docOf(`${HEAD}defaults:\n  retry:\n    max_attempts: 3\nnodes:\n  - id: a\n`
        + '    kind: prompt\n    prompt: hi\n    done_when: "true"\n'))
    const { harness } = await runScript(compiled, {})
    expect(harness.agentCalls[0]?.opts.retry).toEqual({ maxAttempts: 3, delayMs: 0 })
    expect(harness.bashCalls[0]?.opts).not.toHaveProperty('retry')
  })

  it('never splices outputs into a bash command; they travel as WF_ env vars', async () => {
    const payload = '$(touch /tmp/pwned); `id`; \'"\\\n'
    const compiled = compile(docOf(`${HEAD}inputs:
  note:
    type: string
nodes:
  - id: first
    kind: bash
    bash: printf %s "$inputs.note"
  - id: second
    kind: bash
    depends_on: [first]
    bash: echo "$first.output" && echo "$first.exit_code"
`))
    expect(compiled.script).not.toContain('touch /tmp/pwned')
    const { harness } = await runScript(compiled, { bash: () => ({ exitCode: 0, stdout: `${payload}\n`, stderr: '' }) }, { note: payload })
    expect(harness.bashCalls[0]!.command).toBe('printf %s "${WF_INPUT_NOTE}"')
    expect((harness.bashCalls[0]!.opts.env as Record<string, string>).WF_INPUT_NOTE).toBe(payload)
    expect(harness.bashCalls[1]!.command).toBe('echo "${WF_FIRST_OUTPUT}" && echo "${WF_FIRST_EXIT_CODE}"')
    expect((harness.bashCalls[1]!.opts.env as Record<string, string>).WF_FIRST_OUTPUT).toBe(payload.trim())
    for (const call of harness.bashCalls) expect(call.command).not.toContain('pwned')
  })

  it('rejects node ids that are plain-object keys, so id-indexed maps stay sound', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const result = analyze(`${HEAD}nodes:\n  - id: ${id}\n    kind: bash\n    bash: echo a\n`)
      expect(result.ok).toBe(false)
      expect(result.diagnostics.some(d => d.code === 'node-id-invalid' && d.message.includes('reserved'))).toBe(true)
    }
  })

  it('rejects a NUL byte in a value passed to bash and a missing required input', async () => {
    const compiled = compile(docOf(`${HEAD}inputs:
  note:
    type: string
    required: true
nodes:
  - id: a
    kind: bash
    bash: echo "$inputs.note"
`))
    await expect(runScript(compiled, {}, {})).rejects.toThrow('missing required input: note')
    const { value } = await runScript(compiled, {}, { note: 'fine' })
    expect((value as { status: string }).status).toBe('completed')
    const nul = await runScript(compiled, {}, { note: 'a\u0000b' })
    expect(nul.value).toMatchObject({ status: 'failed' })
    expect(nul.harness.bashCalls).toHaveLength(0)
    expect(nul.harness.events).toContain('end a failed')
    expect(nul.harness.nodeErrors.a).toBe('output contained a NUL byte')
  })

  it('fails a node whose command contains a NUL byte without calling bash', async () => {
    const compiled = compile(docOf(`${HEAD}nodes:\n  - id: a\n    kind: bash\n    bash: "echo \\0"\n`))
    const { value, harness } = await runScript(compiled, {})
    expect(harness.bashCalls).toHaveLength(0)
    expect(harness.nodeErrors.a).toBe('output contained a NUL byte')
    expect(value).toMatchObject({ status: 'failed' })
  })

  it('coerces and validates typed inputs and applies defaults', async () => {
    const compiled = compile(docOf(`${HEAD}inputs:
  count:
    type: number
    default: 3
  flag:
    type: boolean
nodes:
  - id: a
    kind: bash
    bash: echo
    when: $inputs.count > 2 && $inputs.flag == true
`))
    const ran = await runScript(compiled, {}, { flag: 'true' })
    expect(ran.harness.bashCalls).toHaveLength(1)
    const skipped = await runScript(compiled, {}, { flag: false, count: '2' })
    expect(skipped.harness.bashCalls).toHaveLength(0)
    await expect(runScript(compiled, {}, { count: 'many' })).rejects.toThrow('must be a number')
  })

  describe('execution semantics', () => {
    const feature = compile(docOf(FEATURE_LOOP))

    it('runs the feature loop end to end and reports gates in order', async () => {
      const { value, harness } = await runScript(feature, {
        agent: (_p, opts) => (opts.nodeId === 'review' ? { pass: true, reasons: 'ok' } : `text from ${String(opts.nodeId)}`),
      }, { feature: 'dark mode' })
      expect((value as { status: string }).status).toBe('completed')
      expect(harness.agentCalls[0]!.prompt).toContain('dark mode')
      expect(harness.agentCalls[1]!.prompt).toContain('<workflow-data ref="plan.output">\ntext from plan\n</workflow-data>')
      expect(harness.events.filter(e => e.startsWith('gate'))).toEqual([
        'gate implement until_bash fired-pass', 'gate gate-tests bash fired-pass', 'gate review verifier fired-pass',
        'gate pass-check bash fired-pass', 'gate approve approval fired-pass',
      ])
      expect(harness.events).toContain('end stop-on-reject skipped')
      expect(harness.agentCalls[0]!.opts).toMatchObject({ nodeId: 'plan', tier: 'standard', phase: 'Plan', retry: { maxAttempts: 2,
        delayMs: 1000 } })
      expect(harness.agentCalls[2]!.opts).toMatchObject({ nodeId: 'review', tier: 'cheap', schema: { type: 'object' } })
    })

    it('feeds the failing until_bash evidence into the next loop iteration', async () => {
      let checks = 0
      const { harness } = await runScript(feature, {
        agent: (_p, opts) => (opts.nodeId === 'review' ? { pass: true } : 'x'),
        bash: (command) => {
          if (command.startsWith('pnpm run typecheck')) { checks += 1; return checks === 1 ? { exitCode: 2, stdout: 'TS2322 bad type',
            stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } }
          return { exitCode: 0, stdout: 'ok', stderr: '' }
        },
      }, { feature: 'x' })
      const implement = harness.agentCalls.filter(c => c.opts.nodeId === 'implement')
      expect(implement).toHaveLength(2)
      expect(implement[1]!.prompt).toContain('TS2322 bad type')
      expect(implement[1]!.prompt).toContain('exit code: 2')
    })

    it('fails a loop that never passes, with a fired-block gate', async () => {
      const { value, harness } = await runScript(feature, {
        bash: () => ({ exitCode: 1, stdout: 'boom', stderr: '' }),
      }, { feature: 'x' })
      expect(harness.agentCalls.filter(c => c.opts.nodeId === 'implement')).toHaveLength(5)
      expect(harness.events).toContain('gate implement until_bash fired-block')
      expect(harness.events).toContain('end gate-tests skipped')
      expect((value as { status: string }).status).toBe('failed')
    })

    it('cancels the run when the approval is rejected and the cancel node fires', async () => {
      await expect(runScript(feature, {
        agent: (_p, opts) => (opts.nodeId === 'review' ? { pass: true } : 'x'),
        approve: () => 'rejected',
      }, { feature: 'x' })).rejects.toThrow('CANCELLED: The reviewer rejected the change.')
    })

    it('skips on a false when, propagates skips, and lets all_done run', async () => {
      const { harness } = await runScript(feature, {
        agent: (_p, opts) => (opts.nodeId === 'review' ? { pass: false } : 'x'),
      }, { feature: 'x' })
      expect(harness.events).toContain('gate pass-check bash skipped')
      expect(harness.events).toContain('end approve skipped')
      expect(harness.events).toContain('end stop-on-reject skipped')
      expect(harness.approvals).toHaveLength(0)
    })

    it('runs a prompt done_when as a bounded continuation loop', async () => {
      const doc = docOf(`${HEAD}nodes:
  - id: fix
    kind: prompt
    prompt: fix it
    done_when: test -f done
    max_continuations: 2
`)
      const compiled = compile(doc)
      let checks = 0
      const pass = await runScript(compiled, { bash: () => { checks += 1; return { exitCode: checks === 1 ? 1 : 0, stdout: 'missing',
        stderr: '' } } })
      expect(pass.harness.agentCalls).toHaveLength(2)
      expect(pass.harness.events).toContain('gate fix done_when fired-pass')
      const fail = await runScript(compiled, { bash: () => ({ exitCode: 1, stdout: 'still missing', stderr: '' }) })
      expect(fail.harness.agentCalls).toHaveLength(2)
      expect(fail.harness.events).toContain('gate fix done_when fired-block')
      expect((fail.value as { nodes: { status: string }[] }).nodes[0]!.status).toBe('failed')
    })

    it('fails a prompt node without a gate event when the agent returns null', async () => {
      const compiled = compile(docOf(`${HEAD}nodes:
  - id: fix
    kind: prompt
    prompt: go
    done_when: "true"
`))
      const { value, harness } = await runScript(compiled, { agent: () => null })
      expect(harness.events.some(e => e.startsWith('gate'))).toBe(false)
      expect((value as { status: string }).status).toBe('failed')
    })

    it('honours trigger rules and inject_failure_to', async () => {
      const compiled = compile(docOf(`${HEAD}nodes:
  - id: check
    kind: bash
    bash: run-checks
    inject_failure_to: repair
  - id: repair
    kind: prompt
    depends_on: [check]
    trigger_rule: all_done
    mutates_checkout: false
    prompt: repair it
  - id: after
    kind: bash
    depends_on: [check]
    trigger_rule: none_failed_min_one_success
    bash: echo after
`))
      const { harness } = await runScript(compiled, { bash: () => ({ exitCode: 3, stdout: 'lint failed', stderr: '' }) })
      expect(harness.agentCalls[0]!.prompt).toContain('lint failed')
      expect(harness.events).toContain('end after skipped')
    })

    it('treats allow_failure as non-blocking and gate-less', async () => {
      const compiled = compile(docOf(`${HEAD}nodes:
  - id: soft
    kind: bash
    bash: maybe
    allow_failure: true
`))
      expect(compiled.manifest).toEqual([])
      const { value } = await runScript(compiled, { bash: () => ({ exitCode: 1, stdout: '', stderr: '' }) })
      expect(value).toMatchObject({ status: 'completed' })
    })

    it('reports a null parallel result as a failed node', async () => {
      const compiled = compile(docOf(`${HEAD}nodes:\n  - id: a\n    kind: bash\n    bash: x\n`))
      const { value } = await runScript(compiled, { bash: () => { throw new Error('infra') } })
      expect(value).toMatchObject({ status: 'failed', nodes: [{ id: 'a', status: 'failed' }] })
    })
  })

  describe('prompt_file', () => {
    const text = `${HEAD}nodes:
  - id: a
    kind: prompt
    prompt_file: prompts/a.md
    mutates_checkout: false
`
    it('embeds supplied prompt file text verbatim as a literal and lists it', () => {
      const compiled = compile(docOf(text), { promptFiles: { 'prompts/a.md': 'Do `things` with ${danger} and "quotes"' } })
      expect(compiled.promptFiles).toEqual(['prompts/a.md'])
      expect(() => new vm.Script(`(async () => {\n${compiled.script}\n})()`)).not.toThrow()
      expect(compiled.script).toContain(JSON.stringify('Do `things` with ${danger} and "quotes"'))
    })

    it('throws when the file was not supplied or references an unknown node', () => {
      expect(() => compile(docOf(text))).toThrow(WorkflowCompileError)
      expect(() => compile(docOf(text), { promptFiles: { 'prompts/a.md': 'see $ghost.output' } })).toThrow(/not an ancestor/)
    })
  })

  it('refuses a Fable model at compile time even if validation was bypassed', () => {
    const doc = docOf(`${HEAD}nodes:\n  - id: a\n    kind: prompt\n    prompt: hi\n    model: sonnet\n    mutates_checkout: false\n`)
    const node = doc.nodes[0]!
    if (node.kind === 'prompt') node.model = 'ｆａｂｌｅ-1'
    expect(() => compile(doc)).toThrow(/denied model/)
  })
})
