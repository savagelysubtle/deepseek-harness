/**
 * OAuth 2.0 support for Streamable HTTP MCP servers: a persisted
 * {@link OAuthClientProvider} whose tokens, dynamic client registration,
 * PKCE verifier, and discovery state live in one credential reference
 * (`DSH_MCP_OAUTH_<SERVERNAME>`) through the credential-reference seam —
 * never in an ad-hoc state file. Token values resolve per operation from the
 * store, so tokens written by the separate consent CLI reach a running host
 * on its next connection attempt without any restart.
 *
 * @module @deepseek-ai/dsh-mcp-client/oauth
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/** The minimal credential-store surface this module needs; satisfied by `ctx.credentials`. */
export interface OAuthCredentialStore {
  /**
   * Resolve one reference to its current value.
   * @param ref - the branded reference to read.
   * @returns the value and its source layer, or `undefined` while unconfigured.
   */
  resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>
  /**
   * Durably store one non-empty value.
   * @param ref - the branded reference to write.
   * @param value - the serialized state envelope.
   */
  set(ref: CredentialRef, value: string): Promise<void>
  /**
   * Remove one reference; removing an absent reference is a no-op.
   * @param ref - the branded reference to remove.
   */
  unset(ref: CredentialRef): Promise<void>
}

/** Envelope version; bump only for a breaking change to the stored shape. */
const ENVELOPE_VERSION = 1

/** Everything persisted for one server under one credential reference. */
interface StoredOAuthState {
  /** Envelope format version. */
  version: typeof ENVELOPE_VERSION
  /** Latest token set from an authorization, exchange, or refresh. */
  tokens?: OAuthTokens
  /** Registered client (static or RFC 7591 dynamic). */
  clientInformation?: OAuthClientInformationMixed
  /** PKCE verifier awaiting an authorization code. */
  codeVerifier?: string
  /** Cached RFC 9728 / authorization-server discovery results. */
  discoveryState?: OAuthDiscoveryState
}

/**
 * The credential reference holding one server's OAuth state. Uppercasing plus
 * replacing non-identifier characters keeps any configured serverName inside
 * the POSIX reference pattern; the mapping is deterministic so host and CLI
 * always agree.
 * @param serverName - the plugin config's stable server namespace.
 * @returns the branded credential reference.
 */
export function oauthCredentialRef(serverName: string): CredentialRef {
  return credentialRef(`DSH_MCP_OAUTH_${serverName.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_')}`)
}

/**
 * Serialize one state snapshot into the stored string form.
 * @param state - the complete state to persist.
 * @returns the JSON envelope text.
 */
function serializeState(state: StoredOAuthState): string {
  return JSON.stringify(state)
}

/**
 * Parse one stored value back into typed state. This is a durable-boundary
 * read of data this package wrote earlier: anything that does not match the
 * envelope fails loud with the offending reference named, because silently
 * treating corrupted credentials as "not authorized" would loop the user
 * through consent for no effect.
 * @param serverName - server namespace for error messages.
 * @param ref - the reference the value came from.
 * @param raw - the stored string.
 * @returns the parsed state.
 */
function parseState(serverName: string, ref: CredentialRef, raw: string): StoredOAuthState {
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`mcp-client(${serverName}): stored OAuth state under ${ref} is not valid JSON`, { cause })
  }
  if (
    typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
    || (candidate as { version?: unknown }).version !== ENVELOPE_VERSION
  ) {
    throw new Error(`mcp-client(${serverName}): stored OAuth state under ${ref} is not a version ${ENVELOPE_VERSION} envelope`)
  }
  const state = candidate as StoredOAuthState
  for (const key of ['tokens', 'clientInformation', 'discoveryState'] as const) {
    // Widened to unknown: the durable boundary validates what the type only
    // promises, and the widened read keeps that guard lint-legitimate.
    const value: unknown = state[key]
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new Error(`mcp-client(${serverName}): stored OAuth state under ${ref} has an invalid ${key} entry`)
    }
  }
  if (state.codeVerifier !== undefined && typeof state.codeVerifier !== 'string') {
    throw new Error(`mcp-client(${serverName}): stored OAuth state under ${ref} has an invalid codeVerifier entry`)
  }
  return state
}

/** Metadata describing this client to authorization servers. */
export function buildClientMetadata(redirectUri: string, scope?: string): OAuthClientMetadata {
  return {
    client_name: 'DeepSeek Harness',
    client_uri: 'https://github.com/deepseek-ai/deepseek-harness',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    // The SDK's scope selection prefers the server's WWW-Authenticate challenge
    // and resource metadata; this configured value is the documented fallback.
    ...(scope === undefined ? {} : { scope }),
  }
}

