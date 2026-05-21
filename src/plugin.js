import { HttpObjectSource } from './resources/HttpObjectSource.js';
import { HttpObject } from './resources/HttpObject.js';

const DEFAULT_UPSTREAM_HOST_HEADER = 'x-forwarded-host';

const isCacheableRequest = (req) => req.method === 'GET';

export const handleApplication = async (scope) => {
	const upstreamHostHeader = scope.options.get(['upstreamHostHeader']) ?? DEFAULT_UPSTREAM_HOST_HEADER;

	databases.cache.HttpResourceCache.sourcedFrom(HttpObjectSource);

	const resolveUpstreamHost = (req) => {
		const upstreamHost = req.headers.get(upstreamHostHeader);
		if (!upstreamHost) {
			const error = new Error('Invalid host');
			error.statusCode = 403;
			throw error;
		}
		return upstreamHost;
	};

	const buildCacheKey = (req) => {
		const host = resolveUpstreamHost(req);
		return `https://${host}${req.url}`;
	};

	scope.server.http(async (req) => {
		if (!isCacheableRequest(req)) {
			const error = new Error('Method not allowed');
			error.statusCode = 405;
			throw error;
		}

		const cacheKey = buildCacheKey(req);
		const httpObject = await HttpObject.get(cacheKey, req);

		return {
			status: httpObject.statusCode,
			headers: httpObject.headers,
			body: httpObject.content,
		};
	});
};
