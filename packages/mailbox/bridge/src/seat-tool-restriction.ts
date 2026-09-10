/**
 * Applies a seat's configured tool restriction defensively: tools genuinely
 * go missing at runtime (a recorded incident lost seats different subsets of
 * their tools after a host restart), and handing a registry's `restrict()`
 * the raw configured names crashes seat creation the moment one of them is
 * absent. This module intersects the configured names against the tools
 * currently known BEFORE restricting, so a missing name degrades instead of
 * exploding — and reports which configured names it had to drop.
 *
 * The rule shape is declared locally, not imported from the tool-registry
 * package, so this helper stays testable against a hand-built fake context
 * with no dependency on the bridge's own wiring.
 *
 * Scoped assumption: this reasoning holds for a top-level seat with no
 * ancestor restriction already narrowing it above its own scope — true of
 * every seat today, since nothing restricts above a seat's own scope. A
 * future ancestor-restricted seat would need this revisited: its "currently
 * known" set is already the ancestor's narrowed view, not the registry's
 * full one.
 * @module @deepseek-ai/dsh-mailbox-bridge/seat-tool-restriction
 */

/**
 * One seat's configured tool restriction. Mirrors the tool registry's own
 * `ToolRestriction` shape without importing it.
 */
export interface SeatToolRestrictionRule {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}

/** One schema entry as the registry's schema-listing method reports it — only the name is needed here. */
export interface SeatKnownToolSchema {
  readonly name: string
}

/**
 * The slice of an agent context this helper needs: a tool registry exposing
 * the currently known tool set and a way to restrict it for the seat's scope.
 */
export interface SeatToolRegistryContext {
  readonly tools: {
    /**
     * The tools currently visible to this scope. MUST be read before
     * `restrict()` is called for the same rule — calling it after would
     * report the just-applied restriction's own output, so every configured
     * name would look satisfied and no gap could ever surface.
     */
    schemas(): readonly SeatKnownToolSchema[]
    /** Apply a restriction to this scope's visible tools. */
    restrict(rule: SeatToolRestrictionRule): unknown
  }
}

/** The result of applying one seat's tool restriction. */
export interface SeatToolRestrictionOutcome {
  /** The intersected rule actually handed to the registry's `restrict()`. */
  readonly rule: SeatToolRestrictionRule
  /** Configured names that named a tool not currently known, in configured order. */
  readonly missing: readonly string[]
}

/** Intersect one configured name list against the known set, splitting kept names from missing ones. */
function intersect(
  names: readonly string[] | undefined,
  known: ReadonlySet<string>,
  missing: Set<string>,
): readonly string[] | undefined {
  if (names === undefined) return undefined
  const kept: string[] = []
  for (const name of names) {
    if (known.has(name)) kept.push(name)
    else missing.add(name)
  }
  return kept
}

/**
 * Apply one seat's configured tool restriction, degrading missing names
 * instead of letting the registry throw on them.
 *
 * With no rule, this does nothing at all: no registry call, no side effect.
 * Otherwise it reads the registry's currently known tool names, intersects
 * the rule's `allow`/`deny` lists against that set, and calls the registry's
 * `restrict()` with the INTERSECTED lists — never the raw configured ones.
 *
 * The two lists degrade asymmetrically, and deliberately so: `allow` is a
 * narrowing, so when every named tool is currently missing the intersected
 * `allow` list comes back EMPTY and the seat ends up with no tools — falling
 * back to unrestricted would silently widen a security boundary, which is
 * the one outcome that is unacceptable. `deny` has nothing to remove that
 * is not there, so an all-missing `deny` list degrades to a no-op.
 * @param agentContext - the seat's scoped context exposing the tool registry.
 * @param seatName - the seat this restriction belongs to, used to attribute
 *   a registry `restrict()` failure to the seat that caused it.
 * @param rule - the seat's configured restriction, or `undefined` for none.
 * @returns the effective rule applied and the configured names that were not
 *   currently present, or `undefined` when there was no rule to apply.
 */
export function applySeatToolRestriction(
  agentContext: SeatToolRegistryContext,
  seatName: string,
  rule: SeatToolRestrictionRule | undefined,
): SeatToolRestrictionOutcome | undefined {
  if (rule === undefined) return undefined

  // Read the known-tool set BEFORE restricting — see the module doc and the
  // ordering test in this package's spec file for why the order is load-bearing.
  const known = new Set(agentContext.tools.schemas().map(schema => schema.name))
  const missing = new Set<string>()

  const allow = intersect(rule.allow, known, missing)
  const deny = intersect(rule.deny, known, missing)

  const effective: SeatToolRestrictionRule = {
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  }

  try {
    agentContext.tools.restrict(effective)
  } catch (error) {
    throw new Error(`seat "${seatName}": failed to apply tool restriction`, { cause: error })
  }

  return { rule: effective, missing: [...missing] }
}
