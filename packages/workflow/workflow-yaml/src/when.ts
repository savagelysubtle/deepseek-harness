/**
 * The `when` expression grammar and the `$ref` template scanner. User text is parsed into an
 * AST at compile time; the emitted script contains only JSON-quoted literals and fixed operator
 * tokens, never user text as code.
 *
 *   expr    := and ('||' and)*
 *   and     := cmp ('&&' cmp)*
 *   cmp     := operand (op operand)?          op := == != < > <= >=
 *   operand := 'str' | "str" | number | true | false | $ref
 *
 * @module @deepseek-ai/dsh-workflow-yaml/when
 */

/** A parsed `$ref`. */
export interface Ref {
  /** `input` for `$inputs.x`; otherwise the property of a node result. */
  kind: 'input' | 'output' | 'exit_code' | 'status'
  /** Node id for node refs; the input name for `input`. */
  id: string
  /** Field path under `output` (`$id.output.a.b`). */
  path: string[]
  /** Offset of the `$` in the scanned text. */
  offset: number
  length: number
}

/** Operand of a comparison. */
export type Operand =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; ref: Ref }

/** Parsed `when` expression. */
export type Expr =
  | { t: 'or'; items: Expr[] }
  | { t: 'and'; items: Expr[] }
  | { t: 'cmp'; op: string; l: Operand; r: Operand }
  | { t: 'val'; v: Operand }

/** A grammar error with its offset in the expression text. */
export class WhenSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message)
  }
}

const REF_AT = /\$([a-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)/y

/** Read a `$ref` at `offset`; throws a {@link WhenSyntaxError} on a malformed reference. */
export function readRef(text: string, offset: number): Ref {
  REF_AT.lastIndex = offset
  const match = REF_AT.exec(text)
  if (match === null) throw new WhenSyntaxError('expected a reference such as $node.output or $inputs.name', offset)
  const head = match[1] ?? ''
  const tailText = match[2] ?? ''
  const parts = tailText.length === 0 ? [] : tailText.slice(1).split('.')
  const first = parts[0] ?? ''
  const length = match[0].length
  if (head === 'inputs') {
    if (parts.length !== 1 || !/^[a-z][a-z0-9_]*$/.test(first)) {
      throw new WhenSyntaxError('an input reference is $inputs.<name>', offset)
    }
    return { kind: 'input', id: first, path: [], offset, length }
  }
  const prop = parts[0]
  if (prop === 'output') return { kind: 'output', id: head, path: parts.slice(1), offset, length }
  if (prop === 'exit_code' || prop === 'status') {
    if (parts.length !== 1) throw new WhenSyntaxError(`$${head}.${prop} takes no further fields`, offset)
    return { kind: prop, id: head, path: [], offset, length }
  }
  throw new WhenSyntaxError(`unknown reference property "${prop ?? ''}" (use output, exit_code, or status)`, offset)
}

type Token =
  | { k: 'op' | 'and' | 'or'; v: string; at: number }
  | { k: 'str'; v: string; at: number }
  | { k: 'num'; v: number; at: number }
  | { k: 'bool'; v: boolean; at: number }
  | { k: 'ref'; ref: Ref; at: number }
  | { k: 'end'; at: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (/\s/.test(c)) { i += 1; continue }
    if (c === '(' || c === ')') throw new WhenSyntaxError('parentheses are not supported in when expressions', i)
    if (c === '!' && text[i + 1] !== '=') throw new WhenSyntaxError('"!" is not supported; use != or compare to false', i)
    if (c === '&' || c === '|') {
      if (text[i + 1] !== c) throw new WhenSyntaxError(`expected "${c}${c}"`, i)
      tokens.push({ k: c === '&' ? 'and' : 'or', v: c + c, at: i })
      i += 2
      continue
    }
    if (c === '=' || c === '!' || c === '<' || c === '>') {
      const two = text.slice(i, i + 2)
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ k: 'op', v: two, at: i })
        i += 2
        continue
      }
      if (c === '=') throw new WhenSyntaxError('use "==" to compare', i)
      tokens.push({ k: 'op', v: c, at: i })
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      let value = ''
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw new WhenSyntaxError('unterminated string literal', i)
        const d = text.charAt(j)
        if (d === '\\' && j + 1 < text.length) { value += text.charAt(j + 1); j += 2; continue }
        if (d === c) break
        value += d
        j += 1
      }
      tokens.push({ k: 'str', v: value, at: i })
      i = j + 1
      continue
    }
    if (c === '$') {
      const ref = readRef(text, i)
      tokens.push({ k: 'ref', ref, at: i })
      i += ref.length
      continue
    }
    const num = /-?\d+(?:\.\d+)?/y
    num.lastIndex = i
    const nm = num.exec(text)
    if (nm !== null) {
      tokens.push({ k: 'num', v: Number(nm[0]), at: i })
      i += nm[0].length
      continue
    }
    const word = /[A-Za-z_][A-Za-z0-9_]*/y
    word.lastIndex = i
    const wm = word.exec(text)
    if (wm !== null) {
      if (wm[0] === 'true' || wm[0] === 'false') {
        tokens.push({ k: 'bool', v: wm[0] === 'true', at: i })
        i += wm[0].length
        continue
      }
      throw new WhenSyntaxError(`unexpected word "${wm[0]}"; quote string literals like 'text'`, i)
    }
    throw new WhenSyntaxError(`unexpected character "${c}"`, i)
  }
  tokens.push({ k: 'end', at: text.length })
  return tokens
}

