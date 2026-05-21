const allowed304Headers = ['cache-control', 'expires', 'date', 'etag', 'last-modified', 'vary', 'age'];

export class HttpObject extends databases.cache.HttpResourceCache {
	allowStaleWhileRevalidate(entry) {
		const until = entry?.value?.staleWhileRevalidateUntil;
		if (!until) return false;
		return new Date(until).valueOf() > Date.now();
	}

	async get(cacheKey) {
		const context = this.getContext();

		let statusCode = this.statusCode;
		let content = this.content;
		let headers = new Headers();

		this.headers.split('\n').forEach((line) => {
			const [key, value] = line.split(': ');
			headers.set(key, value);
		});

		// set age header
		{
			const ageSec = Math.max(0, Math.floor((Date.now() - this.lastCached.valueOf()) / 1000));
			headers.set('age', String(ageSec));
		}

		// handle 304
		{
			let return304 = false;
			// handle etag
			{
				const etag = context.headers.get('if-none-match');
				if (etag && etag === headers.get('etag')) {
					return304 = true;
				}
			}

			// handle last-modified
			{
				const ifModifiedSince = context.headers.get('if-modified-since');
				const lastModified = headers.get('last-modified');
				if (ifModifiedSince && lastModified) {
					const ifModifiedSinceTime = new Date(ifModifiedSince).getTime();
					const lastModifiedTime = new Date(lastModified).getTime();
					if (!isNaN(ifModifiedSinceTime) && !isNaN(lastModifiedTime)) {
						if (lastModifiedTime <= ifModifiedSinceTime) {
							return304 = true;
						}
					}
				}
			}

			if (return304) {
				// return 304 with only allowed headers
				const headers304 = new Headers();
				for (const headerName of allowed304Headers) {
					const headerValue = headers.get(headerName);
					if (headerValue !== null) {
						headers304.set(headerName, headerValue);
					}
				}

				statusCode = 304;
				headers = headers304;
				content = undefined;
			}
		}

		{
			// if (this.content) {
			//     const acceptedEncodings = headerParsers['accept-encoding'](request.headers.get('accept-encoding'));
			//     const contentEncoding = resHeaders.get('content-encoding');
			//     const bestEncoding = getBestEncoding(getAcceptedEncodings(request.headers.get('accept-encoding')), contentEncoding);
			//     if (bestEncoding !== contentEncoding) {
			//         if (bestEncoding) {
			//             resHeaders.set('content-encoding', bestEncoding);
			//         }
			//         if (body instanceof Blob) {
			//             body = Readable.fromWeb(body.stream());
			//         }
			//         body = reencode(body, contentEncoding, bestEncoding, false);
			//         resHeaders.delete('content-length');
			//     }
			// }
		}

		return {
			cacheKey,
			statusCode,
			headers,
			content,
			cacheStatus: context.cacheStatus ?? 'HIT',
		};
	}
}
