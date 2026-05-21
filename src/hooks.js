export const hooks = {
	isCacheableRequest: () => false,
	isCacheableResponse: () => false,
	buildCacheKey: () => '',
};

export const HOOK_NAMES = Object.freeze(['isCacheableRequest', 'isCacheableResponse', 'buildCacheKey']);
