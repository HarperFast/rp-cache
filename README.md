# `@harperfast/rp-cache`

A Harper plugin that provides a reverse-proxy HTTP object cache.

Incoming requests are forwarded to an upstream origin determined by a request header (default `x-forwarded-host`). The response is cached in a Harper table; subsequent requests for the same URL are served from the cache. ETag and `Last-Modified` revalidation against upstream, `Cache-Control` (`no-store`, `no-cache`, `max-age`) handling, and conditional `304` responses to clients are supported.

## Installation

In the consuming Harper application:

```sh
npm install @harperfast/rp-cache
```

Then reference the component in the application's `config.yaml`:

```yaml
'@harperfast/rp-cache':
  package: '@harperfast/rp-cache'
  files: '/*'
```

## Options

All options are optional.

### `upstreamHostHeader: string`

Request header to read for the upstream host. Defaults to `'x-forwarded-host'`.

## How requests are routed

For each incoming `GET`:

1. The configured upstream-host header is read; missing → `403`.
2. The cache key is `https://<host><path>`.
3. The cache table (`cache.HttpResourceCache`) is consulted; on miss, the request is issued upstream via [undici](https://github.com/nodejs/undici) and the response is stored.
4. Non-`GET` methods return `405`.

The cache table schema is defined in [src/schema.graphql](src/schema.graphql) and is created automatically by Harper from the schema.
