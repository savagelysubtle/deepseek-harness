import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import { AgUiServer, bearerTokenMatches, parseRunId, parseThreadId } from '../src/server.ts'
import type { AgUiServerTuning, ResolvedAgUiOptions } from '../src/server.ts'

const OPTIONS: ResolvedAgUiOptions = {
  host: '127.0.0.1',
  port: 0,
  bearerToken: 'test-token-1234',
  keepAliveMs: 15_000,
  maxBufferedEvents: 256,
}

/** One watched log: a mutable object standing in for `session.events`. */
function makeLog(events: SessionEvent[] = []): { events: SessionEvent[] } {
  return { events }
}

/** Boot one server over an in-memory log table; disposal rides afterEach. */
async function makeServer(
  logs: Map<string, ReturnType<typeof makeLog>>,
  options: Partial<ResolvedAgUiOptions> = {},
  tuning: AgUiServerTuning = {},
) {
  const server = new AgUiServer(
    { ...OPTIONS, ...options },
    threadId => logs.get(threadId)?.events,
    undefined,
    tuning,
  )
  await server.listen()
  servers.push(server)
  return { server, url: (path: string): string => `http://127.0.0.1:${server.port}${path}` }
}

const servers: AgUiServer[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) await server.dispose()
})

/** Minimal event builder for broadcast fixtures. */
function ev(type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent {
  return { type, seq: 1, time: 0, data } as unknown as SessionEvent
}

/**
 * Read an SSE stream until the marker appears (or the stream ends), returning
 * everything received so far.
 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(marker)) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value)
  }
  return text
}

/** Drain an SSE stream to EOF and return its full text. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value)
  }
}

async function attach(harness: { url: (path: string) => string }, path: string, body = ''): Promise<Response> {
  return fetch(harness.url(path), {
    method: 'POST',
    headers: { authorization: `Bearer ${OPTIONS.bearerToken}` },
    body,
  })
}

describe('SSE endpoint', () => {
  it('frames each event as `event: <TYPE>` plus one JSON data line, snapshots first', async () => {
    const logs = new Map([[sessionIdOf('s-1'), makeLog([
      ev('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    ])]])
    const harness = await makeServer(logs)
    const response = await attach(harness, '/ag-ui/s-1', '{"runId":"base"}')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')

    // No open turn in the log: the opening batch is exactly the snapshot.
    const reader = response.body!.getReader()
    const snapshot = await readUntil(reader, 'MESSAGES_SNAPSHOT\n')
    expect(snapshot.startsWith('event: MESSAGES_SNAPSHOT\ndata: {"type":"MESSAGES_SNAPSHOT",')).toBe(true)
    expect(snapshot).toContain('"messages":[{"id":"u1","role":"user","content":"hello"}]')

    harness.server.broadcastSessionEvent(sessionIdOf('s-1'), ev('turn/start', { turn: 2 }))
    const live = await readUntil(reader, 'RUN_STARTED')
    expect(live).toContain('event: RUN_STARTED\ndata: {"type":"RUN_STARTED","threadId":"s-1","runId":"base-2"}\n\n')
  })

  it('answers 404 off-store, 405 for GET, and 404 for stray paths', async () => {
    const harness = await makeServer(new Map())
    const missing = await attach(harness, '/ag-ui/nope')
    expect(missing.status).toBe(404)
    const wrongMethod = await fetch(harness.url('/ag-ui/s-1'), {
      method: 'GET',
      headers: { authorization: `Bearer ${OPTIONS.bearerToken}` },
    })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    const strayPath = await attach(harness, '/other')
    expect(strayPath.status).toBe(404)
  })

  it('rejects malformed bodies and thread ids with 400', async () => {
    const logs = new Map([[sessionIdOf('s-1'), makeLog()]])
    const harness = await makeServer(logs)
    expect((await attach(harness, '/ag-ui/s-1', '{oops')).status).toBe(400)
    expect((await attach(harness, '/ag-ui/s-1', '[1]')).status).toBe(400)
    expect((await attach(harness, '/ag-ui/s-1', '{"runId":42}')).status).toBe(400)
    expect((await attach(harness, '/ag-ui/%zz')).status).toBe(400)
  })

  it('uses the client runId base and synthesizes mid-run RUN_STARTED after the snapshot', async () => {
    const logs = new Map([[sessionIdOf('s-mid'), makeLog([ev('turn/start', { turn: 7 })])]])
    const harness = await makeServer(logs)
    const response = await attach(harness, '/ag-ui/s-mid', '{"runId":"client-run"}')
    const reader = response.body!.getReader()
    const received = await readUntil(reader, 'RUN_STARTED')
    const snapshotAt = received.indexOf('MESSAGES_SNAPSHOT')
    const startedAt = received.indexOf('RUN_STARTED')
    expect(snapshotAt).toBeGreaterThanOrEqual(0)
    expect(startedAt).toBeGreaterThan(snapshotAt)
    expect(received).toContain('"runId":"client-run-7"')
  })

  it('keeps per-connection brackets separate across two watchers of one thread', async () => {
    const logs = new Map([[sessionIdOf('s-two'), makeLog()]])
    const harness = await makeServer(logs)
    const first = await attach(harness, '/ag-ui/s-two', '{"runId":"w1"}')
    const second = await attach(harness, '/ag-ui/s-two', '{"runId":"w2"}')

    harness.server.broadcastSessionEvent(sessionIdOf('s-two'), ev('turn/start', { turn: 1 }))
    const readers = [first.body!.getReader(), second.body!.getReader()]
    const seen = await Promise.all([
      readUntil(readers[0] as ReadableStreamDefaultReader<Uint8Array>, 'RUN_STARTED'),
      readUntil(readers[1] as ReadableStreamDefaultReader<Uint8Array>, 'RUN_STARTED'),
    ])
    // Each watcher independently opened its own run bracket from the same event.
    expect(seen[0]).toContain('"runId":"w1-1"')
    expect(seen[1]).toContain('"runId":"w2-1"')
  })
})

describe('keepalive', () => {
  it('writes a ping comment on the configured interval under fake timers', async () => {
    // Only wall-clock timers are faked: immediates stay real so node:http
    // connection setup and queue drains keep running during the advance.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const logs = new Map([[sessionIdOf('s-ping'), makeLog()]])
    const harness = await makeServer(logs, { keepAliveMs: 1_000 })
    const pings: string[] = []
    const raw = await connectRaw(harness.url('/ag-ui/s-ping'))
    raw.on('data', (chunk: Buffer) => { pings.push(chunk.toString('utf8')) })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(pings.join('').match(/: ping/g)).toHaveLength(3)
    raw.destroy()
  })
})

/** Open a raw HTTP request whose response surfaces byte-level writes. */
async function connectRaw(url: string): Promise<import('node:http').IncomingMessage> {
  const http = await import('node:http')
  return await new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request({
      host: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { authorization: `Bearer ${OPTIONS.bearerToken}` },
    }, resolve)
    req.on('error', reject)
    req.end()
  })
}

