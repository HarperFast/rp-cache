import { HttpObjectSource } from './resources/HttpObjectSource.js';
import { ensureJsonHeaders } from './util/headers.js';
import { HttpObject } from './resources/HttpObject.js';
import { hooks, config, HOOK_NAMES } from './hooks.js';
import { requestUpstream } from './util/upstream.js';
import { buildUpstreamRequest, cleanResponseHeaders, appendVia } from './util/proxyHeaders.js';
import { startWarmer, stopWarmer } from './warmer.js';

const parseClientCacheControl = (req) => {
	const result = {
		noStore: false,
		noCache: false,
		onlyIfCached: false,
		maxAge: null,
		minFresh: null,
		maxStale: null,
	};
	const cc = req.headers.get('cache-control');
	if (!cc) return result;
	for (const raw of cc.split(',')) {
		const part = raw.trim();
		if (!part) continue;
		const [rawName, rawValue] = part.split('=');
		const name = rawName.trim().toLowerCase();
		const value = rawValue?.trim();
		switch (name) {
			case 'no-store':
				result.noStore = true;
				break;
			case 'no-cache':
				result.noCache = true;
				break;
			case 'only-if-cached':
				result.onlyIfCached = true;
				break;
			case 'max-age':
				result.maxAge = Number(value);
				break;
			case 'min-fresh':
				result.minFresh = Number(value);
				break;
			case 'max-stale':
				result.maxStale = value !== undefined ? Number(value) : Infinity;
				break;
		}
	}
	return result;
};

const normalizeQueryForKey = (urlString) => {
	const qIdx = urlString.indexOf('?');
	if (qIdx === -1) return urlString;
	const path = urlString.slice(0, qIdx);
	const search = urlString.slice(qIdx + 1);
	if (!search) return path;

	const params = new URLSearchParams(search);

	if (config.cacheKeyQueryStripParams?.length) {
		for (const name of config.cacheKeyQueryStripParams) params.delete(name);
	}

	if (config.cacheKeyQueryAllowlist?.length) {
		const allowed = new Set(config.cacheKeyQueryAllowlist);
		for (const key of [...params.keys()]) {
			if (!allowed.has(key)) params.delete(key);
		}
	}

	const entries = [...params.entries()];
	if (config.sortQueryParams !== false) {
		entries.sort(([a], [b]) => a.localeCompare(b));
	}

	if (entries.length === 0) return path;
	return `${path}?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
};

const resolveUpstreamUrl = (req) => {
	const fromHook = hooks.resolveUpstream(req);
	if (fromHook) return fromHook;

	if (config.upstream) {
		const upstreamUrl = new URL(config.upstream);
		const prefix = upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname.replace(/\/$/, '');
		return `${upstreamUrl.origin}${prefix}${req.url}`;
	}

	const headerHost = req.headers.get(config.upstreamHostHeader);
	if (!headerHost) {
		const error = new Error('Missing upstream host header');
		error.statusCode = 400;
		throw error;
	}

	if (config.upstreamAllowlist?.length) {
		if (!config.upstreamAllowlist.includes(headerHost)) {
			const error = new Error('Upstream host not allowed');
			error.statusCode = 403;
			throw error;
		}
	} else if (!config.trustForwardedHost) {
		const error = new Error('Upstream resolution misconfigured');
		error.statusCode = 500;
		throw error;
	}

	return `https://${headerHost}${req.url}`;
};

const formatProxyResponse = (upstreamRes, cacheStatusLabel) => {
	const headers = cleanResponseHeaders(upstreamRes.headers);
	headers.set(config.cacheStatusHeader, cacheStatusLabel);
	appendVia(headers);
	return {
		status: upstreamRes.statusCode,
		headers,
		body: upstreamRes.body,
	};
};

const stripBodyForHead = (req, response) => {
	if (req.method === 'HEAD') {
		response.body = null;
	}
	return response;
};

