import { describe, expect, it } from 'vitest'
import { emitWhen, parseWhen, refEnvName, scanTemplate, whenRefs, WhenSyntaxError } from '../src/when.ts'

describe('when grammar', () => {
  it('parses && binding tighter than ||', () => {
    const expr = parseWhen("$a.status == 'success' && $b.exit_code == 0 || $c.output")
    expect(expr.t).toBe('or')
    expect(emitWhen(expr)).toBe('((C("==",R("a","status",[]),"success") && C("==",R("b","exit_code",[]),0)) || T(R("c","output",[])))')
  })

  it('collects references in order', () => {
    const refs = whenRefs(parseWhen("$x.output.pass == true && $inputs.mode != 'fast'"))
    expect(refs.map(r => `${r.kind}:${r.id}:${r.path.join('.')}`)).toEqual(['output:x:pass', 'input:mode:'])
  })

  it('emits user text only as JSON string literals', () => {
    const hostile = parseWhen('$a.output == \'"); process.exit(1); ("\'')
    const js = emitWhen(hostile)
    expect(js).toBe('C("==",R("a","output",[]),"\\"); process.exit(1); (\\"")')
    expect(js.includes('process')).toBe(true)
    expect(js.startsWith('C("==",R("a","output",[]),"')).toBe(true)
  })

  it.each([
    ['=', 'use "=="', 0],
    ['$a.status == ', 'expression ended', 13],
    ['$a.status == \'x', 'unterminated', 13],
    ['($a.output)', 'parentheses', 0],
    ['!$a.output', '"!" is not supported', 0],
    ['$a.output & $b.output', 'expected "&&"', 10],
    ['$a.output | 1', 'expected "||"', 10],
    ['$a.output == 1 == 2', 'only one comparison', 15],
    ['$a.output $b.output', 'unexpected token', 10],
    ['yes', 'unexpected word "yes"', 0],
    ['$a.bogus', 'unknown reference property "bogus"', 0],
    ['$a.status.x', 'takes no further fields', 0],
    ['$inputs', 'input reference', 0],
    ['$inputs.A', 'input reference', 0],
    ['$', 'expected a reference', 0],
    ['@', 'unexpected character "@"', 0],
    ['', 'expression ended', 0],
  ])('reports %j with offset', (text, message, offset) => {
    try {
      parseWhen(text)
      expect.unreachable(`parsed ${text}`)
    } catch (error) {
      expect(error).toBeInstanceOf(WhenSyntaxError)
      expect((error as WhenSyntaxError).message).toContain(message)
      expect((error as WhenSyntaxError).offset).toBe(offset)
    }
  })

  it('supports numbers, booleans, both quote styles, and escapes', () => {
    expect(emitWhen(parseWhen('$a.exit_code >= -1.5 && $b.output == "it\'s" && $c.output != \'a\\\'b\' && true == false'))).toBe(
      '(C(">=",R("a","exit_code",[]),-1.5) && C("==",R("b","output",[]),"it\'s") && '
        + 'C("!=",R("c","output",[]),"a\'b") && C("==",true,false))',
    )
    expect(emitWhen(parseWhen("$a.status<'z'"))).toBe('C("<",R("a","status",[]),"z")')
  })
})

describe('template scanning', () => {
  it('splits references from literal text and leaves shell variables alone', () => {
    const parts = scanTemplate('echo $HOME $first.output.a-b and $inputs.name, $x.exit_code! $nope.other')
    expect(parts.map(p => ('lit' in p ? p.lit : `<${refEnvName(p.ref)}>`))).toEqual([
      'echo $HOME ', '<WF_FIRST_OUTPUT_A_B>', ' and ', '<WF_INPUT_NAME>', ', ', '<WF_X_EXIT_CODE>', '! $nope.other',
    ])
  })
})
