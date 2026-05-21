import { requestUpstream } from '../util/upstream.js';
import { buildUpstreamRequest, cleanResponseHeadersAsString } from '../util/proxyHeaders.js';
import { hooks } from '../hooks.js';

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

const ensureJsonHeaders = (headers) => {
	if (!headers) {
		return {};
	}

	if (typeof headers === 'string') {
		return JSON.parse(headers);
	}
	if (headers instanceof Headers) {
		const result = {};
		for (const [key, value] of headers.entries()) {
			result[key] = value;
		}
		return result;
	}

	return headers;
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

		if (upstreamRes.statusCode === 304 && context.replacingRecord) {
			context.cacheStatus = 'REVALIDATED';
			return context.replacingRecord;
		}

		return {
			cacheKey,
			statusCode: upstreamRes.statusCode,
			headers: cleanResponseHeadersAsString(upstreamRes.headers),
			content: await createBlob(upstreamRes.body),
			lastCached: Date.now(),
		};
	}
}
