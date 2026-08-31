/** UUID generation for wire correlation, safe on insecure origins. */

/**
 * Generate an RFC 4122 version 4 UUID without requiring a secure context.
 * @returns a UUID backed by `crypto.getRandomValues()`, which browsers expose on
 *   insecure origins too — unlike `crypto.randomUUID()`, which exists only in
 *   secure contexts (HTTPS or localhost), neither of which is the designed
 *   plain-HTTP LAN deployment. Kept in step with the identical helper in
 *   `@deepseek-ai/dsh-client-connection`; this package cannot import it because
 *   the dependency edge points the other way.
 */
export function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
