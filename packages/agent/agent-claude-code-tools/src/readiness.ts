/**
 * Readiness registry. The sandbox (S6), the boot canary and the rules hooks (S7, package
 * `agent-claude-code-seat-checks`) register what they provide; `coder` becomes servable only when all
 * three are present. `lead` is servable as soon as the policy service exists. Besides the frozen
 * `PolicyReadiness` report the registry keeps a non-contract `notes` map (id to reason) a failing
 * contributor fills so the not-ready error can say why; notes never change what is ready.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/readiness
 */

import type { PolicyReadiness, ReadinessContributor, ReadinessRequirement } from '@deepseek-ai/dsh-agent-claude-code-driver'

/** Every requirement a coder seat needs, in report order. */
export const CODER_REQUIREMENTS: readonly ReadinessRequirement[] = ['sandbox', 'canary', 'rules-hooks']

/** Longest note kept, in characters. */
const MAX_NOTE = 300

/** Holds the registered readiness contributors. */
export class ReadinessRegistry {
  private readonly contributors = new Map<string, ReadinessContributor>()
  private readonly reasons = new Map<string, string>()
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
   * Record why a requirement is not met (for example `canary FAILED exit`). Replaces an earlier note with the
   * same id. Line breaks are flattened and the text is cut at 300 characters. Does not touch readiness or `version`.
   * @param id - the contributor id the note is about.
   * @param reason - one line for the operator.
   */
  note(id: string, reason: string): void {
    this.reasons.set(id, reason.replace(/[\r\n]+/g, ' ').slice(0, MAX_NOTE))
  }

  /**
   * The notes as `id: reason` pairs for the error that refuses a not-ready role.
   * @returns an empty string when there are no notes, otherwise a leading `; ` and the pairs joined with `; `.
   */
  notesText(): string {
    return this.reasons.size === 0 ? '' : `; ${[...this.reasons].map(([id, reason]) => `${id}: ${reason}`).join('; ')}`
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
