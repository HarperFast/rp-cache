export const hooks = {
	isCacheableRequest: () => false,
	isCacheableResponse: () => false,
	buildCacheKey: () => '',
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
};

export const HOOK_NAMES = Object.freeze(['isCacheableRequest', 'isCacheableResponse', 'buildCacheKey']);
