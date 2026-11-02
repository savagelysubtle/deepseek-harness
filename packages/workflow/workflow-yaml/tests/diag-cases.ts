/** Table of broken workflow files and the exact diagnostic each must produce. */

const HEAD = `version: 1
name: demo
description: Demo.
`

export interface DiagCase {
  title: string
  text: string
  code: string
  line: number
  column: number
  /** Substring the message must contain. */
  message: string
  severity?: 'error' | 'warning'
  /** Exact end position, when asserted. */
  end?: { line: number; column: number }
}

const node = (body: string): string => `${HEAD}nodes:\n${body}`

export const DIAG_CASES: DiagCase[] = [
  { title: 'yaml syntax error', text: 'version: 1\nname: [oops\n', code: 'parse-error', line: 3, column: 1, message: '' },
  { title: 'missing version', text: 'name: demo\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n',
    code: 'version-missing', line: 1, column: 1, message: "add 'version: 1'" },
  { title: 'wrong version', text: 'version: 2\nname: demo\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n',
    code: 'version-unsupported', line: 1, column: 10, message: 'version: 1' },
  { title: 'string version', text: 'version: "1"\nname: demo\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n',
    code: 'version-unsupported', line: 1, column: 10, message: 'unsupported version' },
  { title: 'missing name', text: 'version: 1\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n',
    code: 'missing-field', line: 1, column: 1, message: "'name'" },
  { title: 'bad name', text: 'version: 1\nname: Demo_Flow\ndescription: Demo.\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n',
    code: 'invalid-value', line: 2, column: 7, message: 'kebab-case' },
  { title: 'unknown top-level field', text: `${HEAD}colour: red\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n`,
    code: 'unknown-field', line: 4, column: 1, message: "'colour'" },
  { title: 'evidence rejected', text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    evidence: required\n'),
    code: 'rejected-field', line: 8, column: 5, message: "'evidence' is not supported" },
  { title: 'on_error rejected',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n    retry:\n      max_attempts: 2\n'
        + '      on_error: all\n'), code: 'rejected-field', line: 10, column: 7, message: "'on_error' is not supported" },
  { title: 'workflow key rejected', text: node('  - id: a\n    kind: bash\n    bash: echo\n    workflow: other\n'),
    code: 'rejected-field', line: 8, column: 5, message: 'not yet supported' },
  { title: 'include key rejected', text: `${HEAD}include: [other]\nnodes:\n  - id: a\n    kind: bash\n    bash: echo\n`,
    code: 'rejected-field', line: 4, column: 1, message: 'not yet supported' },
  { title: 'workflow kind rejected', text: node('  - id: a\n    kind: workflow\n    workflow: other\n'), code: 'kind-unsupported',
    line: 6, column: 11, message: 'workflow nodes are not supported in v1' },
  { title: 'unknown kind', text: node('  - id: a\n    kind: shell\n'), code: 'invalid-value', line: 6, column: 11,
    message: 'kind must be one of' },
  { title: 'field from another kind', text: node('  - id: a\n    kind: bash\n    bash: echo\n    prompt: hello\n'), code: 'unknown-field',
    line: 8, column: 5, message: "'prompt'" },
  { title: 'missing bash command', text: node('  - id: a\n    kind: bash\n'), code: 'missing-field', line: 5, column: 5,
    message: "'bash'" },
  { title: 'bad node id', text: node('  - id: Bad Id\n    kind: bash\n    bash: echo\n'), code: 'node-id-invalid', line: 5, column: 9,
    message: '[a-z0-9_-]' },
  { title: 'reserved node id', text: node('  - id: inputs\n    kind: bash\n    bash: echo\n'), code: 'node-id-invalid', line: 5,
    column: 9, message: 'reserved' },
  { title: 'duplicate node id', text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: a\n    kind: bash\n    bash: echo\n'),
    code: 'node-id-duplicate', line: 8, column: 9, message: "duplicate node id 'a'" },
  { title: 'unknown dependency', text: node('  - id: a\n    kind: bash\n    bash: echo\n    depends_on: [ghost]\n'), code: 'ref-unknown',
    line: 8, column: 18, message: "'ghost'" },
  { title: 'self dependency', text: node('  - id: a\n    kind: bash\n    bash: echo\n    depends_on: [a]\n'), code: 'self-dependency',
    line: 8, column: 18, message: 'itself' },
  { title: 'cycle', text: node('  - id: a\n    kind: bash\n    bash: echo\n    depends_on: [b]\n  - id: b\n'
      + '    kind: bash\n    bash: echo\n    depends_on: [a]\n'), code: 'cycle', line: 12, column: 18, message: 'a -> b -> a' },
  { title: 'when syntax error maps into scalar',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    depends_on: [a]\n    when: $a.status = \'success\'\n'), code: 'when-syntax', line: 12, column: 21,
    message: 'use "=="' },
  { title: 'when syntax error in quoted scalar',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    depends_on: [a]\n    when: "$a.status == \'x\' &&"\n'), code: 'when-syntax', line: 12, column: 31,
    message: 'expression ended' },
  { title: 'when parentheses',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    depends_on: [a]\n    when: ($a.status == \'x\')\n'), code: 'when-syntax', line: 12, column: 11,
    message: 'parentheses' },
  { title: 'when reference to a non-ancestor',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    when: $a.status == \'success\'\n'), code: 'ref-not-ancestor', line: 11, column: 11, message: 'depends_on' },
  { title: 'when reference to an unknown input',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n    when: $inputs.nope == \'x\'\n'), code: 'ref-unknown', line: 8, column: 11,
    message: 'not a declared input' },
  { title: 'template reference to a non-ancestor',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo $a.output\n'), code: 'ref-not-ancestor', line: 10, column: 16, message: 'bash: $a must come from a node' },
  { title: 'template reference inside a block scalar',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: prompt\n'
        + '    prompt: |\n      first line\n      then $ghost.output here\n'
        + '    mutates_checkout: false\n'), code: 'ref-unknown', line: 12, column: 12, message: 'ghost' },
  { title: 'bad trigger rule', text: node('  - id: a\n    kind: bash\n    bash: echo\n    trigger_rule: sometimes\n'),
    code: 'invalid-value', line: 8, column: 19, message: 'trigger_rule must be one of' },
  { title: 'retry out of range', text: node('  - id: a\n    kind: bash\n    bash: echo\n    retry:\n      max_attempts: 9\n'),
    code: 'out-of-range', line: 9, column: 21, message: 'between 1 and 5' },
  { title: 'denied model',
    text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    model: anthropic/fable-1\n'
        + '    mutates_checkout: false\n'), code: 'model-denied', line: 8, column: 12, message: 'Fable' },
  { title: 'premium needs justify',
    text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    tier: premium\n'
        + '    mutates_checkout: false\n'), code: 'justify-required', line: 8, column: 11, message: 'justify' },
  { title: 'prompt and prompt_file both set',
    text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    prompt_file: p.md\n'
        + '    mutates_checkout: false\n'), code: 'invalid-value', line: 8, column: 5, message: 'only one' },
  { title: 'prompt_file absolute', text: node('  - id: a\n    kind: prompt\n    prompt_file: /etc/passwd\n    mutates_checkout: false\n'),
    code: 'path-escape', line: 7, column: 18, message: 'absolute' },
  { title: 'prompt_file dot-dot', text: node('  - id: a\n    kind: prompt\n    prompt_file: ../secret.md\n    mutates_checkout: false\n'),
    code: 'path-escape', line: 7, column: 18, message: '".."' },
  { title: 'workdir escape', text: node('  - id: a\n    kind: bash\n    bash: echo\n    workdir: a/../../b\n'), code: 'path-escape',
    line: 8, column: 14, message: '".."' },
  { title: 'denied env var', text: node('  - id: a\n    kind: bash\n    bash: echo\n    env:\n      PATH: /tmp\n'), code: 'env-denied',
    line: 9, column: 7, message: 'PATH' },
  { title: 'loop needs max_iterations',
    text: node('  - id: a\n    kind: loop\n    prompt: hi\n    until_bash: "true"\n'
        + '    mutates_checkout: false\n'), code: 'missing-field', line: 5, column: 5, message: "'max_iterations'" },
  { title: 'loop iterations capped at 50',
    text: node('  - id: a\n    kind: loop\n    prompt: hi\n    until_bash: "true"\n'
        + '    max_iterations: 51\n'), code: 'out-of-range', line: 9, column: 21, message: 'between 1 and 50' },
  { title: 'max_continuations needs done_when',
    text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    max_continuations: 2\n'
        + '    mutates_checkout: false\n'), code: 'invalid-value', line: 8, column: 5, message: 'requires done_when' },
  { title: 'approval timeout over one hour', text: node('  - id: a\n    kind: approval\n    message: ok?\n    timeout_ms: 86400000\n'),
    code: 'out-of-range', line: 8, column: 17, message: 'between 1000 and 3600000' },
  { title: 'bash timeout over cap', text: node('  - id: a\n    kind: bash\n    bash: echo\n    timeout_ms: 700000\n'),
    code: 'out-of-range', line: 8, column: 17, message: '600000' },
  { title: 'unsupported context resume',
    text: node('  - id: a\n    kind: prompt\n    prompt: hi\n    context:\n      resume: x\n'
        + '    mutates_checkout: false\n'), code: 'unsupported', line: 9, column: 7, message: 'fresh' },
  { title: 'input default has the wrong type',
    text: `${HEAD}inputs:\n  count:\n    type: number\n    default: many\nnodes:\n`
        + '  - id: a\n    kind: bash\n    bash: echo\n', code: 'type-error', line: 7, column: 14, message: 'number' },
  { title: 'unverified mutating prompt is refused', text: node('  - id: a\n    kind: prompt\n    prompt: change things\n'),
    code: 'no-verify-step', line: 5, column: 9, message: "'a'" },
  { title: 'env name collision',
    text: node('  - id: a-b\n    kind: bash\n    bash: echo\n  - id: a_b\n    kind: bash\n'
        + '    bash: echo\n  - id: c\n    kind: bash\n    depends_on: [a-b, a_b]\n'
        + '    bash: echo $a-b.output $a_b.output\n'), code: 'env-collision', line: 14, column: 28, message: 'WF_A_B_OUTPUT' },
  { title: 'ref in single quotes warns',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    depends_on: [a]\n    bash: echo \'$a.output\'\n'), code: 'ref-in-single-quotes', line: 11, column: 17,
    message: 'double quotes', severity: 'warning' },
  { title: 'template reference with extra fields', text: node('  - id: a\n    kind: bash\n    bash: echo $a.status.x\n'),
    code: 'template-syntax', line: 7, column: 16, message: 'takes no further fields' },
  { title: 'blank prompt', text: node('  - id: a\n    kind: prompt\n    prompt: "  "\n    mutates_checkout: false\n'),
    code: 'empty-value', line: 7, column: 13, message: 'prompt must not be empty' },
  { title: 'name too long',
    text: `version: 1\nname: ${'a'.repeat(65)}\ndescription: d\nnodes:\n  - id: a\n`
        + '    kind: bash\n    bash: echo\n', code: 'too-long', line: 2, column: 7, message: 'longer than 64' },
  { title: 'duplicate depends_on entry',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    depends_on: [a, a]\n'), code: 'depends-duplicate', line: 11, column: 21, message: "'a' is listed twice" },
  { title: 'inject_failure_to unknown target', text: node('  - id: a\n    kind: bash\n    bash: echo\n    inject_failure_to: ghost\n'),
    code: 'ref-unknown', line: 8, column: 24, message: 'prompt or loop node' },
  { title: 'inject_failure_to not a descendant',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n    inject_failure_to: p\n  - id: p\n'
        + '    kind: prompt\n    prompt: hi\n    mutates_checkout: false\n'), code: 'ref-not-ancestor', line: 8, column: 24,
    message: 'must depend on this node' },
  { title: 'inject_failure_to target must run after failure',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n    inject_failure_to: p\n  - id: p\n'
        + '    kind: prompt\n    depends_on: [a]\n    prompt: hi\n'
        + '    mutates_checkout: false\n'), code: 'inject-trigger-rule', line: 8, column: 24, message: 'all_done' },
  { title: 'yaml directive warning', text: `%FOO bar\n---\n${HEAD}nodes:\n  - id: a\n    kind: bash\n    bash: echo\n`,
    code: 'yaml-warning', line: 1, column: 1, message: 'Unknown directive', severity: 'warning' },
  { title: 'when error inside a block scalar has a one-character span',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: bash\n'
        + '    bash: echo\n    depends_on: [a]\n    when: |\n      $a.status = \'x\'\n'), code: 'when-syntax', line: 13, column: 17,
    message: 'use "=="', end: { line: 13, column: 18 } },
  { title: 'template error inside a block scalar stays on its line',
    text: node('  - id: a\n    kind: bash\n    bash: echo\n  - id: b\n    kind: prompt\n'
        + '    prompt: |\n      first\n      then $ghost.output here\n      last line\n'
        + '    mutates_checkout: false\n'), code: 'ref-unknown', line: 12, column: 12, message: 'ghost', end: { line: 12, column: 25 } },
]
