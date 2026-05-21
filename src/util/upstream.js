import { Agent } from 'undici';
import { config } from '../hooks.js';

const agent = new Agent();

const inflight = new Map();

const RETRYABLE_CODES = new Set([
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_SOCKET',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
]);

const isRetryableError = (err) => {
	if (!err) return false;
	const code = err.code ?? err.cause?.code;
	return RETRYABLE_CODES.has(code);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const fetchOnce = async (request) => {
	const url = new URL(request.url);
	const response = await agent.request({
		origin: url.origin,
		path: url.pathname + url.search,
		method: request.method,
		headers: request.headers,
		headersTimeout: config.upstreamHeadersTimeoutMs,
		bodyTimeout: config.upstreamBodyTimeoutMs,
	});
	const body = Buffer.from(await response.body.arrayBuffer());
	return {
		statusCode: response.statusCode,
		headers: response.headers,
		body,
	};
};

const fetchWithRetry = async (request) => {
	const maxAttempts = (config.upstreamRetries ?? 0) + 1;
	const baseDelay = config.upstreamRetryBaseDelayMs ?? 100;
	let lastErr;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fetchOnce(request);
		} catch (err) {
			lastErr = err;
			if (attempt === maxAttempts - 1 || !isRetryableError(err)) throw err;
			await sleep(baseDelay * 2 ** attempt);
		}
	}
	throw lastErr;
};

export const requestUpstream = (request) => {
	const key = buildKey(request);
	let promise = inflight.get(key);
	if (!promise) {
		promise = fetchWithRetry(request).finally(() => {
			inflight.delete(key);
		});
		inflight.set(key, promise);
	}
	return promise;
};
