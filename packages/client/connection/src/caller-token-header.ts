/**
 * Request header that carries the per-boot caller token. A header, not a cookie: a cookie is
 * sent to every port on the host by the browser, so a seat's own dev server on another
 * loopback port could read and replay it. The page keeps the token in memory and attaches
 * this header to each `fetch`. Browser-safe: shared by the host gate and the page.
 */
export const CALLER_TOKEN_HEADER = 'x-dsh-token'
