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

/** What a note id or code may look like: a short plain word phrase, never a path or a digest. */
const SAFE_NOTE = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/

/** A run this long is a digest or a token, never a word. */
const LONG_TOKEN = /[A-Za-z0-9]{24}/

const isSafe = (text: string): boolean => SAFE_NOTE.test(text) && !LONG_TOKEN.test(text)

/** Most distinct note ids kept. */
const MAX_NOTE_IDS = 64

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
   * Record why a requirement is not met, as a short CODE such as `canary FAILED attest`. The text goes into the
   * error a seat turn can see, so it must hold no path, hash or excerpt: anything that is not a short plain word
   * phrase (letters, digits, space, `_` and `-`, at most 64 characters) is replaced by `see host log`, and an id
   * that is not a plain word is stored as `unknown`. The caller logs the full reason to the host log. Replaces an
   * earlier note with the same id; at most 64 ids are kept, later new ids are dropped. Does not touch readiness or `version`.
   * @param id - the contributor id the note is about.
   * @param code - the short failure code.
   */
  note(id: string, code: string): void {
    const key = isSafe(id) ? id : 'unknown'
    if (!this.reasons.has(key) && this.reasons.size >= MAX_NOTE_IDS) return
    this.reasons.set(key, isSafe(code) ? code : 'see host log')
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
