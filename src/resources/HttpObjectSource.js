import { requestUpstream } from '../util/upstream.js';
import { buildUpstreamRequest, cleanResponseHeadersAsString } from '../util/proxyHeaders.js';
import { ensureJsonHeaders } from '../util/headers.js';
import { hooks, config } from '../hooks.js';

const checkVaryCompatibility = (upstreamRes, context) => {
	const varyHeader = upstreamRes.headers['vary'];
	if (!varyHeader) return;
	if (varyHeader.trim() === '*') {
		context.noCacheStore = true;
		return;
	}
	const required = varyHeader.split(',').map((s) => s.trim().toLowerCase());
	const allowed = new Set((config.varyHeaders ?? []).map((s) => s.toLowerCase()));
	for (const name of required) {
		if (!name) continue;
		if (!allowed.has(name)) {
			context.noCacheStore = true;
			return;
		}
	}
};

const parseCacheControl = (value) => {
	if (!value) return [];
	return value
		.trim()
		.split(',')
		.map((part) => {
			let parsed;
			const components = part.trim().split(';');
			let component;
			while ((component = components.pop())) {
				if (component.includes('=')) {
					let [name, partValue] = component.trim().split('=');
					name = name.trim();
					if (partValue) partValue = partValue.trim();
					parsed = {
						name: name.toLowerCase(),
						value: partValue,
						next: parsed,
					};
				} else {
					parsed = {
						name: component.toLowerCase(),
						next: parsed,
					};
				}
			}
			return parsed;
		});
};

const buildConditionalsFromRecord = (replacingRecord) => {
	if (!replacingRecord) return {};
	const conditionals = {};
	const etag = ensureJsonHeaders(replacingRecord.headers)['etag'];
	if (etag) conditionals.etag = etag;
	if (replacingRecord.lastCached) {
		conditionals.lastModified = new Date(replacingRecord.lastCached).toUTCString();
	}
	return conditionals;
};

const applyFreshnessFromResponse = (upstreamRes, context) => {
	const cacheControl = upstreamRes.headers['cache-control'];
	let sMaxAge;
	let maxAge;

	if (cacheControl) {
		parseCacheControl(cacheControl).forEach((part) => {
			switch (part.name) {
				case 'no-store':
				case 'private':
					context.noCacheStore = true;
					break;
				case 'no-cache':
					context.noCache = true;
					break;
				case 'max-age': {
					const parsed = Number(part.value);
					if (!Number.isNaN(parsed)) maxAge = parsed;
					break;
				}
				case 's-maxage': {
					const parsed = Number(part.value);
					if (!Number.isNaN(parsed)) sMaxAge = parsed;
					break;
				}
				case 'stale-while-revalidate': {
					const parsed = Number(part.value);
					if (!Number.isNaN(parsed)) context.staleWhileRevalidateSeconds = parsed;
					break;
				}
				case 'stale-if-error': {
					const parsed = Number(part.value);
					if (!Number.isNaN(parsed)) context.staleIfErrorSeconds = parsed;
					break;
				}
			}
		});
	} else if (upstreamRes.headers['pragma']) {
		if (String(upstreamRes.headers['pragma']).toLowerCase().includes('no-cache')) {
			context.noCache = true;
		}
	}

	if (typeof sMaxAge === 'number') {
		context.expiresAt = sMaxAge * 1000 + Date.now();
	} else if (typeof maxAge === 'number') {
		context.expiresAt = maxAge * 1000 + Date.now();
	} else if (upstreamRes.headers['expires']) {
		const expires = Date.parse(upstreamRes.headers['expires']);
		if (!Number.isNaN(expires)) context.expiresAt = expires;
	} else if (upstreamRes.headers['last-modified']) {
		// RFC 9111 §4.2.2: heuristic freshness lifetime of 10% of (now - Last-Modified).
		const lastMod = Date.parse(upstreamRes.headers['last-modified']);
		if (!Number.isNaN(lastMod)) {
			const now = Date.now();
			const heuristicLifetime = Math.max(0, (now - lastMod) * 0.1);
			if (heuristicLifetime > 0) context.expiresAt = now + heuristicLifetime;
		}
	}
};

export class HttpObjectSource extends Resource {
	static async get(cacheKey, context) {
		context.cacheStatus = 'MISS';

		const [url] = cacheKey.split('|');
		const conditionals = buildConditionalsFromRecord(context.replacingRecord);
		const upstreamReqConfig = buildUpstreamRequest(url, context.requestContext, conditionals);
		const upstreamRes = await requestUpstream(upstreamReqConfig);

		if (!hooks.isCacheableResponse(upstreamRes, context)) {
			context.noCacheStore = true;
		}

		applyFreshnessFromResponse(upstreamRes, context);
		checkVaryCompatibility(upstreamRes, context);

		const freshnessOverride = hooks.freshnessLifetime(upstreamRes, context.requestContext);
		if (typeof freshnessOverride === 'number' && Number.isFinite(freshnessOverride)) {
			context.expiresAt = Date.now() + freshnessOverride * 1000;
		}

		if (upstreamRes.statusCode === 304 && context.replacingRecord) {
			context.cacheStatus = 'REVALIDATED';
			return context.replacingRecord;
		}

		const now = Date.now();
		const expiresAt = context.expiresAt ?? null;
		const swrSec = context.staleWhileRevalidateSeconds;
		const sieSec = context.staleIfErrorSeconds;

		const tagsFromHook = hooks.tagsForResponse(upstreamRes, context.requestContext);
		let tags;
		if (Array.isArray(tagsFromHook)) {
			tags = tagsFromHook;
		} else {
			const tagsHeader = upstreamRes.headers[config.tagHeader.toLowerCase()];
			tags = tagsHeader ? String(tagsHeader).split(/\s+/).filter(Boolean) : null;
		}

		const content = await createBlob(upstreamRes.body);

		// Fire-and-forget `onCache` hook. Runs only when the response is actually
		// being persisted (i.e. context.noCacheStore is false); pass-through
		// (no-store / non-cacheable) responses don't qualify as a "cached" event.
		// Consumers see the upstream's plain-object headers and the blob that
		// rp-cache is about to store. Errors caught and logged; never affect the
		// primary response.
		if (!context.noCacheStore) {
			Promise.resolve()
				.then(() =>
					hooks.onCache(
						context.requestContext,
						{ statusCode: upstreamRes.statusCode, headers: upstreamRes.headers, content },
						{ cacheKey, tags }
					)
				)
				.catch((err) => {
					// HttpObjectSource has no scope.logger; console is the fallback.
					console.warn?.(`rp-cache onCache hook failed: ${err?.message ?? err}`);
				});
		}

		return {
			cacheKey,
			statusCode: upstreamRes.statusCode,
			headers: cleanResponseHeadersAsString(upstreamRes.headers),
			content,
			lastCached: now,
			staleWhileRevalidateUntil: typeof swrSec === 'number' && expiresAt ? new Date(expiresAt + swrSec * 1000) : null,
			staleIfErrorUntil: typeof sieSec === 'number' && expiresAt ? new Date(expiresAt + sieSec * 1000) : null,
			tags,
		};
	}
}
