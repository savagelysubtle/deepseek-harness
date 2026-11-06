/**
 * Bounded stdin reader for the seat-guard hook. Guard-reachable: node builtins only, erasable
 * TypeScript only.
 *
 * @module @deepseek-ai/dsh-agent-claude-code-tools/stdin
 */

import { readSync } from 'node:fs'

/**
 * Read from a file descriptor until end of input or until `max + 1` bytes have been seen, whichever
 * comes first. A result longer than `max` bytes therefore means "too large"; the rest is not read.
 * A read error ends the read with what was collected (an empty or partial payload is denied later).
 * @param fd - the descriptor (0 for stdin).
 * @param max - the largest acceptable payload in bytes.
 * @returns the text read, at most `max + 1` bytes of it.
 */
export function readStdinCapped(fd: number, max: number): string {
  const chunks: Buffer[] = []
  let total = 0
  const chunk = Buffer.allocUnsafe(64 * 1024)
  while (total <= max) {
    let read = 0
    try {
      read = readSync(fd, chunk, 0, Math.min(chunk.length, max + 1 - total), null)
    } catch {
      break
    }
    if (read === 0) break
    chunks.push(Buffer.from(chunk.subarray(0, read)))
    total += read
  }
  return Buffer.concat(chunks).toString('utf8')
}
