import { HttpObjectSource } from './resources/HttpObjectSource.js';
import { HttpObject } from './resources/HttpObject.js';
import { hooks, config, HOOK_NAMES } from './hooks.js';
import { requestUpstream } from './util/upstream.js';
import { buildUpstreamRequest, cleanResponseHeaders, appendVia } from './util/proxyHeaders.js';

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

const resolveUpstreamUrl = (req) => {
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

const proxyBypass = async (req) => {
	const upstreamUrl = resolveUpstreamUrl(req);
	const upstreamReqConfig = buildUpstreamRequest(upstreamUrl, req);
	const upstreamRes = await requestUpstream(upstreamReqConfig);
	return formatProxyResponse(upstreamRes, 'BYPASS');
};

const proxyForceRevalidate = async (req) => {
	const cacheKey = hooks.buildCacheKey(req);
	const upstreamUrl = resolveUpstreamUrl(req);
	const existing = await databases.cache.HttpResourceCache.get(cacheKey, { onlyIfCached: true });
	const conditionals = {};
	if (existing) {
		try {
			const existingHeaders = typeof existing.headers === 'string' ? JSON.parse(existing.headers) : existing.headers;
			if (existingHeaders?.etag) conditionals.etag = existingHeaders.etag;
		} catch {
			// headers stored as line-delimited string; tolerate
		}
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

	if (!config.upstream && !config.upstreamAllowlist?.length && !config.trustForwardedHost) {
		throw new Error(
			"rp-cache: no upstream configured. Set 'upstream', 'upstreamAllowlist', or 'trustForwardedHost' in the plugin config."
		);
	}

	const hooksFile = scope.options.get(['hooksFile']);

	const defaults = {
		isCacheableRequest: (req) => req.method === 'GET',
		isCacheableResponse: (res) => res.statusCode === 200,
		buildCacheKey: (req) => {
			const base = resolveUpstreamUrl(req);
			if (!config.varyHeaders?.length) return base;
			const parts = [base];
			for (const name of [...config.varyHeaders].sort()) {
				const value = (req.headers.get(name) ?? '').trim().toLowerCase();
				parts.push(`${name.toLowerCase()}=${value}`);
			}
			return parts.join('|');
		},
	};

	const applyOverrides = (overrides) => {
		for (const name of HOOK_NAMES) {
			const override = overrides?.[name];
			hooks[name] = typeof override === 'function' ? override : defaults[name];
		}
	};

	applyOverrides();

	databases.cache.HttpResourceCache.sourcedFrom(HttpObjectSource);

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
		if (!hooks.isCacheableRequest(req)) {
			const error = new Error('Method not allowed');
			error.statusCode = 405;
			throw error;
		}

		const directives = parseClientCacheControl(req);

		if (directives.noStore) {
			return proxyBypass(req);
		}

		if (directives.onlyIfCached) {
			const cacheKey = hooks.buildCacheKey(req);
			const existing = await databases.cache.HttpResourceCache.get(cacheKey, { onlyIfCached: true });
			if (!existing) {
				const error = new Error('Gateway Timeout');
				error.statusCode = 504;
				throw error;
			}
			// fall through to normal flow; Harper will serve from cache
		}

		if (directives.noCache) {
			return proxyForceRevalidate(req);
		}

		const cacheKey = hooks.buildCacheKey(req);
		const httpObject = await HttpObject.get(cacheKey, req);

		const headers = httpObject.headers;
		headers.set(config.cacheStatusHeader, httpObject.cacheStatus ?? 'HIT');
		appendVia(headers);

		return {
			status: httpObject.statusCode,
			headers,
			body: httpObject.content,
		};
	});
};
