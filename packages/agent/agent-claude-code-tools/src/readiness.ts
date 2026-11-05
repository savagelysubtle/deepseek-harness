/**
 * Readiness registry. Later slices (S6 sandbox, S7 boot canary, the rules hooks) register what they
 * provide; `coder` becomes servable only when all three are present. `lead` is servable as soon as
 * the policy service exists.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/readiness
 */

import type { PolicyReadiness, ReadinessContributor, ReadinessRequirement } from '@deepseek-ai/dsh-agent-claude-code-driver'

/** Every requirement a coder seat needs, in report order. */
export const CODER_REQUIREMENTS: readonly ReadinessRequirement[] = ['sandbox', 'canary', 'rules-hooks']

/** Holds the registered readiness contributors. */
export class ReadinessRegistry {
  private readonly contributors = new Map<string, ReadinessContributor>()
  private changes = 0

  /** Counts successful registrations; a cache keyed on it notices a new contributor. */
  get version(): number {
    return this.changes
  }

  /**
   * Register a contributor.
   * @param contributor - its id and what it provides.
   * @throws when the id is already registered.
   */
  register(contributor: ReadinessContributor): void {
    if (this.contributors.has(contributor.id)) throw new Error(`agent-claude-code-tools: readiness contributor ${contributor.id} is already registered`)
    this.contributors.set(contributor.id, { id: contributor.id, provides: contributor.provides })
    this.changes += 1
  }

  /**
   * Which roles can be served now and which requirements are still unmet.
   * @returns the readiness report.
   */
  readiness(): PolicyReadiness {
    const provided = new Set([...this.contributors.values()].map(entry => entry.provides))
    const missing = CODER_REQUIREMENTS.filter(requirement => !provided.has(requirement))
    return { roles: new Set(missing.length === 0 ? ['lead', 'coder'] as const : ['lead'] as const), missing }
  }
}
