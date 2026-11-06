/**
 * The contributor-based tool template. S5's lead template is exactly `mailbox_send` and
 * `mailbox_directory`; S6 and S7 register further factories on a {@link SeatToolTemplate} instead of
 * editing S5 files. The names the template can provide must equal what the host stanza's `tools`
 * lists: a listed name with no factory mutes the seat, naming what is missing.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/mcp/template
 */

import { SeatMutedByPolicyError } from '@deepseek-ai/dsh-agent-claude-code-driver'
import { MAILBOX_DIRECTORY_TOOL, MAILBOX_SEND_TOOL } from '../contributors.ts'
import { createDirectoryTool } from './directory.ts'
import { createSendTool } from './send.ts'
import type { SeatTool, SeatToolContext, SeatToolFactory } from './types.ts'

/** Holds the tool factories a server can be built from. */
export class SeatToolTemplate {
  private readonly factories = new Map<string, SeatToolFactory>()
  private changes = 0

  /** Counts successful registrations; a cache keyed on it notices a new tool. */
  get version(): number {
    return this.changes
  }

  /**
   * Add a tool factory.
   * @param name - the bare tool name.
   * @param factory - builds the tool over a seat's closure.
   * @throws when the name is already registered.
   */
  register(name: string, factory: SeatToolFactory): void {
    if (this.factories.has(name)) throw new Error(`agent-claude-code-tools: tool ${name} is already registered in the template`)
    this.factories.set(name, factory)
    this.changes += 1
  }

  /**
   * The names the template can provide.
   * @returns bare tool names, in registration order.
   */
  names(): string[] {
    return [...this.factories.keys()]
  }

  /**
   * Check that the template can provide every requested name, without building anything.
   * @param seat - the seat, for the error.
   * @param requested - bare names, exactly as the host stanza lists them.
   * @throws {SeatMutedByPolicyError} on an empty request, or when a name has no factory (all missing names are listed).
   */
  check(seat: string, requested: readonly string[]): void {
    if (requested.length === 0) throw new SeatMutedByPolicyError(seat, 'the host stanza lists no tools')
    const missing = requested.filter(name => !this.factories.has(name))
    if (missing.length > 0) {
      throw new SeatMutedByPolicyError(seat, `the tool template cannot provide: ${missing.join(', ')}`)
    }
  }

  /**
   * Build the requested tools over one seat's closure.
   * @param seat - the seat, for the error.
   * @param requested - bare names, exactly as the host stanza lists them.
   * @param context - the seat closure.
   * @returns the tools, in request order.
   * @throws {SeatMutedByPolicyError} as {@link check} does.
   */
  build(seat: string, requested: readonly string[], context: SeatToolContext): SeatTool[] {
    this.check(seat, requested)
    return requested.map(name => (this.factories.get(name) as SeatToolFactory)(context))
  }
}

/**
 * The S5 template: `mailbox_send` and `mailbox_directory`.
 * @returns a fresh template.
 */
export function createLeadTemplate(): SeatToolTemplate {
  const template = new SeatToolTemplate()
  template.register(MAILBOX_SEND_TOOL, createSendTool)
  template.register(MAILBOX_DIRECTORY_TOOL, createDirectoryTool)
  return template
}
