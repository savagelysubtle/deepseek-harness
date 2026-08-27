/**
 * Load-time threshold validation and per-model window scaling.
 *
 * @module @deepseek-ai/dsh-context-pressure/config
 */

/** Request-preparation pressure configuration. Invalid values fail plugin load. */
export interface Config {
  /** Fractions of the routed model's context window; ascending, unique, each in (0,1). Omit for the default [0.25, 0.5, 0.75]. */
  thresholds?: number[]
}

/** One validated pressure threshold as a fraction plus its canonical rendered percent. */
export interface ResolvedThreshold {
  /** Fraction of the context window this threshold watches. */
  readonly ratio: number
  /** Canonical percent text embedded in warnings and used as the dedup key. */
  readonly percent: string
}

/** Validated plugin configuration after defaults resolve at load. */
export interface Spec {
  /** Ascending thresholds watched within one compaction generation. */
  readonly thresholds: readonly ResolvedThreshold[]
}

/** Fractions watched when `Config.thresholds` is omitted. */
export const DEFAULT_THRESHOLDS: readonly number[] = [0.25, 0.5, 0.75]

/**
 * Render a fraction as the canonical percent text used inside warnings.
 * The output round-trips: parsing it and re-rendering yields the same text.
 * @param fraction - non-negative finite fraction of a whole.
 * @returns percent text with at most six fractional digits and no trailing zeros.
 */
export function formatPercent(fraction: number): string {
  return String(Math.round(fraction * 100 * 1e6) / 1e6)
}

/**
 * Validate configured fractions and attach their canonical percents.
 * @param ratios - configured fractions; an empty array disables all warnings.
 * @returns detached ascending resolved thresholds.
 * @throws TypeError naming the offending value when any entry is outside (0, 1) or the sequence is not strictly ascending.
 */
function resolveThresholds(ratios: readonly number[]): readonly ResolvedThreshold[] {
  const resolved: ResolvedThreshold[] = []
  let previous = 0
  for (const [index, ratio] of ratios.entries()) {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      throw new TypeError(
        `context-pressure: thresholds[${index}] (${String(ratio)}) must be a finite fraction in (0, 1)`,
      )
    }
    if (ratio <= previous) {
      throw new TypeError(
        `context-pressure: thresholds[${index}] (${String(ratio)}) must be strictly ascending above `
        + `the preceding threshold (${String(previous)})`,
      )
    }
    previous = ratio
    resolved.push({ ratio, percent: formatPercent(ratio) })
  }
  return resolved
}

/**
 * Resolve defaults and validate the configured thresholds exactly once at load.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable specification consumed by every later step.
 * @throws TypeError naming the offending value when `thresholds` violates its contract.
 */
export function resolveSpec(config: Config): Spec {
  return { thresholds: resolveThresholds(config.thresholds ?? DEFAULT_THRESHOLDS) }
}

/** One {@link ResolvedThreshold} scaled to a concrete model's context window. */
export interface WindowThreshold extends ResolvedThreshold {
  /** Smallest measured token total that has crossed this threshold on that model. */
  readonly tokens: number
}

/**
 * Scale the validated fractions into concrete token thresholds for one model.
 * @param spec - load-resolved configuration.
 * @param contextWindow - positive adapter-advertised capacity for the routed model.
 * @returns detached ascending token thresholds.
 */
export function resolveWindowThresholds(spec: Spec, contextWindow: number): readonly WindowThreshold[] {
  return spec.thresholds.map(threshold => ({
    ...threshold,
    tokens: Math.floor(contextWindow * threshold.ratio),
  }))
}
