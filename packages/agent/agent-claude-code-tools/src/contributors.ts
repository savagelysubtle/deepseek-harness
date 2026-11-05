/**
 * Contributor registries for the dsh tool template and the hook set. S6 and S7 append entries here
 * at runtime instead of editing S5 files. The lead template in S5 is exactly the two names below.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/contributors
 */

import { TOOL_NAME_PATTERN } from './grammar.ts'
import type { HookGroup } from './hook-command.ts'

/** The role names the policy serves. */
export type PolicyRole = 'lead' | 'coder'

/** Name of the per-seat in-process MCP server. */
export const MCP_SERVER_NAME = 'dsh'

/** Prefix of every dsh MCP tool name as the model and the hook see it. */
export const MCP_TOOL_PREFIX = 'mcp__dsh__'

/** Bare name of the (wrapped) mail send tool; C2 implements it. */
export const MAILBOX_SEND_TOOL = 'mailbox_send'

/** Bare name of the roster directory tool, as defined in `tool-mailbox`; C2 implements the wrapper. */
export const MAILBOX_DIRECTORY_TOOL = 'mailbox_directory'

/** The tools a lead seat may be given in S5. */
export const BASE_TOOL_TEMPLATE: readonly string[] = [MAILBOX_SEND_TOOL, MAILBOX_DIRECTORY_TOOL]

/** Native tools a coder seat holds in addition to its dsh tools. */
export const CODER_NATIVE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

/** Adds bare dsh tool names to the template for some roles. */
export interface ToolContributor {
  /** Stable id. */
  readonly id: string
  /** Roles the names are added for. */
  readonly roles: readonly PolicyRole[]
  /** Bare tool names (without the `mcp__dsh__` prefix). */
  readonly names: readonly string[]
}

/** What a hook contributor is told about the seat. */
export interface HookContext {
  /** The seat's bare name. */
  readonly seat: string
  /** The seat's role. */
  readonly role: PolicyRole
}

/** Adds hook groups (by event) for some roles. */
export interface HookContributor {
  /** Stable id. */
  readonly id: string
  /** Roles the groups apply to. */
  readonly roles: readonly PolicyRole[]
  /** The groups to append, keyed by hook event name. */
  groups(context: HookContext): Readonly<Record<string, readonly HookGroup[]>>
}

/**
 * Full MCP tool name for a bare dsh tool name.
 * @param name - bare name.
 * @returns the `mcp__dsh__` form.
 */
export function mcpToolName(name: string): string {
  return `${MCP_TOOL_PREFIX}${name}`
}

/** Holds the tool and hook contributors. */
export class ContributorRegistry {
  private readonly toolContributors = new Map<string, ToolContributor>()
  private readonly hookContributors = new Map<string, HookContributor>()
  private changes = 0

  /** Counts successful registrations; a cache keyed on it notices a new contributor. */
  get version(): number {
    return this.changes
  }

  /**
   * Add tool names to the template.
   * @param contributor - the contribution.
   * @throws on a duplicate id or a name outside the tool-name grammar.
   */
  registerToolContributor(contributor: ToolContributor): void {
    if (this.toolContributors.has(contributor.id)) throw new Error(`agent-claude-code-tools: tool contributor ${contributor.id} is already registered`)
    for (const name of contributor.names) {
      if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`agent-claude-code-tools: tool contributor ${contributor.id}: ${JSON.stringify(name)} is not a valid tool name`)
    }
    this.toolContributors.set(contributor.id, { id: contributor.id, roles: [...contributor.roles], names: [...contributor.names] })
    this.changes += 1
  }

  /**
   * Add hook groups to the generated settings.
   * @param contributor - the contribution.
   * @throws on a duplicate id.
   */
  registerHookContributor(contributor: HookContributor): void {
    if (this.hookContributors.has(contributor.id)) throw new Error(`agent-claude-code-tools: hook contributor ${contributor.id} is already registered`)
    this.hookContributors.set(contributor.id, contributor)
    this.changes += 1
  }

  /**
   * The bare dsh tool names a role may be given: the base template plus every contribution.
   * @param role - the role.
   * @returns de-duplicated names.
   */
  templateTools(role: PolicyRole): string[] {
    const names = new Set(BASE_TOOL_TEMPLATE)
    for (const contributor of this.toolContributors.values()) {
      if (contributor.roles.includes(role)) for (const name of contributor.names) names.add(name)
    }
    return [...names]
  }

  /**
   * The extra hook groups for a seat, merged by event, in registration order.
   * @param context - seat and role.
   * @returns groups keyed by event name.
   */
  extraHookGroups(context: HookContext): Record<string, HookGroup[]> {
    const merged: Record<string, HookGroup[]> = {}
    for (const contributor of this.hookContributors.values()) {
      if (!contributor.roles.includes(context.role)) continue
      for (const [event, groups] of Object.entries(contributor.groups(context))) {
        merged[event] = [...merged[event] ?? [], ...groups]
      }
    }
    return merged
  }
}
