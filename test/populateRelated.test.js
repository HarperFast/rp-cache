import test from 'node:test';
import assert from 'node:assert/strict';

import { hooks, HOOK_NAMES } from '../src/hooks.js';

// HttpObjectSource.get's orchestration around the populateRelated hook —
// mirrored here in isolation because the real function depends on Harper
// globals (`Resource`, `createBlob`) that don't exist under `node --test`.
//
// Contract under test:
//   * the hook is invoked with (request, { cacheKey, primaryResponse })
//   * primaryResponse is a Promise that resolves with { statusCode, headers,
//     content } once the (mocked) upstream fetch finishes
//   * the hook runs in parallel with the upstream fetch (it must observe a
//     pre-fetch tick before primaryResponse resolves)
//   * hook errors are caught and never propagate to the caller
//   * primaryResponse rejects when the upstream fetch throws
const runMissOrchestration = ({ hook, requestContext, cacheKey, fetchUpstream }) => {
	let resolvePrimary;
	let rejectPrimary;
	const primaryResponse = new Promise((res, rej) => {
		resolvePrimary = res;
		rejectPrimary = rej;
	});
	primaryResponse.catch(() => {}); // match real code's unhandled-rejection guard
	const hookErrors = [];
	Promise.resolve()
		.then(() => hook(requestContext, { cacheKey, primaryResponse }))
		.catch((err) => hookErrors.push(err));

	const primary = (async () => {
		try {
			const response = await fetchUpstream();
			resolvePrimary(response);
			return response;
		} catch (err) {
			rejectPrimary(err);
			throw err;
		}
	})();

	return { primary, primaryResponse, hookErrors };
};

test('default populateRelated hook is a no-op `() => null`', () => {
	assert.equal(typeof hooks.populateRelated, 'function');
	assert.equal(hooks.populateRelated({}, { cacheKey: 'k', primaryResponse: Promise.resolve() }), null);
});

test('populateRelated is listed in HOOK_NAMES', () => {
	assert.ok(HOOK_NAMES.includes('populateRelated'));
});

test('hook receives (request, { cacheKey, primaryResponse })', async () => {
	let seen;
	const hook = (req, ctx) => {
		seen = { req, ctx };
	};

	const { primary } = runMissOrchestration({
		hook,
		requestContext: { url: '/x', headers: new Headers() },
		cacheKey: 'k1',
		fetchUpstream: async () => ({ statusCode: 200, headers: {}, content: null }),
	});

	await primary;
	// Yield to let the hook microtask observe `seen`.
	await new Promise((r) => setImmediate(r));

	assert.equal(seen.req.url, '/x');
	assert.equal(seen.ctx.cacheKey, 'k1');
	assert.ok(seen.ctx.primaryResponse && typeof seen.ctx.primaryResponse.then === 'function');
});

test('primaryResponse resolves with { statusCode, headers, content } on success', async () => {
	let observed;
	const hook = async (_req, { primaryResponse }) => {
		observed = await primaryResponse;
	};

	const { primary } = runMissOrchestration({
		hook,
		requestContext: { headers: new Headers() },
		cacheKey: 'k',
		fetchUpstream: async () => ({
			statusCode: 200,
			headers: { 'content-type': 'text/html' },
			content: 'BODY',
		}),
	});

	await primary;
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(observed, { statusCode: 200, headers: { 'content-type': 'text/html' }, content: 'BODY' });
});

test('hook fires in parallel with the upstream fetch (runs before primary resolves)', async () => {
	const events = [];
	const hook = async (_req, { primaryResponse }) => {
		events.push('hook-start');
		await primaryResponse;
		events.push('hook-after-primary');
	};

	const { primary } = runMissOrchestration({
		hook,
		requestContext: { headers: new Headers() },
		cacheKey: 'k',
		fetchUpstream: async () => {
			// One macrotask tick — gives the hook microtask room to run first.
			await new Promise((r) => setImmediate(r));
			events.push('upstream-done');
			return { statusCode: 200, headers: {}, content: null };
		},
	});

	await primary;
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(events, ['hook-start', 'upstream-done', 'hook-after-primary']);
});

test('hook errors are caught — do not affect the primary response', async () => {
	const hook = () => {
		throw new Error('hook blew up');
	};

	const { primary, hookErrors } = runMissOrchestration({
		hook,
		requestContext: { headers: new Headers() },
		cacheKey: 'k',
		fetchUpstream: async () => ({ statusCode: 200, headers: {}, content: null }),
	});

	const result = await primary;
	await new Promise((r) => setImmediate(r));

	assert.equal(result.statusCode, 200);
	assert.equal(hookErrors.length, 1);
	assert.match(hookErrors[0].message, /hook blew up/);
});

test('primaryResponse rejects when the upstream fetch throws', async () => {
	let hookSawReject;
	const hook = async (_req, { primaryResponse }) => {
		try {
			await primaryResponse;
		} catch (err) {
			hookSawReject = err;
		}
	};

	const { primary } = runMissOrchestration({
		hook,
		requestContext: { headers: new Headers() },
		cacheKey: 'k',
		fetchUpstream: async () => {
			throw new Error('network down');
		},
	});

	await assert.rejects(() => primary, { message: 'network down' });
	await new Promise((r) => setImmediate(r));

	assert.equal(hookSawReject?.message, 'network down');
});
