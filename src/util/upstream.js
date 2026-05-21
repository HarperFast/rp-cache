import { Agent } from 'undici';

const agent = new Agent();

export const requestUpstream = async (request) => {
	const url = new URL(request.url);
	const response = await agent.request({
		origin: url.origin,
		path: url.pathname + url.search,
		method: request.method,
		headers: request.headers,
	});
	return response;
};
