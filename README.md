# `@harperfast/rp-cache`

A Harper plugin that provides a reverse-proxy HTTP object cache.

Incoming requests are forwarded to an upstream origin determined by a request header (default `x-forwarded-host`). The response is cached in a Harper table; subsequent requests for the same URL are served from the cache. ETag and `Last-Modified` revalidation against upstream, `Cache-Control` (`no-store`, `no-cache`, `max-age`) handling, and conditional `304` responses to clients are supported.

## Installation

In the consuming Harper application:

```sh
npm install @harperfast/rp-cache
```

Then reference the plugin in the application's `config.yaml`:

```yaml
'@harperfast/rp-cache':
  package: '@harperfast/rp-cache'
  files: '/*'
```

## Options

Exactly one upstream-resolution mode (`upstream`, `upstreamAllowlist`, or `trustForwardedHost`) must be configured; the plugin throws at startup otherwise.

### `upstream: string`

A single upstream origin URL (e.g. `'https://origin.example.com'` or `'https://origin.example.com/api'`). When set, every incoming request is proxied to this origin (preserving the request's path under any configured path prefix), and the request's host header is ignored.

### `upstreamAllowlist: string[]`

A list of upstream hostnames the request's host header is allowed to name. The header to read is governed by `upstreamHostHeader`. Hosts not in the list are rejected with `403`; a missing header is `400`. Always uses `https://` to reach the upstream.

### `trustForwardedHost: boolean`

When `true`, the plugin uses whatever host the request supplies via `upstreamHostHeader` without an allow-list. **Development only** — without it, any caller can make the proxy fetch from any host. Defaults to `false`.

### `upstreamHostHeader: string`

Request header consulted by `upstreamAllowlist` / `trustForwardedHost` modes. Defaults to `'x-forwarded-host'`.

### `cacheStatusHeader: string`

Name of the response header used to report cache status (`HIT` / `MISS` / `REVALIDATED`). Defaults to `'X-Cache'`.

### `viaIdentifier: string`

Pseudonym appended to the `Via` header on both the upstream request and the client response. Defaults to `'rp-cache'`.

### `upstreamHeadersTimeoutMs: number`

Maximum time (ms) to wait for the upstream response headers. Defaults to `5000`.

### `upstreamBodyTimeoutMs: number`

Maximum time (ms) to wait for the upstream response body. Defaults to `30000`.

### `upstreamRetries: number`

Maximum number of additional retry attempts after a network/timeout error. Each retry is backed off exponentially from `upstreamRetryBaseDelayMs`. Only retries on retryable connection / timeout errors; non-network errors propagate immediately. Defaults to `2`.

### `upstreamRetryBaseDelayMs: number`

Base delay (ms) for retry backoff. Defaults to `100`.

### `maxBodyBytes: number | null`

Hard limit on the upstream response body size. When set, responses larger than this are aborted by undici (the request fails). Defaults to `null` (unbounded). True streaming pass-through (proxying without buffering, for very large objects) is on the roadmap.

### `tagHeader: string`

Response header read from the upstream to associate the cached entry with surrogate tags. Defaults to `'surrogate-key'`. Multiple tags are whitespace-separated (Fastly convention).

### `invalidatePath: string`

Path that exposes the cache invalidation endpoint. Defaults to `'/.rp-cache/invalidate'`. Requires the requesting user to have `super_user` permission.

```
POST /.rp-cache/invalidate?url=https://origin.example.com/path   # single entry
POST /.rp-cache/invalidate?tag=articles                           # all entries tagged "articles"
```

### `statsPath: string`

Path that exposes a JSON summary of cache outcome counters (`hit` / `miss` / `revalidated` / `bypass` / `invalidate` / `error`) plus uptime. Defaults to `'/.rp-cache/stats'`. Requires `super_user` permission.

### `formatMap: Record<string, string>`

Shortcut for content-negotiated variant keying. Maps `Accept`-header substrings to format labels; the matched label is folded into the cache key as `|format=<label>`. The first matching media type wins (insertion order). Pair it with an upstream that returns the requested format. Defaults to `null` (no format dimension). Consumers needing more complex selection should override `resolveFormat` directly via `hooksFile`.

```yaml
'@harperfast/rp-cache':
  formatMap:
    'text/markdown': markdown
    'text/html': html
```

### `sitemapUrl: string | null`

URL of a sitemap.xml the plugin fetches periodically to pre-populate the cache. Each `<loc>` entry triggers a synthetic cache fill so warm requests already hit the cache. Defaults to `null` (warmer disabled).

### `sitemapWarmIntervalMs: number`

Interval between warm cycles. Defaults to `3600000` (1 hour). A value of `0` runs once at startup and never again.

### `sitemapWarmAtStartup: boolean`

When `true`, runs an initial warm cycle as soon as the plugin starts (async, doesn't block). Defaults to `true`.

### `sitemapWarmFormats: string[] | null`

Format labels (matching `formatMap` values) to warm for each sitemap URL. When set, the warmer synthesizes one request per (URL, format) pair using the corresponding media type in `Accept`. Defaults to `null` (warm a single default variant per URL).

### `varyHeaders: string[]`

Request headers to fold into the cache key, so that requests with different values for these headers get separate cached responses. Defaults to `[]`.

The plugin also reads the upstream's response `Vary` header: if it names any header not in `varyHeaders` — or is `*` — the response is served but not stored, to avoid handing the wrong variant to subsequent requests.

### `hooksFile: string`

Path (relative to the consuming app) to a JS file that exports any of the policy hooks listed below. The file is watched; saves are picked up without restarting Harper. Functions that aren't exported fall back to the plugin's defaults.

```yaml
'@harperfast/rp-cache':
  package: '@harperfast/rp-cache'
  files: '/*'
  hooksFile: './cache-hooks.js'
```

```js
// cache-hooks.js — every export is optional
export const isCacheableRequest = (req) => req.method === 'GET' && !req.url.startsWith('/admin');
export const isCacheableResponse = (res, context) => res.statusCode === 200;
export const buildCacheKey = (req) => `${req.headers.get('x-forwarded-host')}${req.url}`;
```

| Hook                       | Default                          | Effect of returning falsy / non-default                                                            |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `isCacheableRequest`       | `req.method === 'GET' or 'HEAD'` | Non-matching requests are rejected with `405`.                                                     |
| `isCacheableResponse`      | `res.statusCode === 200`         | When falsy, the upstream response is served but not stored.                                        |
| `buildCacheKey`            | `https://<upstreamHost><path>`   | Return a string the plugin will use as the cache key.                                              |
| `resolveFormat`            | `() => null`                     | Return a label (e.g. `'markdown'`) to fold into the cache key as `\|format=<label>`.               |
| `resolveUpstream`          | `() => null`                     | Return a full upstream URL to use instead of the configured `upstream` / `upstreamAllowlist` flow. |
| `freshnessLifetime`        | `() => null`                     | Return seconds; overrides the freshness calc, replacing `max-age`/`s-maxage`/`Expires`/heuristic.  |
| `tagsForResponse`          | `() => null`                     | Return a `string[]`; replaces the `Surrogate-Key` header–derived tags for this response.           |
| `transformResponseHeaders` | identity                         | Receive the final response `Headers` (post `X-Cache` / `Via`) and return modified headers.         |

Standard HTTP semantics (`Cache-Control: no-store` / `no-cache`, ETag / `Last-Modified` revalidation) are always honored on top of the hook decisions.

## Response Cache-Control

The plugin honors `no-store`, `private`, `no-cache`, `max-age`, `s-maxage`, `Expires`, and `Pragma: no-cache` for freshness. It also recognizes `stale-while-revalidate=N` and parses `stale-if-error=N`:

- `stale-while-revalidate=N`: while a stored entry has expired but is within `N` seconds of expiry, the plugin serves it stale and asynchronously revalidates in the background (via Harper's `allowStaleWhileRevalidate` hook).
- `stale-if-error=N`: the SIE timestamp is stored alongside each entry. Serving the stale entry on upstream errors is on the roadmap; the data is in place for the wiring.

## Request Cache-Control directives

Honored on the incoming request:

| Directive        | Behavior                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `no-store`       | Bypass the cache entirely: fetch upstream and serve, do not read or write. Response carries `X-Cache: BYPASS`.                  |
| `no-cache`       | Force revalidation with origin (using stored ETag / `Last-Modified` if any), refreshing the cached entry. `MISS`/`REVALIDATED`. |
| `only-if-cached` | Serve from cache only; if no cached entry exists, respond `504`.                                                                |

`max-age`, `min-fresh`, and `max-stale` request directives are not yet honored; they require explicit freshness modeling that lands later in the roadmap.

## How requests are routed

For each incoming request:

1. `isCacheableRequest(req)` → if falsy, `405`.
2. `buildCacheKey(req)` produces the cache key (default reads the configured upstream-host header; missing → `403`).
3. The cache table (`cache.HttpResourceCache`) is consulted; on miss the request is issued upstream via [undici](https://github.com/nodejs/undici).
4. `isCacheableResponse(res, context)` (combined with `Cache-Control` directives) decides whether to store the response.

The cache table schema is defined in [src/schema.graphql](src/schema.graphql) and is created automatically by Harper from the schema.