const counters = {
	hit: 0,
	miss: 0,
	revalidated: 0,
	bypass: 0,
	invalidate: 0,
	error: 0,
};
const pluginStartTime = Date.now();

const readCacheStatus = (headers, key) => {
	if (!headers) return null;
	if (typeof headers.get === 'function') return headers.get(key);
	const lower = key.toLowerCase();
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === lower) return headers[name];
	}
	return null;
};

const pathBucketOf = (rawUrl) => {
	const path = rawUrl.split('?')[0];
	const match = path.match(/^\/(\w*)/);
	return match?.[1] || 'root';
};

const recordOutcome = (startNs, req, status) => {
	const key = String(status ?? 'unknown').toLowerCase();
	if (key in counters) counters[key]++;
	if (typeof server === 'undefined' || typeof server.recordAnalytics !== 'function') return;
	const elapsedMs = performance.now() - startNs;
	server.recordAnalytics(elapsedMs, `cache-${key}`, pathBucketOf(req.url));
};

const handleStats = (req) => {
	if (!req.user?.role?.permission?.super_user) {
		const error = new Error('Unauthorized');
		error.statusCode = 401;
		throw error;
	}
	return {
		status: 200,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(
			{
				counters: { ...counters },
				pluginStartedAt: new Date(pluginStartTime).toISOString(),
				uptimeMs: Date.now() - pluginStartTime,
			},
			null,
			2
		),
	};
};

const handleInvalidate = async (req) => {
	if (!req.user?.role?.permission?.super_user) {
		const error = new Error('Unauthorized');
		error.statusCode = 401;
		throw error;
	}

	const url = new URL(req.url, 'http://placeholder');
	const targetUrl = url.searchParams.get('url');
	const targetTag = url.searchParams.get('tag');

	if (targetUrl) {
		await databases.cache.HttpResourceCache.delete(targetUrl);
		return { status: 200, headers: { 'content-type': 'text/plain' }, body: `Invalidated ${targetUrl}\n` };
	}

	if (targetTag) {
		const results = databases.cache.HttpResourceCache.search(
			{ tags: targetTag },
			{ onlyIfCached: true, noCacheStore: true }
		);
		let count = 0;
		for await (const entry of results) {
			await databases.cache.HttpResourceCache.delete(entry.cacheKey);
			count++;
		}
		return {
			status: 200,
			headers: { 'content-type': 'text/plain' },
			body: `Invalidated ${count} entries tagged ${targetTag}\n`,
		};
	}

	const error = new Error("Specify '?url=...' or '?tag=...'");
	error.statusCode = 400;
	throw error;
};

const proxyBypass = async (req) => {
	const upstreamUrl = resolveUpstreamUrl(req);
	const upstreamReqConfig = buildUpstreamRequest(upstreamUrl, req);
	const upstreamRes = await requestUpstream(upstreamReqConfig);
	return formatProxyResponse(upstreamRes, 'BYPASS');
};

// Harper's Table.get(..., { onlyIfCached: true }) throws
// ServerError('Entry is not cached', 504) for a cold-cache key rather than
// returning undefined. For a `Cache-Control: no-cache` revalidation that just
// means "no existing entry, no conditionals to build — fetch fresh from the
// upstream as a normal MISS". Anything else we let propagate.
const getCachedEntryOrUndefined = async (cacheKey) => {
	try {
		return await databases.cache.HttpResourceCache.get(cacheKey, { onlyIfCached: true });
	} catch (err) {
		if (err?.message === 'Entry is not cached') return undefined;
		throw err;
	}
};

