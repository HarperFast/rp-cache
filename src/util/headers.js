// Normalize persisted/runtime headers into a plain `{ name: value }` object.
//
// The cached record persists headers via `cleanResponseHeadersAsString` as
// `"Name: Value\nName: Value"` (NOT JSON), so we parse that format directly.
// JSON.parse'ing the stored string previously threw
// `Unexpected token 'c', "content-ty"... is not valid JSON` during revalidation,
// when `replacingRecord.headers` is read via `buildConditionalsFromRecord`.
export const ensureJsonHeaders = (headers) => {
	if (!headers) {
		return {};
	}

	if (typeof headers === 'string') {
		const result = {};
		for (const line of headers.split('\n')) {
			if (!line) continue;
			const separator = line.indexOf(': ');
			if (separator === -1) continue;
			result[line.slice(0, separator).toLowerCase()] = line.slice(separator + 2);
		}
		return result;
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
