/**
 * The S5 contract between the Claude Code driver and a permission-policy provider plugin.
 * Types, constants and one error class only: the driver reads the `claudeCodePolicy` service
 * lazily (per seat resolve or per mail, never at mount) and the tools package implements it.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-driver/policy-contract
 */

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { ExtensionSettings, QueryBinding } from './options.ts'
import type { ClaudeCodeRole, ClaudeCodeSeatConfig } from './seat-config.ts'

/** What a policy provider may see about the query being built, plus the live taint controls. */
export interface PolicyQueryContext {
  /** The seat's bare name. */
  readonly seat: string
  /** The seat's role. */
  readonly role: ClaudeCodeRole
  /** The seat's parsed host-private configuration. */
  readonly config: ClaudeCodeSeatConfig
  /** The seat's working directory (a realpath). */
  readonly cwd: string
  /** Whether this query starts or resumes the Claude session. */
  readonly binding: QueryBinding
  /** Whether the session has read untrusted content (sticky per session). */
  isTurnTainted(): boolean
  /** Mark the session tainted; the reason is logged. Taint is never cleared by the provider. */
  markTurnTainted(reason: string): void
  /** Trace ids of mail already delivered to this seat, for reply-to validation. */
  deliveredTraceIds(): ReadonlySet<string>
}

/** What a provider contributes to one query. The driver validates all of it before use. */
export interface PolicyExtension {
  /** Inline hooks and permission deny/ask entries, cut down by the driver. */
  readonly settings?: ExtensionSettings
  /** At most one in-process (sdk-type) server, named `dsh`; any other kind is refused. */
  readonly mcpServers?: Readonly<Record<'dsh', McpSdkServerConfigWithInstance>>
  /** Allow entries, validated against a strict grammar by the driver. There is no canUseTool. */
  readonly allow?: readonly string[]
}

/** A readiness requirement a contributor can satisfy; a coder seat needs all three. */
export type ReadinessRequirement = 'sandbox' | 'canary' | 'rules-hooks'

/** One registered readiness contributor (S6 sandbox, S7 canary, rules hooks). */
export interface ReadinessContributor {
  /** Stable contributor id. */
  readonly id: string
  /** The requirement it satisfies. */
  readonly provides: ReadinessRequirement
}

/** Which roles the provider can currently serve, and what is missing for the rest. */
export interface PolicyReadiness {
  /** Roles the provider is ready for right now. */
  readonly roles: ReadonlySet<'lead' | 'coder'>
  /** Requirements still unmet; empty when every role is ready. */
  readonly missing: readonly ReadinessRequirement[]
}

/** The `claudeCodePolicy` service a provider plugin registers and the driver reads at use time. */
export interface ClaudeCodePolicy {
  /** Contract version; the driver refuses any value it does not know. */
  readonly version: 1
  /**
   * Build the contribution for one query.
   * @param ctx - what the driver tells the provider about the query, plus the live taint controls.
   * @returns the settings, in-process server and allow entries the driver then validates.
   */
  extend(ctx: PolicyQueryContext): PolicyExtension
  /**
   * Report which roles are servable now.
   * @returns the servable roles and the requirements still unmet.
   */
  readiness(): PolicyReadiness
}

/** Thrown by a provider when a seat resolves to an empty tool set; the seat is muted, not started. */
export class SeatMutedByPolicyError extends Error {
  /** @param seat the muted seat's bare name. @param reason why policy left the seat nothing to do. */
  constructor(readonly seat: string, readonly reason: string) {
    super(`seat ${seat} muted by policy: ${reason}`)
    this.name = 'SeatMutedByPolicyError'
  }
}

/**
 * Host-private policy fields of a host seat entry. They come from the host profile, which a seat
 * cannot write, and never from the registry row.
 */
export interface PolicyHostSeatFields {
  /** Exact dsh tool names the seat may call. */
  readonly tools?: readonly string[]
  /** Seats this seat may mail. */
  readonly send_to?: readonly string[]
  /** Whether the seat may send blocking mail. */
  readonly allow_blocking?: boolean
  /** Absolute path of the control-plane rule hook scripts (coder only). */
  readonly rules_dir?: string
}

/** Version of {@link PolicyFileV1}. */
export const POLICY_FILE_VERSION = 1 as const

/** The per-seat policy file the host writes. Read by the seat-guard hook; owned by agent-claude-code-tools after C0. */
export interface PolicyFileV1 {
  /** Schema version. */
  readonly v: 1
  /** The seat's bare name. */
  readonly seat: string
  /** The seat's role. */
  readonly role: 'lead' | 'coder'
  /** The seat's working directory (a realpath). */
  readonly cwd: string
  /** Absolute roots the seat may touch. */
  readonly allowedRoots: readonly string[]
  /** Absolute prefixes always denied. */
  readonly deniedPrefixes: readonly string[]
  /** Exact tool names the seat may call. */
  readonly tools: readonly string[]
}