/** Parse a `when` expression. @throws WhenSyntaxError with the offending offset */
export function parseWhen(text: string): Expr {
  const tokens = tokenize(text)
  let p = 0
  const peek = (): Token => tokens[p] ?? { k: 'end', at: text.length }
  const operand = (): Operand => {
    const t = peek()
    if (t.k === 'str') { p += 1; return { t: 'str', v: t.v } }
    if (t.k === 'num') { p += 1; return { t: 'num', v: t.v } }
    if (t.k === 'bool') { p += 1; return { t: 'bool', v: t.v } }
    if (t.k === 'ref') { p += 1; return { t: 'ref', ref: t.ref } }
    const expected = 'expected a value (string, number, true, false, or $reference)'
    throw new WhenSyntaxError(t.k === 'end' ? 'expected a value but the expression ended' : expected, t.at)
  }
  const cmp = (): Expr => {
    const l = operand()
    const t = peek()
    if (t.k === 'op') {
      p += 1
      return { t: 'cmp', op: t.v, l, r: operand() }
    }
    return { t: 'val', v: l }
  }
  const and = (): Expr => {
    const items = [cmp()]
    while (peek().k === 'and') { p += 1; items.push(cmp()) }
    return items[0] !== undefined && items.length === 1 ? items[0] : { t: 'and', items }
  }
  const or = (): Expr => {
    const items = [and()]
    while (peek().k === 'or') { p += 1; items.push(and()) }
    return items[0] !== undefined && items.length === 1 ? items[0] : { t: 'or', items }
  }
  const expr = or()
  const rest = peek()
  if (rest.k !== 'end') {
    const hint = 'combine terms with && or ||'
    throw new WhenSyntaxError(rest.k === 'op' ? `only one comparison is allowed per term; ${hint}` : `unexpected token; ${hint}`, rest.at)
  }
  return expr
}

/** Every reference in an expression, in source order. */
export function whenRefs(expr: Expr): Ref[] {
  if (expr.t === 'or' || expr.t === 'and') return expr.items.flatMap(whenRefs)
  const operands = expr.t === 'cmp' ? [expr.l, expr.r] : [expr.v]
  return operands.flatMap(o => (o.t === 'ref' ? [o.ref] : []))
}

/** A piece of template text: literal, or a reference. */
export type TemplatePart = { lit: string } | { ref: Ref }

const TEMPLATE_REF = /\$(?:inputs\.[a-z][a-z0-9_]*|[a-z0-9_-]+\.(?:output|exit_code|status)(?:\.[A-Za-z0-9_-]+)*)/g

/**
 * Split text into literal and reference parts. Only `$inputs.<name>` and
 * `$<id>.(output|exit_code|status)[.field...]` are references; everything else (including shell
 * variables like `$HOME`) stays literal.
 */
export function scanTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let last = 0
  for (const match of text.matchAll(TEMPLATE_REF)) {
    const at = match.index
    if (at > last) parts.push({ lit: text.slice(last, at) })
    parts.push({ ref: readRef(text, at) })
    last = at + match[0].length
  }
  if (last < text.length) parts.push({ lit: text.slice(last) })
  return parts
}

/** The env-var name a reference is exposed under in bash: `WF_<ID>_OUTPUT[_FIELD]`, `WF_INPUT_<NAME>`. */
export function refEnvName(ref: Ref): string {
  const up = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  if (ref.kind === 'input') return `WF_INPUT_${up(ref.id)}`
  const base = `WF_${up(ref.id)}_${ref.kind.toUpperCase()}`
  return ref.path.length === 0 ? base : `${base}_${ref.path.map(up).join('_')}`
}

/** JS expression reading a reference at runtime through the prelude helpers. */
export function emitRef(ref: Ref): string {
  if (ref.kind === 'input') return `I(${JSON.stringify(ref.id)})`
  return `R(${JSON.stringify(ref.id)},${JSON.stringify(ref.kind)},${JSON.stringify(ref.path)})`
}

function emitOperand(o: Operand): string {
  if (o.t === 'ref') return emitRef(o.ref)
  return JSON.stringify(o.v)
}

/** Emit a boolean JS expression; only JSON literals and fixed tokens appear in the output. */
export function emitWhen(expr: Expr): string {
  switch (expr.t) {
    case 'or': return `(${expr.items.map(emitWhen).join(' || ')})`
    case 'and': return `(${expr.items.map(emitWhen).join(' && ')})`
    case 'cmp': return `C(${JSON.stringify(expr.op)},${emitOperand(expr.l)},${emitOperand(expr.r)})`
    case 'val': return `T(${emitOperand(expr.v)})`
  }
}
