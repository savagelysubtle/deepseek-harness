# dsh-config-guard

English | [中文](README.zh.md)

A zero-dependency library that keeps credentials out of plugin config validation errors (OP-205, legacy SWD-168).

Schemastery's type-mismatch resolvers build their message as `expected <type> but got ${data}`, interpolating the **raw received value**, and cordis logs that message at every plugin mount and reload. A credential placed in a field of the wrong shape (an API key in a dict-typed `env`, a token in a `headers` slot) would otherwise land in the persistent host log and the fiber's stored error. This package strips the echoed value and keeps the path and the expectation text.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

## API

```ts
import { guardConfigSchema, redactReceivedValue, RECEIVED_VALUE_WITHHELD } from '@deepseek-ai/dsh-config-guard'
```

| Export | Role |
|---|---|
| `guardConfigSchema(schema)` | Wrap a fully built plugin `Config` schema so its validation errors are redacted on BOTH paths: the Standard Schema path (`~standard.validate`, what cordis `resolveConfig` calls) and the direct-call path (`schema(data)`, what the settings service uses). A callable schema is returned as a pass-through Proxy whose `apply` trap redacts a thrown error's message and stack and rethrows the same object. Call it LAST (a chained refinement or clone made after it builds a fresh schema and loses the guard). |
| `redactReceivedValue(message)` | Replace the ` but got <value>` tail (multi-line values included) with a fixed marker. A message that never embeds the value is returned unchanged. |
| `redactThrown(error)` | Redact a thrown validation error in place: its message and its `stack` (V8 bakes the message into the stack header, so `.message` alone is not enough). Used by the `apply` trap and by mcp-client. |
| `RECEIVED_VALUE_WITHHELD` | The marker text, ` (received value withheld)`. |

## Usage shape

```ts
import z from '@deepseek-ai/schemastery'
import { guardConfigSchema } from '@deepseek-ai/dsh-config-guard'

export const Config: z<Config> = guardConfigSchema(z.object({
  apiKey: z.string(),
  env: z.dict(z.string()).default({}),
}))
```

The guard overrides the schema's `~standard` accessor (the surface cordis's `resolveConfig` calls) on the instance, non-enumerably, and wraps the callable schema in a pass-through Proxy for direct calls; the schema's resolvers, defaults, and shape are untouched, and `scripts/gen-config-catalog.ts` sees through the call to its argument.

## Model Experience

None, as config validation errors surface before a plugin mounts and nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Depends on Schemastery's wording** — the strip keys on ` but got `. Each guarded package carries a leak test through the real vendored Schemastery with a canary, so a wording change fails loudly.
- **Config validation only** — errors thrown from plugin code after validation are not covered.
- **`path` is not redacted** — dict key names and other path segments are kept as-is.
- **mcp-client uses only the message helper** — it calls `redactThrown` inside its `rethrowRedacted` rather than `guardConfigSchema`, because its custom type resolver already redacts at throw time.
- **Per-package opt-in** — a plugin must wrap its own `Config`; the durable fix is schema-declared secret roles handled in the vendored resolver (founder sign-off required).
