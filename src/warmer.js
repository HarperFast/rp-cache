import { hooks, config } from './hooks.js';
import { HttpObject } from './resources/HttpObject.js';

const LOC_REGEX = /<loc>\s*([^<]+?)\s*<\/loc>/g;

const fetchSitemapUrls = async (sitemapUrl) => {
	const response = await fetch(sitemapUrl);
	if (!response.ok) {
		throw new Error(`Sitemap fetch failed: ${response.status} ${response.statusText}`);
	}
	const xml = await response.text();
	const urls = [];
	let match;
	while ((match = LOC_REGEX.exec(xml)) !== null) {
		urls.push(match[1]);
	}
	return urls;
};

const acceptHeaderFor = (formatLabel) => {
	if (!formatLabel || !config.formatMap) return '*/*';
	for (const [mediaType, label] of Object.entries(config.formatMap)) {
		if (label === formatLabel) return mediaType;
	}
	return '*/*';
};

const synthesizeRequest = (urlString, formatLabel) => {
	const parsed = new URL(urlString);
	const headers = new Headers({
		[config.upstreamHostHeader]: parsed.host,
		accept: acceptHeaderFor(formatLabel),
	});
	return {
		method: 'GET',
		url: parsed.pathname + parsed.search,
		headers,
	};
};

const warmOne = async (logger, urlString, formatLabel) => {
	try {
		const req = synthesizeRequest(urlString, formatLabel);
		const cacheKey = hooks.buildCacheKey(req);
		await HttpObject.get(cacheKey, req);
	} catch (err) {
		logger.warn?.(`Warm failed for ${urlString}${formatLabel ? ` (${formatLabel})` : ''}: ${err?.message ?? err}`);
	}
};

const runWarmCycle = async (logger) => {
	if (!config.sitemapUrl) return;
	try {
		const urls = await fetchSitemapUrls(config.sitemapUrl);
		const formats = config.sitemapWarmFormats?.length ? config.sitemapWarmFormats : [null];
		logger.info?.(`rp-cache warming ${urls.length} URLs across ${formats.length} format(s) from sitemap`);
		for (const url of urls) {
			for (const formatLabel of formats) {
				await warmOne(logger, url, formatLabel);
			}
		}
		logger.info?.(`rp-cache warm cycle complete`);
	} catch (err) {
		logger.error?.(`rp-cache sitemap warm cycle failed: ${err?.message ?? err}`);
	}
};

let warmTimer;

export const startWarmer = (logger) => {
	stopWarmer();
	if (!config.sitemapUrl) return;
	if (config.sitemapWarmAtStartup) {
		runWarmCycle(logger).catch(() => {});
	}
	const intervalMs = Number(config.sitemapWarmIntervalMs);
	if (Number.isFinite(intervalMs) && intervalMs > 0) {
		warmTimer = setInterval(() => {
			runWarmCycle(logger).catch(() => {});
		}, intervalMs);
		if (typeof warmTimer.unref === 'function') warmTimer.unref();
	}
};

export const stopWarmer = () => {
	if (warmTimer) {
		clearInterval(warmTimer);
		warmTimer = undefined;
	}
};
