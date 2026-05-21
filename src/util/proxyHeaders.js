import { config } from '../hooks.js';

export const HOP_BY_HOP_HEADERS = [
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

const UPSTREAM_REQUEST_HEADER_BLACKLIST = [
	'cookie',
	'x-forwarded-host',
	'authorization',
	'if-none-match',
	'if-modified-since',
	'host',
	'accept-encoding',
];

const IGNORED_DOWNSTREAM_REQ_HEADERS = new Set([...HOP_BY_HOP_HEADERS, ...UPSTREAM_REQUEST_HEADER_BLACKLIST]);

const VIA_PROTOCOL = '1.1';

export const appendVia = (headers) => {
	const entry = `${VIA_PROTOCOL} ${config.viaIdentifier}`;
	const existing = headers.get('via');
	headers.set('via', existing ? `${existing}, ${entry}` : entry);
};

export const buildUpstreamRequest = (url, request, conditionals = {}) => {
	const headers = new Headers();
	request.headers.forEach((value, key) => {
		if (IGNORED_DOWNSTREAM_REQ_HEADERS.has(key)) return;
		headers.set(key, value);
	});
	headers.set('accept-encoding', 'gzip, br');
	appendVia(headers);
	if (conditionals.etag) headers.set('If-None-Match', conditionals.etag);
	if (conditionals.lastModified) headers.set('If-Modified-Since', conditionals.lastModified);
	return { url, method: 'GET', headers };
};

export const cleanResponseHeaders = (upstreamResponseHeaders) => {
	const headers = new Headers();
	for (const [key, value] of Object.entries(upstreamResponseHeaders)) {
		if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) continue;
		if (key === 'set-cookie') continue;
		headers.set(key, value);
	}
	return headers;
};

export const cleanResponseHeadersAsString = (upstreamResponseHeaders) => {
	let headersString = '';
	for (const [key, value] of Object.entries(upstreamResponseHeaders)) {
		if (HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) continue;
		if (key === 'set-cookie') continue;
		headersString = `${headersString}${headersString ? '\n' : ''}${key}: ${value}`;
	}
	return headersString;
};
