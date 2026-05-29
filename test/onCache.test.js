import test from 'node:test';
import assert from 'node:assert/strict';

import { hooks, HOOK_NAMES } from '../src/hooks.js';

// HttpObjectSource.get's orchestration around the `onCache` hook — mirrored
// here in isolation because the real method depends on Harper globals
// (`Resource`, `createBlob`) that don't exist under `node --test`.
//
// Contract under test:
//   * the hook is invoked with (request, response, { cacheKey, tags })
//   * `response` is { statusCode, headers, content }
//   * the hook is fire-and-forget — thrown errors never propagate to the caller
//   * the hook does NOT fire when context.noCacheStore is true
//     (pass-through / non-cacheable responses)
const runMissOrchestration = async ({ hook, request, cacheKey, tags = null, response, noCacheStore = false }) => {
	const hookErrors = [];
	const hookCalls = [];
	const wrap = (...args) => {
		hookCalls.push(args);
		return hook(...args);
	};

	if (!noCacheStore) {
		Promise.resolve()
			.then(() => wrap(request, response, { cacheKey, tags }))
			.catch((err) => hookErrors.push(err));
	}

	// Drain microtasks + one I/O tick so the hook's fire-and-forget settles.
	await new Promise((r) => setImmediate(r));

	return { hookErrors, hookCalls };
};

test('default onCache hook is a no-op `() => null`', () => {
	assert.equal(typeof hooks.onCache, 'function');
	assert.equal(hooks.onCache({}, { statusCode: 200, headers: {}, content: null }, { cacheKey: 'k', tags: null }), null);
});

test('onCache is listed in HOOK_NAMES', () => {
	assert.ok(HOOK_NAMES.includes('onCache'));
});

test('hook receives (request, response, { cacheKey, tags })', async () => {
	let seen;
	const { hookCalls } = await runMissOrchestration({
		hook: (req, res, ctx) => {
			seen = { req, res, ctx };
		},
		request: { url: '/x', headers: new Headers() },
		response: { statusCode: 200, headers: { 'content-type': 'text/html' }, content: 'BODY' },
		cacheKey: 'k1',
		tags: ['example.com'],
	});

	assert.equal(hookCalls.length, 1);
	assert.equal(seen.req.url, '/x');
	assert.equal(seen.res.statusCode, 200);
	assert.equal(seen.res.headers['content-type'], 'text/html');
	assert.equal(seen.res.content, 'BODY');
	assert.equal(seen.ctx.cacheKey, 'k1');
	assert.deepEqual(seen.ctx.tags, ['example.com']);
});

test('hook errors are caught — never reach the primary path', async () => {
	const { hookErrors } = await runMissOrchestration({
		hook: () => {
			throw new Error('hook blew up');
		},
		request: { headers: new Headers() },
		response: { statusCode: 200, headers: {}, content: null },
		cacheKey: 'k',
	});

	assert.equal(hookErrors.length, 1);
	assert.match(hookErrors[0].message, /hook blew up/);
});

test('hook async errors are caught', async () => {
	const { hookErrors } = await runMissOrchestration({
		hook: async () => {
			throw new Error('async blew up');
		},
		request: { headers: new Headers() },
		response: { statusCode: 200, headers: {}, content: null },
		cacheKey: 'k',
	});

	assert.equal(hookErrors.length, 1);
	assert.match(hookErrors[0].message, /async blew up/);
});

test('hook does NOT fire when context.noCacheStore is true (non-cacheable response)', async () => {
	const { hookCalls } = await runMissOrchestration({
		hook: () => null,
		request: { headers: new Headers() },
		response: { statusCode: 200, headers: {}, content: null },
		cacheKey: 'k',
		noCacheStore: true,
	});

	assert.equal(hookCalls.length, 0);
});

test('tags context value is whatever the source computed (array or null)', async () => {
	let nullSeen;
	await runMissOrchestration({
		hook: (_req, _res, ctx) => {
			nullSeen = ctx.tags;
		},
		request: { headers: new Headers() },
		response: { statusCode: 200, headers: {}, content: null },
		cacheKey: 'k',
		tags: null,
	});
	assert.equal(nullSeen, null);
});
