/**
 * In-process OAuth authorization-server + MCP Streamable HTTP fixture: one
 * HTTP server that behaves like a consent-gated remote MCP deployment. Issues
 * exactly one authorization code, rotates refresh tokens, and records every
 * token-endpoint request so specs can assert which grants ran.
 *
 * @module
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'

/** Recorded token-endpoint request body (form fields). */
export type TokenRequest = Record<string, string>

/** Live fixture handle. */
export interface OAuthFixture {
  /** MCP endpoint URL (also the OAuth resource identifier). */
  url: string
  /** Server origin, acting as the authorization-server issuer. */
  base: string
  /** Every `/token` request body, in arrival order. */
  tokenRequests: TokenRequest[]
  /** Bearer token currently accepted by the MCP endpoint. */
  setValidToken(token: string): void
  /** Close the listener. */
  close(): Promise<void>
}

/** Read one form-encoded or JSON request body. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', (chunk) => { raw += String(chunk) })
    request.on('end', () => { resolve(raw) })
    request.on('error', reject)
  })
}

function parseForm(raw: string): TokenRequest {
  return Object.fromEntries(new URLSearchParams(raw))
}

/** Send a JSON-RPC (or plain) JSON response with optional extra headers. */
function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  response.end(JSON.stringify(value))
}

/**
 * Start the combined MCP + OAuth fixture.
 * @returns the live fixture; `close()` when the test finishes.
 */
export function startOAuthFixture(): Promise<OAuthFixture> {
  // Start rejecting everything: a test that needs an initially-valid bearer
  // sets it explicitly via setValidToken.
  let validToken = ''
  const tokenRequests: TokenRequest[] = []
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Build absolute URLs from the Host header: the default-origin trick
    // loses the ephemeral port, and the SDK validates resource identity by
    // exact URL including that port.
    const base = `http://${request.headers.host ?? '127.0.0.1'}`
    const incoming = new URL(request.url ?? '/', base)
    try {
      // ---- MCP resource ----
      if (incoming.pathname === '/mcp') {
        if (request.method === 'GET' || request.method === 'DELETE') {
          // SSE stream is optional per spec; refuse instead of hanging.
          response.writeHead(405).end()
          return
        }
        const auth = request.headers.authorization ?? ''
        if (auth !== `Bearer ${validToken}`) {
          response.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
          })
          response.end()
          return
        }
        const rpc = JSON.parse(await readBody(request)) as { id?: unknown; method?: string; params?: Record<string, unknown> }
        if (rpc.id === undefined) {
          response.writeHead(202).end()
          return
        }
        if (rpc.method === 'initialize') {
          sendJson(response, 200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
            },
          }, { 'mcp-session-id': 'sess-oauth-1' })
          return
        }
        if (rpc.method === 'tools/list') {
          sendJson(response, 200, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: { tools: [{ name: 'ping', description: 'Fixture ping tool', inputSchema: { type: 'object' } }] },
          })
          return
        }
        sendJson(response, 200, { jsonrpc: '2.0', id: rpc.id, result: {} })
        return
      }

      // ---- RFC 9728 protected resource metadata ----
      if (incoming.pathname === '/.well-known/oauth-protected-resource') {
        sendJson(response, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['mcp:tools'],
        })
        return
      }

      // ---- RFC 8414 authorization server metadata ----
      if (incoming.pathname === '/.well-known/oauth-authorization-server') {
        sendJson(response, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['mcp:tools'],
        })
        return
      }

      // ---- RFC 7591 dynamic client registration ----
      if (incoming.pathname === '/register' && request.method === 'POST') {
        sendJson(response, 201, {
          client_id: 'dyn-client-1',
          client_id_issued_at: Math.floor(Date.now() / 1000),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          redirect_uris: ['http://127.0.0.1/callback-placeholder'],
          token_endpoint_auth_method: 'none',
          client_name: 'DeepSeek Harness',
        })
        return
      }

      // ---- Authorization endpoint: instant consent, 302 back with a code ----
      if (incoming.pathname === '/authorize') {
        const redirectUri = incoming.searchParams.get('redirect_uri')!
        const state = incoming.searchParams.get('state')
        const location = new URL(redirectUri)
        location.searchParams.set('code', 'auth-code-1')
        if (state !== null) location.searchParams.set('state', state)
        response.writeHead(302, { location: String(location) })
        response.end()
        return
      }

      // ---- Token endpoint: authorization_code exchange + refresh rotation ----
      if (incoming.pathname === '/token' && request.method === 'POST') {
        const form = parseForm(await readBody(request))
        tokenRequests.push(form)
        if (form.grant_type === 'authorization_code') {
          sendJson(response, 200, {
            access_token: 'at-cli', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600,
          })
          return
        }
        if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== 'rt-1') {
            sendJson(response, 400, { error: 'invalid_grant' })
            return
          }
          sendJson(response, 200, {
            access_token: 'at-rotated', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600,
          })
          return
        }
        sendJson(response, 400, { error: 'unsupported_grant_type' })
        return
      }

      response.writeHead(404).end()
    } catch (error) {
      sendJson(response, 500, { fixtureError: String(error) })
    }
  }
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no fixture port')
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        base: `http://127.0.0.1:${address.port}`,
        tokenRequests,
        setValidToken(token: string): void {
          validToken = token
        },
        close(): Promise<void> {
          return new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error === undefined) resolveClose()
              else rejectClose(error)
            })
          })
        },
      })
    })
  })
}
