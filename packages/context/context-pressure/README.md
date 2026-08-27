# @deepseek-ai/dsh-context-pressure

English | [中文](README.zh.md)

Opt-in plugin that appends durable, model-visible context-window pressure warnings at request preparation so the model can plan its own compaction before rising pressure forces automatic compaction. Default compositions leave it disabled; mount it beside a compaction backend and the `compact` tool.

## Config

```yaml
- id: context-pressure
  name: '@deepseek-ai/dsh-context-pressure'
  config:
    thresholds: [0.25, 0.5, 0.75] # optional; fractions of the routed model's context window
```

`thresholds` must be strictly ascending, unique, and each within (0, 1); violations reject at plugin load with a diagnostic naming the offending value. Omission resolves the default `[0.25, 0.5, 0.75]`. An explicit empty array disables all warnings.

## Deduplication and reset

Each step measures pressure through `ctx.tokenMeter` for the provider/model durably routed by the latest `request/header`, scales the configured fractions to that model's advertised window, and warns once for the smallest not-yet-warned crossed threshold of the current compaction generation. A `compaction/end` event newer than the latest warning resets every threshold, so all of them re-arm after each compaction. Warned state folds from the durable log — including warnings shadowed by later compaction — so restarts and resumes never re-warn at already-durable thresholds.

When the routed target has no resolvable context window (the adapter advertises none or lookup fails), the plugin logs one warning per target and skips injection without blocking the step. A session whose log has no `request/header` yet has no routed target and is skipped silently.

## Model Experience

### Preparation-time context-window pressure

#### What the model sees

One sourced user message per crossing, appended after the claimed input when the step enters; `<threshold>` is the crossed fraction rendered as a percent, and the totals reflect the meter's measurement taken before this warning joined the request.

##### Warning

```markdown
Context pressure notice: usage passed the <threshold>% threshold of this model's context window: <total> of <window> tokens in use (<used>%); <remaining> tokens remain.
Before rising pressure forces automatic compaction, you can request compaction yourself with the compact tool.
```

#### Token effect

About 60 tokens per warning, added at most once per threshold per compaction generation; between crossings later steps add nothing.

#### KV Cache effect

Append-only with stable template text; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Failed compactions also re-arm** — any `compaction/end` newer than the latest warning resets thresholds, so a failed automatic attempt that leaves usage above an old threshold re-warns it on the next step.
- **Heuristic pressure** — totals come from the token meter's replay pricing, which can differ from the provider's own accounting around the crossing point.
- **One threshold set for all models** — `thresholds` applies to every routed target; per-model overrides would need a target-keyed config like compaction-basic's `modelPolicies`.
- **No routed target, no warning** — steps before the first logged `request/header` are skipped even when measured pressure is high.
