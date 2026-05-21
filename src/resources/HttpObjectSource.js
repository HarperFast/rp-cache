import { requestUpstream } from '../util/upstream.js';
import { hooks, config } from '../hooks.js';

const VIA_PROTOCOL = '1.1';

const appendUpstreamVia = (headers) => {
	const entry = `${VIA_PROTOCOL} ${config.viaIdentifier}`;
	const existing = headers.get('via');
	headers.set('via', existing ? `${existing}, ${entry}` : entry);
};

const headerParsers = {
	'accept-encoding': (value) => {
		if (!value) {
			return [];
		}

		return value.split(',').map((e) => {
			const end = e.indexOf(';');

			if (end !== -1) {
				e = e.substring(0, end);
			}

			return e.trim();
		});
	},
	'cache-control': (value) => {
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
						let [name, value] = component.trim().split('=');
						name = name.trim();
						if (value) value = value.trim();
						parsed = {
							name: name.toLowerCase(),
							value,
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
	},
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

const hopByHopHeaders = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
];

const upstreamRequestHeaderBlackList = [
	'cookie',
	'x-forwarded-host',
	'authorization',
	'if-none-match',
	'if-modified-since',
	'host',
	'accept-encoding',
];

const ignoredDownstreamReqHeaders = new Set([...hopByHopHeaders, ...upstreamRequestHeaderBlackList]);

const resolveUpstreamRequestConfig = (cacheKey, context) => {
	const { requestContext: request } = context;
	const [url] = cacheKey.split('|');

	const headers = new Headers();

	request.headers.forEach((value, key) => {
		if (ignoredDownstreamReqHeaders.has(key)) return;

		headers.set(key, value);
	});

	headers.set('accept-encoding', 'gzip, br');
	appendUpstreamVia(headers);

	if (context.replacingRecord) {
		const etag = ensureJsonHeaders(context.replacingRecord.headers)['etag'];
		if (etag) {
			headers.set('If-None-Match', etag);
		}
		if (context.replacingRecord.lastCached) {
			headers.set('If-Modified-Since', new Date(context.replacingRecord.lastCached).toUTCString());
		}
	}

	return {
		url,
		method: 'GET',
		headers,
	};
};

const resolveCachedHeaders = (upstreamResponseHeaders) => {
	let headersString = '';

	for (const [key, value] of Object.entries(upstreamResponseHeaders)) {
		if (hopByHopHeaders.includes(key.toLowerCase())) {
			continue;
		}
		if (key === 'set-cookie') continue;
		headersString = `${headersString}${headersString ? '\n' : ''}${key}: ${value}`;
	}

	return headersString;
};

export class HttpObjectSource extends Resource {
	static async get(cacheKey, context) {
		context.cacheStatus = 'MISS';

		const upstreamReqConfig = resolveUpstreamRequestConfig(cacheKey, context);
		const upstreamRes = await requestUpstream(upstreamReqConfig);

		if (!hooks.isCacheableResponse(upstreamRes, context)) {
			context.noCacheStore = true;
		}

		{
			headerParsers['cache-control'](upstreamRes.headers['cache-control']).forEach((part) => {
				if (part.name === 'no-store') context.noCacheStore = true;
				if (part.name === 'no-cache') context.noCache = true;
				if (part.name === 'max-age') context.expiresAt = Number(part.value) * 1000 + Date.now();
			});
		}

		if (upstreamRes.statusCode === 304 && context.replacingRecord) {
			context.cacheStatus = 'REVALIDATED';
			return context.replacingRecord;
		}

		return {
			cacheKey,
			statusCode: upstreamRes.statusCode,
			headers: resolveCachedHeaders(upstreamRes.headers),
			content: await createBlob(upstreamRes.body),
			lastCached: Date.now(),
		};
	}
}
