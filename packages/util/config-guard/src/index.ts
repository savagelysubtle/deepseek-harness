/**
 * Secret-safe config validation errors (OP-205, legacy SWD-168). Schemastery's
 * type-mismatch resolvers build their message as `expected <type> but got
 * ${data}`, interpolating the RAW received value, and cordis logs that message
 * at every plugin mount/reload. A credential placed in a field of the wrong
 * shape (an API key in a dict-typed `env`, a token in a `headers` slot) would
 * therefore land in the persistent host log. This module strips the echoed
 * value while keeping the path and the expectation text.
 *
 * Structural on purpose: it takes any Standard-Schema-shaped object, so this
 * library stays dependency-free and does not import the schema package.
 * @module @deepseek-ai/dsh-config-guard
 */

/** Matches the ` but got <value>` tail to the end of the message, multi-line values included. */
const BUT_GOT_TAIL_RE = / but got [\s\S]*$/

/** Replacement text for a stripped ` but got <value>` tail. */
export const RECEIVED_VALUE_WITHHELD = ' (received value withheld)'

/**
 * Drop the raw received value Schemastery interpolates into a type-mismatch
 * message. A message with no such tail ("missing required value", a regexp
 * mismatch) never embeds the value and is returned unchanged.
 * @param message - a Schemastery validation message.
 * @returns the message with any ` but got <value>` tail replaced by a fixed marker.
 */
export function redactReceivedValue(message: string): string {
  return message.replace(BUT_GOT_TAIL_RE, RECEIVED_VALUE_WITHHELD)
}

/**
 * Redact a thrown validation error IN PLACE: its message and its captured
 * `stack` (V8 bakes the message into the stack header at construction, so
 * rewriting only `.message` would leave the received value in the stack and in
 * any logger that prints it). The error keeps its identity, class, and
 * `options.path`. A non-Error, or a message that never embedded a value, is
 * left alone. If the stack no longer contains the message, the fallback
 * `${name}: ${redacted}` DROPS the stack frames.
 * @param error - whatever a schema call threw.
 * @returns nothing; the error object is mutated.
 */
export function redactThrown(error: unknown): void {
  if (!(error instanceof Error)) return
  const original = error.message
  const redacted = redactReceivedValue(original)
  if (redacted === original) return
  error.message = redacted
  const stack = error.stack
  const at = typeof stack === 'string' ? stack.indexOf(original) : -1
  // Only the FIRST occurrence (the header) is replaced; a copy inside a nested
  // cause or pasted text would stay.
  const nextStack = typeof stack === 'string' && at >= 0
    ? stack.slice(0, at) + redacted + stack.slice(at + original.length)
    : `${error.name}: ${redacted}`
  error.stack = nextStack
}

/** One Standard Schema validation issue, as far as this guard needs to see it. */
interface GuardIssue {
  readonly message: string
}

/** Shape of the `~standard` property the guard wraps. */
interface GuardStandard {
  readonly validate: (value: unknown) => unknown
}

/**
 * Make a plugin `Config` schema withhold the received value on BOTH ways it is
 * validated. (1) The Standard Schema path: the instance's `~standard` accessor
 * (what cordis `resolveConfig` calls) is overridden so every issue message
 * passes through {@link redactReceivedValue}. (2) The direct-call path
 * (`schema(data)`, what the settings service uses): a callable schema is
 * returned as a Proxy whose `apply` trap redacts a thrown error's message and
 * stack with {@link redactThrown} and rethrows the same error object. Every
 * other operation passes through, so property reads, `instanceof`, and
 * spreading behave as on the raw schema; the schema's resolvers, defaults, and
 * catalog shape are untouched, and the override is non-enumerable. Apply it as
 * the LAST step of the Config expression: a chained refinement after it (or any
 * clone made after wrapping) builds a fresh schema and loses the guard.
 *
 * Out of scope: a Promise result from `validate` (cordis rejects async config
 * validation), and a non-Error thrown value, which propagates unredacted.
 * @param schema - the fully built Config schema.
 * @returns the schema (a pass-through Proxy when it is callable, the same
 *   instance otherwise), now redacting its validation errors.
 */
export function guardConfigSchema<S extends object>(schema: S): S {
  let holder = Object.getPrototypeOf(schema) as object | null
  while (holder !== null && Object.getOwnPropertyDescriptor(holder, '~standard')?.get === undefined) {
    holder = Object.getPrototypeOf(holder) as object | null
  }
  if (holder === null) {
    throw new TypeError('guardConfigSchema: schema has no "~standard" accessor to wrap')
  }
  const owner = holder
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    enumerable: false,
    get(this: S) {
      const standard = Reflect.get(owner, '~standard', this) as GuardStandard
      return {
        ...standard,
        // `issue.path` (dict key names) is kept; see the function doc for scope.
        validate: (value: unknown) => {
          const result = standard.validate(value) as { issues?: readonly GuardIssue[] }
          if (result.issues === undefined) return result
          return {
            ...result,
            issues: result.issues.map(issue => ({ ...issue, message: redactReceivedValue(issue.message) })),
          }
        },
      }
    },
  })
  if (typeof schema !== 'function') return schema
  return new Proxy(schema, {
    apply(target, thisArg, args: unknown[]) {
      try {
        // Typed local: oxlint rejects returning Reflect.apply's `any` directly.
        const result: unknown = Reflect.apply(target, thisArg, args)
        return result
      } catch (error) {
        redactThrown(error)
        throw error
      }
    },
  })
}
