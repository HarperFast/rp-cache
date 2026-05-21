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
};

export const HOOK_NAMES = Object.freeze(['isCacheableRequest', 'isCacheableResponse', 'buildCacheKey']);
