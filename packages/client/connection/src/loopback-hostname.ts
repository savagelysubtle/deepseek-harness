/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate stays
 * package-internal; client plugins consume the derived state through Cordis.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4LoopbackLiteral(hostname)
}

/**
 * Whether a dotted-quad literal is an IPv4 address in the 127/8 loopback
 * block. Shared by {@link isLoopbackHostname} (bracket-free hostname form)
 * and {@link isLoopbackAddress} (raw socket form, and the tail of an
 * IPv4-mapped IPv6 address).
 * @param literal - a candidate dotted-quad, with no surrounding brackets, prefix, or zone id.
 * @returns true only for a well-formed `127.x.y.z` literal.
 */
function isIPv4LoopbackLiteral(literal: string): boolean {
  const parts = literal.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a raw `net.Socket` remote address names the local loopback peer —
 * the forms a Node TCP socket reports, as opposed to {@link isLoopbackHostname}'s
 * URL-hostname forms (no brackets, no `localhost`). Recognizes the IPv6
 * loopback literal `::1`, any IPv4 address in the 127/8 block, and an
 * IPv4-mapped IPv6 loopback (`::ffff:127.x.y.z`, reported when the server
 * binds dual-stack — `webServer`'s `config.host` is configurable). Fails
 * closed on everything else: an absent or empty address (the socket already
 * closed), the unspecified addresses `0.0.0.0`/`::`, any other routable
 * address, a hostname, and an address carrying a zone id (`::1%eth0`) — zone
 * ids are not matched by any branch here and so are refused rather than
 * stripped and reconsidered. All comparisons are case-sensitive; a hex-form
 * mapped address (`::FFFF:7F00:1`) is deliberately not matched, because
 * libuv — what Node's `net.Socket` reports through — always renders a
 * mapped address in dotted lowercase form (`::ffff:127.0.0.1`), never hex.
 * @param remoteAddress - `req.socket.remoteAddress`, or undefined when the socket has already closed.
 * @returns true only for a recognized loopback address form.
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined || remoteAddress === '') return false
  if (remoteAddress === '::1') return true
  const literal = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
  return isIPv4LoopbackLiteral(literal)
}
