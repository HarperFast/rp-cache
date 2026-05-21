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

All options are optional.

### `upstreamHostHeader: string`

Request header to read for the upstream host. Defaults to `'x-forwarded-host'`.

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

| Hook                  | Default                        | Effect of returning falsy / non-default                     |
| --------------------- | ------------------------------ | ----------------------------------------------------------- |
| `isCacheableRequest`  | `req.method === 'GET'`         | Non-matching requests are rejected with `405`.              |
| `isCacheableResponse` | `res.statusCode === 200`       | When falsy, the upstream response is served but not stored. |
| `buildCacheKey`       | `https://<upstreamHost><path>` | Return a string the plugin will use as the cache key.       |

Standard HTTP semantics (`Cache-Control: no-store` / `no-cache`, ETag / `Last-Modified` revalidation) are always honored on top of the hook decisions.

## How requests are routed

For each incoming request:

1. `isCacheableRequest(req)` → if falsy, `405`.
2. `buildCacheKey(req)` produces the cache key (default reads the configured upstream-host header; missing → `403`).
3. The cache table (`cache.HttpResourceCache`) is consulted; on miss the request is issued upstream via [undici](https://github.com/nodejs/undici).
4. `isCacheableResponse(res, context)` (combined with `Cache-Control` directives) decides whether to store the response.

The cache table schema is defined in [src/schema.graphql](src/schema.graphql) and is created automatically by Harper from the schema.
