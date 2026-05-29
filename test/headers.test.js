import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureJsonHeaders } from '../src/util/headers.js';

test('ensureJsonHeaders: empty / nullish input -> {}', () => {
	assert.deepEqual(ensureJsonHeaders(null), {});
	assert.deepEqual(ensureJsonHeaders(undefined), {});
	assert.deepEqual(ensureJsonHeaders(''), {});
});

test('ensureJsonHeaders: parses the persisted line-delimited format', () => {
	// Shape produced by cleanResponseHeadersAsString and stored in HttpResourceCache.
	const persisted = 'content-type: text/markdown\ncontent-length: 1234\netag: "abc"';

	assert.deepEqual(ensureJsonHeaders(persisted), {
		'content-type': 'text/markdown',
		'content-length': '1234',
		'etag': '"abc"',
	});
});

test('ensureJsonHeaders: line-delimited input does NOT throw on JSON.parse (regression)', () => {
	// Previously this branch ran `JSON.parse(headers)` and threw
	// `Unexpected token 'c', "content-ty"... is not valid JSON` during
	// revalidation in buildConditionalsFromRecord.
	assert.doesNotThrow(() => ensureJsonHeaders('content-type: text/markdown'));
});

test('ensureJsonHeaders: tolerates blank lines and missing separators', () => {
	const persisted = 'content-type: text/markdown\n\nbogus-line\netag: "v1"';

	assert.deepEqual(ensureJsonHeaders(persisted), {
		'content-type': 'text/markdown',
		'etag': '"v1"',
	});
});

test('ensureJsonHeaders: passes plain objects through unchanged', () => {
	const input = { 'content-type': 'text/markdown', 'etag': '"x"' };

	assert.equal(ensureJsonHeaders(input), input);
});

test('ensureJsonHeaders: converts a Headers instance to a lower-cased object', () => {
	const headers = new Headers({ 'Content-Type': 'text/markdown', 'ETag': '"x"' });

	const result = ensureJsonHeaders(headers);

	assert.equal(result['content-type'], 'text/markdown');
	assert.equal(result['etag'], '"x"');
});
