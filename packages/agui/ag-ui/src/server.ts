/**
 * The adapter's own HTTP listener: bearer-authenticated `POST /ag-ui/:threadId`
 * endpoints that stream one session's translated AG-UI frames over SSE.
 *
 * The listener is deliberately NOT mounted on the web-GUI server: that server
 * is browsers-only, loopback, and unauthenticated by contract, while this
 * endpoint exposes session content to external dashboards and therefore owns
 * its own socket, its own auth, and its own lifecycle. Frames fan out through
 * a per-thread broadcaster; every connection drains a bounded queue so a slow
 * consumer is disconnected instead of growing memory without limit.
 *
 * @module @deepseek-ai/dsh-ag-ui/server
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  createBracketState,
  isOpenTurn,
  projectMessages,
  synthesizeRunStart,
  translateAgentError,
  translateSessionEvent,
} from './translate.ts'
import type { AgUiEvent, BracketState } from './types.ts'

/** Fully resolved deployment values backing one listener instance. */
export interface ResolvedAgUiOptions {
  /** Bind address of the listener. */
  host: string
  /** TCP port; 0 selects an ephemeral port. */
  port: number
  /** Bearer token every request must present. */
  bearerToken: string
  /** Keepalive comment interval in milliseconds. */
  keepAliveMs: number
  /** Per-connection event-queue bound. */
  maxBufferedEvents: number
}

/** Longest threadId accepted on the wire; session ids are short store-minted or caller strings. */
const MAX_THREAD_ID_LENGTH = 512

/** Request-body ceiling; the only admitted field is an optional short runId string. */
const MAX_BODY_BYTES = 64 * 1024

/** Observer of one emitted frame, keyed by the connection label that wrote it. */
export type FrameObserver = (connectionLabel: string, frame: AgUiEvent) => void

/**
 * Runtime-only scheduler tuning; production leaves it unset. Mirrors the
 * transport-override precedent (acp `Config.stream`): tests substitute a
 * controllable yield so queue-bound behavior is observable without relying on
 * kernel socket-buffer sizes.
 */
export interface AgUiServerTuning {
  /**
   * Yield between two drain batches of one connection. Receives the
   * connection label; the returned promise gates the next batch.
   */
  readonly yieldBetweenBatches?: (label: string) => Promise<void>
}

/**
 * Servers currently alive in this process. The invariant companion walks this
 * registry (and subscribes for future servers) to assert the frame relation
 * on live traffic; ordinary consumers never need it.
 */
const activeServers = new Set<AgUiServer>()

const serverObservers = new Set<(server: AgUiServer) => void>()

/**
 * Subscribe to server creation for the lifetime of the process.
 * @param observer - called synchronously each time a listener starts.
 * @returns the disposer removing the subscription.
 */
export function onAgUiServer(observer: (server: AgUiServer) => void): () => void {
  serverObservers.add(observer)
  return () => { serverObservers.delete(observer) }
}

/**
 * Snapshot of the servers alive right now; pair with {@link onAgUiServer} to
 * also catch servers created after the snapshot.
 * @returns the live servers as an array, safe to iterate.
 */
export function listAgUiServers(): readonly AgUiServer[] {
  return [...activeServers]
}

/**
 * Encode one AG-UI event as an SSE frame.
 * @param frame - the event to encode.
 * @returns the exact wire bytes of the frame.
 */
