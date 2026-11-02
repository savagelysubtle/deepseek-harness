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

/** One Standard Schema validation issue, as far as this guard needs to see it. */
interface GuardIssue {
  readonly message: string
}

/** Shape of the `~standard` property the guard wraps. */
interface GuardStandard {
  readonly validate: (value: unknown) => unknown
}

/**
 * Make a plugin `Config` schema withhold the received value from its
 * validation issues. Overrides the instance's `~standard` accessor (the
 * surface cordis calls in `resolveConfig`) so every issue message passes
 * through {@link redactReceivedValue}; the schema's own resolvers, defaults,
 * and catalog shape are untouched, and the override is non-enumerable so it is
 * invisible to schema serialization. Apply it as the LAST step of the Config
 * expression: a chained refinement after it would clone the schema and drop
 * the override.
 * @param schema - the fully built Config schema.
 * @returns the same schema instance, now redacting its validation issues.
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
        // Out of scope: a Promise result (cordis rejects async config validation
        // outright), and a non-ValidationError thrown by a custom validator,
        // which propagates unredacted. `issue.path` (dict key names) is kept.
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
  return schema
}
