import test from 'node:test';
import assert from 'node:assert/strict';

// Reproduce the helper's behavior in isolation. The real helper in plugin.js
// closes over `databases.cache.HttpResourceCache.get`, which only exists inside
// a running Harper component — so we don't import plugin.js directly. Instead
// we mirror the catch-and-fall-through contract here and verify that contract
// against Harper's actual `Entry is not cached` error.

const makeHelper = (storeGet) => async (cacheKey) => {
	try {
		return await storeGet(cacheKey, { onlyIfCached: true });
	} catch (err) {
		if (err?.message === 'Entry is not cached') return undefined;
		throw err;
	}
};

test('returns the entry when the cache has one', async () => {
	const entry = { cacheKey: 'k', statusCode: 200 };
	const get = makeHelper(async () => entry);
	assert.equal(await get('k'), entry);
});

test('returns undefined when Harper throws "Entry is not cached" (cold key)', async () => {
	const get = makeHelper(async () => {
		const err = new Error('Entry is not cached');
		err.statusCode = 504;
		throw err;
	});
	assert.equal(await get('k'), undefined);
});

test('re-throws other errors (does not swallow real failures)', async () => {
	const get = makeHelper(async () => {
		const err = new Error('Connection reset');
		err.statusCode = 502;
		throw err;
	});
	await assert.rejects(() => get('k'), { message: 'Connection reset', statusCode: 502 });
});

test('re-throws 504s whose message is NOT exactly "Entry is not cached"', async () => {
	const get = makeHelper(async () => {
		const err = new Error('Gateway Timeout');
		err.statusCode = 504;
		throw err;
	});
	await assert.rejects(() => get('k'), { statusCode: 504 });
});
