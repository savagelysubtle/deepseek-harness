/**
 * The mailbox Service Definition: `ctx.mailbox` owns the provider registry
 * and resolves default-provider convenience operations against it. Concrete
 * stores register through {@link MailboxRegistry.registerProvider}; consumers
 * publish, claim, and settle either through a named provider or the
 * configured default.
 *
 * @module @deepseek-ai/dsh-mailbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { MailboxAddress, MailboxClaimFilter, MailboxLeaseRef, MailboxLease, MailboxMessageId, MailboxOutcome, MailboxPublishInput, MailboxTraceEntry } from './types.ts'
import type { MailboxProvider } from './provider.ts'
import { parseMailboxAddress } from './address.ts'
import './source.ts'

export { parseMailboxAddress, formatMailboxAddress, MAILBOX_SEGMENT_PATTERN_SOURCE } from './address.ts'
export type { MailboxAddress, MailboxClaimFilter, MailboxLease, MailboxLeaseRef, MailboxMessage, MailboxMessageId, MailboxOutcome, MailboxPublishInput, MailboxState, MailboxStalenessFilter, MailboxTraceEntry } from './types.ts'
export type { AddressResolutionExtension, MailboxProvider } from './provider.ts'
export type { MailboxMessageSource, MailboxRelaySource, MailboxRefusalSource } from './source.ts'
export {
  findOrgRegistryRoute, isSeatIdentityPinned, loadOrgRegistry, orgRegistryAllows, parseOrgRegistry,
  resolveSeatCwd, resolveSeatSessionId,
} from './org-registry.ts'
export type { OrgRegistry, OrgRegistryEdge, OrgRegistryParseOptions, OrgRegistrySeat } from './org-registry.ts'

/** Deployment config of the registry service. */
export interface Config {
  /**
   * Provider name the no-provider-argument convenience operations resolve
   * against. Absent: conveniences fail loud until configured; named-provider
   * calls are unaffected.
   */
  readonly defaultProvider?: string
}

/**
 * Schema for {@link Config}. Validation runs at mount; an empty or blank
 * name fails here rather than at first call (misconfiguration fails loud at
 * the earliest resolvable point).
 */
export const Config: Schema<Config> = z.object({
  defaultProvider: z.string().min(1),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    mailbox: MailboxRegistry
  }
}

/**
 * Registry over the process's mailbox providers plus default-resolved
 * conveniences. Registering the same provider name twice fails loud; the
 * returned disposer unregisters, and a later re-registration of that name is
 * legitimate (provider swap across reloads).
 */
export class MailboxRegistry extends Service {
  static Config: Schema<Config> = Config

  private readonly providers = new Map<string, MailboxProvider>()
  private readonly defaultProvider: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mailbox')
    // Explicit resolve step: every fallback decision happens here once,
    // never lazily inside an operation.
    this.defaultProvider = config.defaultProvider === undefined ? undefined : resolveDefaultProvider(config.defaultProvider)
  }

  /**
   * Register one storage provider under its own name.
   * @param provider - the provider implementation to admit.
   * @returns the disposer that unregisters this provider; fiber disposal triggers it automatically.
   * @throws when a live provider already holds `provider.name`.
   */
  registerProvider(provider: MailboxProvider): () => void {
    const existing = this.providers.get(provider.name)
    if (existing !== undefined) {
      throw new Error(`mailbox provider "${provider.name}" is already registered`)
    }
    this.providers.set(provider.name, provider)
    return () => {
      // Only the winning registration may remove its name: a disposer whose
      // provider was replaced by a re-registration leaves the successor alone.
      if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name)
    }
  }

  /**
   * Look up one registered provider by exact name.
   * @param name - the provider's registry name.
   * @returns the provider, or undefined when the name is not live.
   */
  getProvider(name: string): MailboxProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * Enumerate the live providers in registration order.
   * @returns the borrowed providers; mutating them is the owner's concern.
   */
  list(): readonly MailboxProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Publish through the configured default provider after validating the
   * destination address grammar. The provider mints the durable id and the
   * sent time; the caller supplies neither.
   * @param message - message content without an id or sent time.
   * @param signal - caller cancellation owning admission.
   * @returns the provider-assigned durable id.
   */
  async publish(message: MailboxPublishInput, signal?: AbortSignal): Promise<MailboxMessageId> {
    // Grammar enforcement happens in the operation that admits the value:
    // direct provider callers bypass this check by contract.
    parseMailboxAddress(message.to)
    return this.resolveDefault('publish').publish(message, signal)
  }

  /**
   * Claim through the configured default provider after validating every
   * filter address against the grammar.
   * @param filter - address selection, batch bound, and staleness bound.
   * @param signal - caller cancellation owning the claim attempt.
   * @returns the claimed leases.
   */
  async claim(filter: MailboxClaimFilter, signal?: AbortSignal): Promise<readonly MailboxLease[]> {
    for (const address of filter.addresses) parseMailboxAddress(address)
    return this.resolveDefault('claim').claim(filter, signal)
  }

  /**
   * Settle through the configured default provider.
   * @param leaseRef - the ref received from the claiming call.
   * @param outcome - delivery-envelope outcome.
   * @param signal - caller cancellation owning the settlement write.
   */
  async settle(leaseRef: MailboxLeaseRef, outcome: MailboxOutcome, signal?: AbortSignal): Promise<void> {
    await this.resolveDefault('settle').settle(leaseRef, outcome, signal)
  }

  /**
   * Read stored messages by traceId through the configured default provider —
   * the same pure lookup the provider contract declares, with no address
   * grammar to validate and no claim, settlement, or other write behind it.
   * @param traceId - the correlation id to search for, matched exactly.
   * @param signal - caller cancellation owning the scan.
   * @returns one entry per stored message carrying the id, earliest send first.
   */
  async lookupByTraceId(traceId: string, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]> {
    return this.resolveDefault('lookupByTraceId').lookupByTraceId(traceId, signal)
  }

  /**
   * Read stored messages addressed to one address since a time through the
   * configured default provider — the same pure inbound scan the provider
   * contract declares, with no claim, settlement, or other write behind it.
   * @param address - the recipient address to scan; grammar-checked here so
   *   a malformed address fails at the seam edge.
   * @param sinceMs - epoch-milliseconds floor (inclusive) on the row's
   *   admission time.
   * @param signal - caller cancellation owning the scan.
   * @returns one entry per matching row, earliest admission first.
   */
  async lookupInboundSince(address: MailboxAddress, sinceMs: number, signal?: AbortSignal): Promise<readonly MailboxTraceEntry[]> {
    parseMailboxAddress(address)
    return this.resolveDefault('lookupInboundSince').lookupInboundSince(address, sinceMs, signal)
  }

  /**
   * Resolve the convenience target provider, failing loud with the reason a
   * call cannot proceed.
   * @param operation - caller context, for the error message.
   * @returns the resolved provider.
   */
  private resolveDefault(operation: string): MailboxProvider {
    if (this.defaultProvider === undefined) {
      throw new Error(`mailbox ${operation}: no defaultProvider is configured; pass a provider explicitly instead`)
    }
    const provider = this.providers.get(this.defaultProvider)
    if (provider === undefined) {
      throw new Error(`mailbox ${operation}: configured defaultProvider "${this.defaultProvider}" is not registered`)
    }
    return provider
  }
}

/**
 * Validate the configured default-provider name once at construction.
 * @param value - the raw config value.
 * @returns the resolved name.
 */
function resolveDefaultProvider(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error('mailbox defaultProvider must be a non-empty provider name')
  }
  return trimmed
}

export { MailboxRegistry as default }