const proxyForceRevalidate = async (req) => {
	const cacheKey = hooks.buildCacheKey(req);
	const upstreamUrl = resolveUpstreamUrl(req);
	const existing = await getCachedEntryOrUndefined(cacheKey);
	const conditionals = {};
	if (existing) {
		const existingHeaders = ensureJsonHeaders(existing.headers);
		if (existingHeaders.etag) conditionals.etag = existingHeaders.etag;
		if (existing.lastCached) conditionals.lastModified = new Date(existing.lastCached).toUTCString();
	}
	const upstreamReqConfig = buildUpstreamRequest(upstreamUrl, req, conditionals);
	const upstreamRes = await requestUpstream(upstreamReqConfig);
	// If upstream returns 304 and we have an existing entry, serve it via the normal cached path
	if (upstreamRes.statusCode === 304 && existing) {
		const httpObject = await HttpObject.get(cacheKey, req);
		const headers = httpObject.headers;
		headers.set(config.cacheStatusHeader, 'REVALIDATED');
		appendVia(headers);
		return { status: httpObject.statusCode, headers, body: httpObject.content };
	}
	return formatProxyResponse(upstreamRes, 'MISS');
};

export const handleApplication = async (scope) => {
	config.upstreamHostHeader = scope.options.get(['upstreamHostHeader']) ?? config.upstreamHostHeader;
	config.cacheStatusHeader = scope.options.get(['cacheStatusHeader']) ?? config.cacheStatusHeader;
	config.viaIdentifier = scope.options.get(['viaIdentifier']) ?? config.viaIdentifier;
	config.upstream = scope.options.get(['upstream']) ?? null;
	config.upstreamAllowlist = scope.options.get(['upstreamAllowlist']) ?? null;
	config.trustForwardedHost = !!scope.options.get(['trustForwardedHost']);
	config.varyHeaders = scope.options.get(['varyHeaders']) ?? [];
	config.upstreamHeadersTimeoutMs = scope.options.get(['upstreamHeadersTimeoutMs']) ?? config.upstreamHeadersTimeoutMs;
	config.upstreamBodyTimeoutMs = scope.options.get(['upstreamBodyTimeoutMs']) ?? config.upstreamBodyTimeoutMs;
	config.upstreamRetries = scope.options.get(['upstreamRetries']) ?? config.upstreamRetries;
	config.upstreamRetryBaseDelayMs = scope.options.get(['upstreamRetryBaseDelayMs']) ?? config.upstreamRetryBaseDelayMs;
	config.maxBodyBytes = scope.options.get(['maxBodyBytes']) ?? config.maxBodyBytes;
	config.tagHeader = scope.options.get(['tagHeader']) ?? config.tagHeader;
	config.invalidatePath = scope.options.get(['invalidatePath']) ?? config.invalidatePath;
	config.statsPath = scope.options.get(['statsPath']) ?? config.statsPath;
	config.formatMap = scope.options.get(['formatMap']) ?? config.formatMap;
	config.sitemapUrl = scope.options.get(['sitemapUrl']) ?? null;
	config.sitemapWarmIntervalMs = scope.options.get(['sitemapWarmIntervalMs']) ?? config.sitemapWarmIntervalMs;
	config.sitemapWarmAtStartup = scope.options.get(['sitemapWarmAtStartup']) ?? config.sitemapWarmAtStartup;
	config.sitemapWarmFormats = scope.options.get(['sitemapWarmFormats']) ?? null;
	config.cacheKeyQueryStripParams = scope.options.get(['cacheKeyQueryStripParams']) ?? config.cacheKeyQueryStripParams;
	config.cacheKeyQueryAllowlist = scope.options.get(['cacheKeyQueryAllowlist']) ?? null;
	const sortQueryRaw = scope.options.get(['sortQueryParams']);
	config.sortQueryParams = typeof sortQueryRaw === 'boolean' ? sortQueryRaw : true;

	if (!config.upstream && !config.upstreamAllowlist?.length && !config.trustForwardedHost) {
		throw new Error(
			"rp-cache: no upstream configured. Set 'upstream', 'upstreamAllowlist', or 'trustForwardedHost' in the plugin config."
		);
	}

	const hooksFile = scope.options.get(['hooksFile']);

	const defaults = {
		isCacheableRequest: (req) => req.method === 'GET' || req.method === 'HEAD',
		isCacheableResponse: (res) => res.statusCode === 200,
		buildCacheKey: (req) => {
			const base = normalizeQueryForKey(resolveUpstreamUrl(req));
			const parts = [base];
			for (const name of [...(config.varyHeaders ?? [])].sort()) {
				const value = (req.headers.get(name) ?? '').trim().toLowerCase();
				parts.push(`${name.toLowerCase()}=${value}`);
			}
			const format = hooks.resolveFormat(req);
			if (format) parts.push(`format=${String(format).toLowerCase()}`);
			return parts.join('|');
		},
		resolveFormat: config.formatMap
			? (req) => {
					const accept = (req.headers.get('accept') ?? '').toLowerCase();
					for (const [mediaType, label] of Object.entries(config.formatMap)) {
						if (accept.includes(mediaType.toLowerCase())) return label;
					}
					return null;
				}
			: () => null,
		resolveUpstream: () => null,
		freshnessLifetime: () => null,
		tagsForResponse: () => null,
		transformResponseHeaders: (headers) => headers,
	};

	const applyOverrides = (overrides) => {
		for (const name of HOOK_NAMES) {
			const override = overrides?.[name];
			hooks[name] = typeof override === 'function' ? override : defaults[name];
		}
	};

	applyOverrides();

	databases.cache.HttpResourceCache.sourcedFrom(HttpObjectSource);

	startWarmer(scope.logger);
	scope.once?.('close', stopWarmer);

	if (hooksFile) {
		scope.handleEntry(hooksFile, async (entry) => {
			if (entry.entryType !== 'file') return;
			if (entry.eventType === 'unlink') {
				applyOverrides();
				return;
			}
			try {
				const module = await scope.import(entry.absolutePath);
				applyOverrides(module);
			} catch (err) {
				scope.logger.error?.(`Failed to load hooks file ${entry.absolutePath}: ${err?.message ?? err}`);
			}
		});
	}

	scope.server.http(async (req) => {
		const start = performance.now();
		try {
			const reqPath = req.url.split('?')[0];
			if (reqPath === config.statsPath) {
				return handleStats(req);
			}
			if (reqPath === config.invalidatePath) {
				const response = await handleInvalidate(req);
				recordOutcome(start, req, 'invalidate');
				return response;
			}

			if (!hooks.isCacheableRequest(req)) {
				const error = new Error('Method not allowed');
				error.statusCode = 405;
				throw error;
			}

			const directives = parseClientCacheControl(req);

			if (directives.noStore || req.headers.get('range')) {
				const response = await proxyBypass(req);
				recordOutcome(start, req, 'bypass');
				return stripBodyForHead(req, response);
			}

			if (directives.onlyIfCached) {
				const cacheKey = hooks.buildCacheKey(req);
				const existing = await getCachedEntryOrUndefined(cacheKey);
				if (!existing) {
					const error = new Error('Gateway Timeout');
					error.statusCode = 504;
					throw error;
				}
			}

			if (directives.noCache) {
				const response = await proxyForceRevalidate(req);
				const status = readCacheStatus(response.headers, config.cacheStatusHeader) ?? 'MISS';
				recordOutcome(start, req, status);
				return stripBodyForHead(req, response);
			}

			const cacheKey = hooks.buildCacheKey(req);
			const httpObject = await HttpObject.get(cacheKey, req);

			let headers = httpObject.headers;
			const status = httpObject.cacheStatus ?? 'HIT';
			headers.set(config.cacheStatusHeader, status);
			appendVia(headers);
			headers = hooks.transformResponseHeaders(headers, { req }) ?? headers;

			recordOutcome(start, req, status);

			return stripBodyForHead(req, {
				status: httpObject.statusCode,
				headers,
				body: httpObject.content,
			});
		} catch (err) {
			recordOutcome(start, req, 'error');
			throw err;
		}
	});
};
