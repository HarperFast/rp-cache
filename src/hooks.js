export const hooks = {
	isCacheableRequest: () => false,
	isCacheableResponse: () => false,
	buildCacheKey: () => '',
	resolveFormat: () => null,
};

export const config = {
	upstreamHostHeader: 'x-forwarded-host',
	cacheStatusHeader: 'X-Cache',
	viaIdentifier: 'rp-cache',
	upstream: null,
	upstreamAllowlist: null,
	trustForwardedHost: false,
	varyHeaders: [],
	upstreamHeadersTimeoutMs: 5000,
	upstreamBodyTimeoutMs: 30000,
	upstreamRetries: 2,
	upstreamRetryBaseDelayMs: 100,
	maxBodyBytes: null,
	tagHeader: 'surrogate-key',
	invalidatePath: '/.rp-cache/invalidate',
	statsPath: '/.rp-cache/stats',
	formatMap: null,
};

export const HOOK_NAMES = Object.freeze([
	'isCacheableRequest',
	'isCacheableResponse',
	'buildCacheKey',
	'resolveFormat',
]);
