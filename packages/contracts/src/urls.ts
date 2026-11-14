/**
 * The base of an HTTP API at `url`, with one trailing slash, so `new URL('path', base)` keeps a
 * path prefix such as `/api`.
 */
export function apiBaseUrl(url: string): URL {
  return new URL(`${url.replace(/\/$/, '')}/`);
}
