import { HttpObjectSource } from './resources/HttpObjectSource.js';
import { HttpObject } from './resources/HttpObject.js';
import { hooks, config, HOOK_NAMES } from './hooks.js';

const VIA_PROTOCOL = '1.1';

const appendVia = (headers) => {
	const entry = `${VIA_PROTOCOL} ${config.viaIdentifier}`;
	const existing = headers.get('via');
	headers.set('via', existing ? `${existing}, ${entry}` : entry);
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

export const handleApplication = async (scope) => {
	config.upstreamHostHeader = scope.options.get(['upstreamHostHeader']) ?? config.upstreamHostHeader;
	config.cacheStatusHeader = scope.options.get(['cacheStatusHeader']) ?? config.cacheStatusHeader;
	config.viaIdentifier = scope.options.get(['viaIdentifier']) ?? config.viaIdentifier;
	config.upstream = scope.options.get(['upstream']) ?? null;
	config.upstreamAllowlist = scope.options.get(['upstreamAllowlist']) ?? null;
	config.trustForwardedHost = !!scope.options.get(['trustForwardedHost']);

	if (!config.upstream && !config.upstreamAllowlist?.length && !config.trustForwardedHost) {
		throw new Error(
			"rp-cache: no upstream configured. Set 'upstream', 'upstreamAllowlist', or 'trustForwardedHost' in the plugin config."
		);
	}

	const hooksFile = scope.options.get(['hooksFile']);

	const defaults = {
		isCacheableRequest: (req) => req.method === 'GET',
		isCacheableResponse: (res) => res.statusCode === 200,
		buildCacheKey: (req) => resolveUpstreamUrl(req),
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
