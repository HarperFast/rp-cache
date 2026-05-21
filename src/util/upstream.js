import { Agent } from 'undici';

const agent = new Agent();

const inflight = new Map();

const headerValue = (headers, name) => {
	if (!headers) return '';
	if (headers instanceof Headers) return headers.get(name) ?? '';
	return headers[name] ?? '';
};

const buildKey = (request) =>
	[
		request.method,
		request.url,
		headerValue(request.headers, 'if-none-match'),
		headerValue(request.headers, 'if-modified-since'),
	].join('\x00');

const fetchAndBuffer = async (request) => {
	const url = new URL(request.url);
	const response = await agent.request({
		origin: url.origin,
		path: url.pathname + url.search,
		method: request.method,
		headers: request.headers,
	});
	const body = Buffer.from(await response.body.arrayBuffer());
	return {
		statusCode: response.statusCode,
		headers: response.headers,
		body,
	};
};

export const requestUpstream = (request) => {
	const key = buildKey(request);
	let promise = inflight.get(key);
	if (!promise) {
		promise = fetchAndBuffer(request).finally(() => {
			inflight.delete(key);
		});
		inflight.set(key, promise);
	}
	return promise;
};