/** Options for {@link CredentialsOAuthProvider}. */
export interface CredentialsOAuthProviderOptions {
  /** Stable server namespace from the plugin config; names the credential reference. */
  serverName: string
  /** Absolute MCP endpoint URL; anchors discovery and resource indicators. */
  serverUrl: URL
  /** Optional scope override sent on authorization and token requests. */
  scope?: string
  /** Pre-registered client id; omission performs RFC 7591 dynamic registration. */
  staticClientId?: string
  /** Credential store (host: `ctx.credentials`; CLI: a local provider instance). */
  store: OAuthCredentialStore
  /**
   * The redirect URI advertised in client metadata and authorization requests.
   * Host instances use a documented placeholder (they never capture a redirect);
   * the consent CLI passes its loopback listener URL.
   */
  redirectUri: string
  /** Invoked when the flow needs human consent; hosts log guidance, the CLI prints the URL. */
  onAuthorizationUrl?: (authorizationUrl: URL) => void
}

/**
 * Persisted OAuth client provider. Every read goes through the store at call
 * time and every SDK write commits through it, so state written by one
 * process is visible to the other immediately.
 */
export class CredentialsOAuthProvider {
  readonly ref: CredentialRef

  private constructor(private readonly options: CredentialsOAuthProviderOptions) {
    this.ref = oauthCredentialRef(options.serverName)
  }

  /**
   * Create a provider over one credential store.
   * @param options - server identity, scope/client overrides, store, and redirect behavior.
   * @returns the provider instance.
   */
  static create(options: CredentialsOAuthProviderOptions): CredentialsOAuthProvider {
    return new CredentialsOAuthProvider(options)
  }

  private async load(): Promise<StoredOAuthState> {
    const resolved = await this.options.store.resolve(this.ref)
    if (resolved === undefined) return { version: ENVELOPE_VERSION }
    return parseState(this.options.serverName, this.ref, resolved.value)
  }

  private async mutate(mutator: (state: StoredOAuthState) => StoredOAuthState): Promise<void> {
    const next = mutator(await this.load())
    await this.options.store.set(this.ref, serializeState(next))
  }

  /**
   * Drop parts of the stored state after the server invalidated them.
   * @param scope - which credential class to clear; `'all'` removes the reference.
   */
  async invalidate(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') {
      await this.options.store.unset(this.ref)
      return
    }
    await this.mutate((state) => {
      if (scope === 'client') delete state.clientInformation
      if (scope === 'tokens') delete state.tokens
      if (scope === 'verifier') delete state.codeVerifier
      if (scope === 'discovery') delete state.discoveryState
      return state
    })
  }

  // ---- OAuthClientProvider surface ----

  get redirectUrl(): string {
    return this.options.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return buildClientMetadata(this.options.redirectUri, this.options.scope)
  }

  /**
   * Load the registered client, preferring configured static registration over
   * stored dynamic registration.
   * @returns the client information, or `undefined` while unregistered.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.options.staticClientId !== undefined) return { client_id: this.options.staticClientId }
    return (await this.load()).clientInformation
  }

  /**
   * Persist dynamically registered client information.
   * @param clientInformation - the RFC 7591 registration response.
   */
  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.options.staticClientId !== undefined) return
    await this.mutate(state => ({ ...state, clientInformation }))
  }

  /**
   * Load the current token set, resolving through the store per call so
   * externally written tokens are honored immediately.
   * @returns the tokens, or `undefined` while unauthorized.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens
  }

  /**
   * Persist a fresh token set (authorization result or refresh rotation).
   * @param tokens - the new token set.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.mutate((state) => {
      // A successful token grant completes the pending PKCE exchange; keeping
      // a spent verifier has no value, and deleting (not assigning undefined)
      // keeps the envelope honest under exactOptionalPropertyTypes.
      delete state.codeVerifier
      return { ...state, tokens }
    })
  }

  /**
   * Hand the authorization URL to the configured observer. Hosts log run-the-CLI
   * guidance; the CLI prints it for the user's browser.
   * @param authorizationUrl - the consent URL to visit.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.options.onAuthorizationUrl?.(authorizationUrl)
  }

  /**
   * Persist the SDK-generated PKCE verifier for the pending authorization.
   * @param codeVerifier - the verifier to carry to the token exchange.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.mutate(state => ({ ...state, codeVerifier }))
  }

  /**
   * Load the stored verifier for the pending exchange.
   * @returns the verifier.
   */
  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier
    if (verifier === undefined) {
      throw new Error(`mcp-client(${this.options.serverName}): no pending PKCE verifier under ${this.ref} — restart the login command`)
    }
    return verifier
  }

  /**
   * Cache discovery results to skip repeated RFC 9728 round trips.
   * @param state - the discovery state to persist.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.mutate(prev => ({ ...prev, discoveryState: state }))
  }

  /**
   * Load cached discovery results.
   * @returns the cached state, or `undefined` when none was saved.
   */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState
  }

  /**
   * Clear cached state classes the server reported invalid.
   * @param scope - which class to drop.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.invalidate(scope)
  }
}