function sseFrame(frame: AgUiEvent): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`
}

/**
 * Constant-time bearer-token check. Both sides hash to fixed-length digests,
 * so `timingSafeEqual` never throws on length mismatch and the comparison
 * time does not depend on where the tokens differ.
 * @param authorization - the request's Authorization header value, if any.
 * @param expected - the configured bearer token.
 * @returns whether the presented token matches.
 */
export function bearerTokenMatches(authorization: string | undefined, expected: string): boolean {
  const prefix = 'Bearer '
  const presented = authorization !== undefined && authorization.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : ''
  const presentedDigest = createHash('sha256').update(presented).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(presentedDigest, expectedDigest)
}

/**
 * Validate a wire threadId and brand it as a session id. The admitted
 * character subset keeps path separators and control characters out; existence
 * is checked separately against the session store.
 * @param raw - the path segment following `/ag-ui/`.
 * @returns the branded session id.
 * @throws when the segment is not a plausible session id.
 */
export function parseThreadId(raw: string): SessionId {
  if (raw.length === 0 || raw.length > MAX_THREAD_ID_LENGTH || !/^[\w.:~-]+$/.test(raw)) {
    throw new Error(`invalid threadId ${JSON.stringify(raw.slice(0, MAX_THREAD_ID_LENGTH))}`)
  }
  return raw as SessionId
}

/**
 * Parse the optional `{runId}` request body. An empty body attaches with a
 * generated run-id base.
 * @param body - raw request body text, possibly empty.
 * @returns the client-supplied run-id base, or undefined to generate one.
 * @throws when the body is not JSON or carries a malformed runId.
 */
export function parseRunId(body: string): string | undefined {
  if (body.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (cause) {
    throw new Error('request body must be JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  const runId = (parsed as { runId?: unknown }).runId
  if (runId !== undefined && (typeof runId !== 'string' || runId.length === 0 || runId.length > 256)) {
    throw new Error('request body runId must be a string of 1..256 characters')
  }
  return runId
}

/**
 * One attached SSE client: bracket state, bounded frame buffer, keepalive
 * timer, and the response socket. All frame writes funnel through
 * {@link Connection.enqueue} so wire order follows event arrival exactly.
 */
class Connection {
  /** Frames accepted but not yet handed to the socket. */
  private readonly buffer: AgUiEvent[] = []
  /** Whether a drain tick is scheduled or running. */
  private draining = false
  /** Whether this stream terminated (overflow, client hangup, or dispose). */
  private closed = false
  /** Resolved once the socket is fully torn down; quiescence awaits this. */
  readonly done: Promise<void>
  /** Per-connection protocol bracket tracker fed by the translator. */
  readonly state: BracketState
  private readonly finishDone: () => void
  private readonly keepalive: NodeJS.Timeout

  constructor(
    /** Server-owned diagnostic label (thread plus connection counter). */
    readonly label: string,
    private readonly res: ServerResponse,
    private readonly maxBufferedEvents: number,
    keepAliveMs: number,
    stateBase: { threadId: string; runId: string },
    private readonly logger: Logger | undefined,
    private readonly frameObservers: ReadonlySet<FrameObserver>,
    private readonly yieldBetweenBatches: (label: string) => Promise<void>,
    private readonly onClose: (connection: Connection) => void,
  ) {
    this.state = createBracketState(stateBase.threadId, stateBase.runId)
    let finishDone!: () => void
    this.done = new Promise<void>((resolve) => { finishDone = resolve })
    this.finishDone = finishDone
    this.keepalive = setInterval(() => {
      // Comment lines are ignored by SSE parsers and reset proxy idle timers
      // without touching the frame stream.
      this.rawWrite(': ping\n\n')
    }, keepAliveMs)
    res.on('close', () => { this.terminate() })
  }

  /**
   * Accept frames into the bounded queue. Observers (the package invariant)
   * are notified here — synchronously at acceptance, so a violated protocol
   * relation fails loud before any byte moves. Overflow terminates only THIS
   * stream: the terminal RUN_ERROR frame jumps the queue, then the socket
   * drains and closes while other connections of the same thread continue
   * unaffected.
   * @param frames - translated frames in emission order.
   */
  enqueue(frames: readonly AgUiEvent[]): void {
    if (this.closed || frames.length === 0) return
    if (this.buffer.length + frames.length > this.maxBufferedEvents) {
      this.fail(`event queue exceeded ${this.maxBufferedEvents} buffered events`)
      return
    }
    for (const frame of frames) {
      for (const observe of this.frameObservers) observe(this.label, frame)
    }
    this.buffer.push(...frames)
    if (!this.draining) {
      // One batched write per macrotask keeps the queue bound meaningful even
      // when the socket accepts every byte: a synchronous event burst always
      // accumulates here before the first drain tick runs.
      this.draining = true
      setImmediate(() => { void this.drain().catch(() => { /* client vanished; teardown owns the socket */ }) })
    }
  }

  /** Tear down the socket, timers, and registration; idempotent. */
  terminate(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepalive)
    if (!this.res.writableEnded) this.res.destroy()
    this.onClose(this)
    // One debug line per connection summarizes what the allowlist kept off the wire.
    this.logger?.debug(`ag-ui: ${this.label}: stream closed after ${this.state.droppedUnmapped} unmapped event(s) dropped`)
    this.finishDone()
  }

  /** Drain tick: hand the whole current batch to the socket, then yield. */
  private async drain(): Promise<void> {
    try {
      while (!this.closed && this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.buffer.length)
        let payload = ''
        for (const frame of batch) {
          payload += sseFrame(frame)
        }
        if (!this.rawWrite(payload)) {
          await new Promise<void>((resolve) => { this.res.once('drain', resolve) })
        }
        // Yield even on success so producers cannot outrun the bound below.
        await this.yieldBetweenBatches(this.label)
      }
    } catch (error: unknown) {
      // A write failure means the client is gone; the close handler finishes teardown.
      this.logger?.debug(`ag-ui: ${this.label}: write failed: ${String(error)}`)
    } finally {
      this.draining = false
      // Frames enqueued while this tick ran schedule another one.
      if (!this.closed && this.buffer.length > 0) {
        this.draining = true
        setImmediate(() => { void this.drain() })
      }
    }
  }

  /**
   * Write raw bytes outside the frame queue (keepalive comments only).
   * @param payload - exact bytes to write.
   * @returns whether the socket absorbed the data without backpressure.
   */
  private rawWrite(payload: string): boolean {
    if (this.closed) return true
    return this.res.write(payload)
  }

  /**
    * Queue-bound breach: emit the terminal error out-of-band and disconnect
    * this consumer only. The stream ends gracefully — the client reads the
    * RUN_ERROR frame followed by EOF, never a connection reset.
    * @param message - failure text carried by the terminal RUN_ERROR frame.
    */
  private fail(message: string): void {
    if (this.closed) return
    this.res.end(sseFrame({ type: 'RUN_ERROR', message }))
    this.terminate()
  }
}

/**
 * Read a request body up to {@link MAX_BODY_BYTES}.
 * @param req - the incoming request.
 * @returns the decoded body text ('' when absent).
 * @throws when the body exceeds the ceiling.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Production drain scheduler: one batch per macrotask, so a synchronous
 * producer burst always accumulates in the bounded buffer.
 * @returns a promise resolving on the next immediate tick.
 */
function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve) })
}

/**
 * Owns the node:http listener, the per-thread broadcaster, and every live
 * connection. Cordis coupling stays in `index.ts`; this class depends only on
 * Node and the pure translation module, which is what makes the SSE surface
 * unit-testable.
 */
export class AgUiServer {
  private readonly http: Server
  private readonly connections = new Map<SessionId, Set<Connection>>()
  private readonly frameObservers = new Set<FrameObserver>()
  private readonly yieldBetweenBatches: (label: string) => Promise<void>
  private connectionCounter = 0
  private disposed = false

  constructor(
    private readonly options: ResolvedAgUiOptions,
    /** Resolves a thread id to its live session log, or undefined when the id is unknown. */
    private readonly resolveSessionLog: (threadId: SessionId) => readonly SessionEvent[] | undefined,
    private readonly logger: Logger | undefined,
    tuning: AgUiServerTuning = {},
  ) {
    this.yieldBetweenBatches = tuning.yieldBetweenBatches ?? defaultYield
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        // Last-resort guard: one malformed request must never crash the process.
        // Past this point failures can only be logged, not answered.
        this.logger?.warn(`ag-ui: request handling failed: ${String(error)}`)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    activeServers.add(this)
    for (const notify of serverObservers) notify(this)
  }

  /**
   * Observe every frame this server writes across all connections — the seam
   * the package invariant validates through.
   * @param observer - called once per emitted frame with the connection label.
   * @returns the disposer removing the observer.
   */
  onFrame(observer: FrameObserver): () => void {
    this.frameObservers.add(observer)
    return () => { this.frameObservers.delete(observer) }
  }

  /**
   * Bind the listener.
   * @returns resolves once the socket accepts connections.
   * @throws when the configured host/port cannot be bound.
   */
  listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.options.port, this.options.host, () => {
        this.http.off('error', reject)
        // Runtime bind errors after startup are logged; the listener keeps serving.
        this.http.on('error', (error: Error) => { this.logger?.warn(`ag-ui: listener error: ${error.message}`) })
        resolve()
      })
    })
  }

  /** Bound TCP port; meaningful only after {@link listen} resolves. */
  get port(): number {
    return (this.http.address() as AddressInfo).port
  }

  /**
   * Fan one live session event out to every connection watching its thread.
   * @param sessionId - session the event belongs to.
   * @param event - the already-published session event.
   */
  broadcastSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    const watchers = this.connections.get(sessionId)
    if (watchers === undefined) return
    for (const connection of [...watchers]) {
      connection.enqueue(translateSessionEvent(event, connection.state))
    }
  }

  /**
   * Close every watcher's open run with RUN_ERROR when its agent fails
   * out-of-band (the failure itself is not a session event).
   * @param sessionId - session whose agent failed.
   * @param message - rendered failure message.
   */
  broadcastAgentError(sessionId: SessionId, message: string): void {
    const watchers = this.connections.get(sessionId)
    if (watchers === undefined) return
    for (const connection of [...watchers]) {
      connection.enqueue(translateAgentError(connection.state, message))
    }
  }

  /**
   * Stop listening, destroy every connection, and wait until all sockets are
   * torn down. Disposal also removes the server from the process-wide
   * registry, so an HMR reload leaves no observable residue behind.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const closed = new Promise<void>((resolve) => { this.http.close(() => { resolve() }) })
    this.http.closeAllConnections()
    const pending: Promise<void>[] = [closed]
    for (const watchers of [...this.connections.values()]) {
      for (const connection of [...watchers]) {
        connection.terminate()
        pending.push(connection.done)
      }
    }
    await Promise.all(pending)
    activeServers.delete(this)
  }

  /** Route one request; rejections are answered by the constructor guard. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerTokenMatches(req.headers.authorization, this.options.bearerToken)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' })
      res.end()
      return
    }
    /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
    const url = new URL(req.url ?? '/', 'http://ag-ui.invalid')
    const match = /^\/ag-ui\/([^/]+)$/.exec(url.pathname)
    if (match === null) {
      res.writeHead(this.disposed ? 503 : 404)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let body: string
    let threadId: SessionId
    try {
      threadId = parseThreadId(decodeURIComponent(match[1] as string))
      body = await readBody(req)
    } catch (error: unknown) {
      res.writeHead(400)
      res.end(error instanceof Error ? error.message : String(error))
      return
    }
    const events = this.resolveSessionLog(threadId)
    if (events === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    let runIdBase: string | undefined
    try {
      runIdBase = parseRunId(body)
    } catch (error: unknown) {
      res.writeHead(400)
      res.end(error instanceof Error ? error.message : String(error))
      return
    }
    this.attach(res, threadId, events, runIdBase ?? `run-${randomUUID()}`)
  }

  /**
   * Attach one SSE stream: register first, then compute the opening frames
   * from the log, then enqueue them. Registration, projection, and the opening
   * enqueue share one synchronous section, so no live event can slip between
   * the snapshot and the live subscription.
   * @param res - response socket to stream over.
   * @param threadId - validated session id to watch.
   * @param events - the session log at attach time.
   * @param runIdBase - connection-level run-id base (client-supplied or generated).
   */
  private attach(res: ServerResponse, threadId: SessionId, events: readonly SessionEvent[], runIdBase: string): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    this.connectionCounter += 1
    const label = `${threadId}#${this.connectionCounter}`
    const watchers = this.connections.get(threadId) ?? new Set<Connection>()
    const connection = new Connection(
      label,
      res,
      this.options.maxBufferedEvents,
      this.options.keepAliveMs,
      { threadId, runId: runIdBase },
      this.logger,
      this.frameObservers,
      this.yieldBetweenBatches,
      (closing) => {
        const current = this.connections.get(threadId)
        if (current === undefined) return
        current.delete(closing)
        if (current.size === 0) this.connections.delete(threadId)
      },
    )
    watchers.add(connection)
    this.connections.set(threadId, watchers)
    connection.enqueue([
      { type: 'MESSAGES_SNAPSHOT', messages: projectMessages(events) },
      ...synthesizeRunStart(connection.state, isOpenTurn(events)),
    ])
  }
}