describe('bounded queue overflow', () => {
  it('closes only the stalled stream with a terminal RUN_ERROR frame; the other watcher continues', async () => {
    const logs = new Map([[sessionIdOf('s-burst'), makeLog()]])
    // The victim's drain parks after writing its opening snapshot, so its
    // bounded queue is the binding constraint while the survivor's scheduler
    // resolves immediately — no reliance on kernel socket-buffer sizes.
    const tuning: AgUiServerTuning = {
      yieldBetweenBatches: label => label === 's-burst#1'
        ? new Promise<void>(() => {})
        : Promise.resolve(),
    }
    const harness = await makeServer(logs, { maxBufferedEvents: 5 }, tuning)
    const victim = await attach(harness, '/ag-ui/s-burst')
    const survivor = await attach(harness, '/ag-ui/s-burst')

    // Each unstreamed call projects a three-frame triad. Spreading the burst
    // over macrotasks lets the survivor drain every batch while the parked
    // victim accumulates past its bound of 5 on the second triad.
    for (let index = 1; index <= 5; index += 1) {
      harness.server.broadcastSessionEvent(
        sessionIdOf('s-burst'),
        ev('tool/call', { turn: 1, step: 0, callId: `call-${index}`, name: 'ls', arguments: '{}' }),
      )
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    const victimText = await readAll(victim.body!.getReader())
    expect(victimText).toContain('event: RUN_ERROR')
    expect(victimText).toContain('event queue exceeded 5 buffered events')
    expect(victimText).not.toContain('TOOL_CALL_START')

    // The other watcher of the same thread receives every triad, unaffected.
    const survivorText = await readUntil(survivor.body!.getReader(), '"toolCallId":"call-5"')
    // One match per wire frame line: the `event:` name occurrence counts
    // frames without also matching each data line's `"type"` field.
    expect(survivorText.match(/event: TOOL_CALL_START/g)).toHaveLength(5)
    expect(survivorText).not.toContain('RUN_ERROR')
  })
})

describe('wire parsing units', () => {
  it('bearerTokenMatches accepts equal tokens only', () => {
    expect(bearerTokenMatches(`Bearer ${OPTIONS.bearerToken}`, OPTIONS.bearerToken)).toBe(true)
    expect(bearerTokenMatches('Bearer wrong-token', OPTIONS.bearerToken)).toBe(false)
    expect(bearerTokenMatches(`Basic ${OPTIONS.bearerToken}`, OPTIONS.bearerToken)).toBe(false)
    expect(bearerTokenMatches(undefined, OPTIONS.bearerToken)).toBe(false)
  })

  it('parseThreadId admits store-style ids and rejects separators and control characters', () => {
    expect(parseThreadId('session-12')).toBe(sessionIdOf('session-12'))
    expect(parseThreadId('abc_DEF.9:x-y~z')).toBeDefined()
    expect(() => parseThreadId('')).toThrow()
    expect(() => parseThreadId('a/b')).toThrow()
    expect(() => parseThreadId('a\tb')).toThrow()
    expect(() => parseThreadId('x'.repeat(600))).toThrow()
  })

  it('parseRunId admits absent, empty, and valid runId bodies only', () => {
    expect(parseRunId('')).toBeUndefined()
    expect(parseRunId('   ')).toBeUndefined()
    expect(parseRunId('{}')).toBeUndefined()
    expect(parseRunId('{"runId":"r-1"}')).toBe('r-1')
    expect(() => parseRunId('{oops')).toThrow()
    expect(() => parseRunId('[1]')).toThrow()
    expect(() => parseRunId('"str"')).toThrow()
    expect(() => parseRunId('{"runId":42}')).toThrow()
    expect(() => parseRunId('{"runId":""}')).toThrow()
    expect(() => parseRunId(`{"runId":"${'x'.repeat(257)}"}`)).toThrow()
  })
})
