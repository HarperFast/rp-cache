import { HttpObjectSource } from './resources/HttpObjectSource.js';
import { HttpObject } from './resources/HttpObject.js';
import { hooks, HOOK_NAMES } from './hooks.js';

const DEFAULT_UPSTREAM_HOST_HEADER = 'x-forwarded-host';

export const handleApplication = async (scope) => {
	const upstreamHostHeader = scope.options.get(['upstreamHostHeader']) ?? DEFAULT_UPSTREAM_HOST_HEADER;
	const hooksFile = scope.options.get(['hooksFile']);

	const defaults = {
		isCacheableRequest: (req) => req.method === 'GET',
		isCacheableResponse: (res) => res.statusCode === 200,
		buildCacheKey: (req) => {
			const upstreamHost = req.headers.get(upstreamHostHeader);
			if (!upstreamHost) {
				const error = new Error('Invalid host');
				error.statusCode = 403;
				throw error;
			}
			return `https://${upstreamHost}${req.url}`;
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

		const cacheKey = hooks.buildCacheKey(req);
		const httpObject = await HttpObject.get(cacheKey, req);

		return {
			status: httpObject.statusCode,
			headers: httpObject.headers,
			body: httpObject.content,
		};
	});
};
