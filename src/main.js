import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const queries = input.queries ?? [];
const preferredDomains = (input.retailerDomains ?? []).map((value) => value.toLowerCase());
const maxProductPages = input.maxProductPages ?? 600;

const ORIGIN = [
  /vyroben[oaé]\s+v\s+kanadě/i,
  /země\s+původu\s*:?\s*kanada/i,
  /původ\s*:?\s*kanada/i,
  /made\s+in\s+canada/i,
];
const FALSE_ORIGIN = /kanadsk(?:ý|á|é)\s+(?:styl|recept|inspir)|surovin(?:a|y)[^.!]{0,50}(?:kanada|canada)/i;
const STOCK = /(?:skladem|ihned\s+k\s+odběru|k\s+vyzvednutí)/i;
const PHYSICAL = /(?:skladem\s+na\s+prodejně|dostupn\S*\s+na\s+prodejně|kamenn\S*\s+prodejn\S*|osobní\s+odběr|vyzvednutí\s+na\s+prodejně)/i;
const POSTCODE = /\b\d{3}\s?\d{2}\b/;
const BLOCKED = /access denied|captcha|robot check|přístup odepřen|forbidden/i;

const clean = (value = '') => value.replace(/\s+/g, ' ').trim();
const firstMatch = (text, expressions) => expressions.find((expression) => expression.test(text));
const categoryOf = (text) => {
  if (/kosmetik|krém|balzám|šampon|péče o|beauty/i.test(text)) return 'beauty_personal_care';
  if (/bunda|kabát|mikina|tričko|oblečení|fashion|parka/i.test(text)) return 'fashion_outerwear';
  if (/outdoor|sport|batoh|stan|lezen|lyž|hokej/i.test(text)) return 'outdoor_sports';
  return 'food_grocery';
};
const allowedHost = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return preferredDomains.length ? preferredDomains.some((domain) => host.endsWith(domain)) : host.endsWith('.cz');
  } catch { return false; }
};
const searchTarget = (href) => {
  try {
    const url = new URL(href, 'https://www.bing.com');
    if (url.hostname.includes('bing.com') && url.searchParams.get('url')) return url.searchParams.get('url');
    return url.href;
  } catch { return null; }
};
const addressFrom = (text) => {
  const match = text.match(new RegExp(`.{0,90}${POSTCODE.source}.{0,70}`, 'i'));
  return match ? clean(match[0]) : null;
};
const geocode = async (address) => {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cz&q=${encodeURIComponent(address)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'CanadaNearMe-CZ/0.1' } });
  if (!response.ok) return null;
  const [item] = await response.json();
  return item ? { latitude: Number(item.lat), longitude: Number(item.lon) } : null;
};
const productSnapshot = ($, url) => {
  const text = clean($('body').text());
  if (BLOCKED.test(text) || FALSE_ORIGIN.test(text)) return null;
  const origin = firstMatch(text, ORIGIN);
  if (!origin || !STOCK.test(text) || !PHYSICAL.test(text)) return null;
  const title = clean($('h1').first().text()) || $('meta[property="og:title"]').attr('content') || clean($('title').text());
  const price = $('[itemprop="price"]').attr('content') || $('meta[property="product:price:amount"]').attr('content') || null;
  return { url, title, text, price, origin_claim: origin.source };
};

const requests = queries.map((query) => ({
  url: `https://www.bing.com/search?setlang=cs-CZ&count=50&q=${encodeURIComponent(`${query} site:.cz`)}`,
  userData: { label: 'SEARCH' },
}));
for (const item of input.startUrls ?? []) {
  const url = typeof item === 'string' ? item : item.url;
  if (url) requests.push({ url, userData: { label: 'PRODUCT' } });
}

const crawler = new CheerioCrawler({
  maxRequestsPerCrawl: maxProductPages + requests.length * 2,
  maxConcurrency: 10,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 25,
  async requestHandler({ request, $, requestQueue }) {
    const label = request.userData.label;
    if (label === 'SEARCH') {
      const links = $('li.b_algo h2 a, a').map((_, element) => searchTarget($(element).attr('href'))).get();
      for (const url of [...new Set(links)].filter(Boolean).filter(allowedHost).slice(0, maxProductPages)) {
        await requestQueue.addRequest({ url, userData: { label: 'PRODUCT' } });
      }
      return;
    }

    if (label === 'STORE') {
      const candidate = request.userData.candidate;
      const storeText = clean($('body').text());
      const address = addressFrom(storeText);
      if (!address || !PHYSICAL.test(storeText)) return;
      const coordinates = await geocode(address).catch(() => null);
      if (!coordinates) return;
      await Actor.pushData({ ...candidate, branch_address: address, ...coordinates, branch_evidence_url: request.url });
      return;
    }

    const candidate = productSnapshot($, request.url);
    if (!candidate) return;
    const directAddress = addressFrom(candidate.text);
    if (directAddress) {
      const coordinates = await geocode(directAddress).catch(() => null);
      if (coordinates) {
        await Actor.pushData({
          candidate_id: `CZ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: candidate.title,
          merchant: new URL(request.url).hostname,
          category_id: categoryOf(candidate.text),
          decision: 'PUBLIC_ELIGIBLE',
          public_eligible: true,
          origin_status: 'VERIFIED_MADE_IN_CANADA_CLAIM',
          availability_status: 'IN_STOCK_AT_PHYSICAL_STORE',
          product_url: request.url,
          branch_evidence_url: request.url,
          branch_address: directAddress,
          price_observed: candidate.price,
          checked_at: new Date().toISOString(),
          ...coordinates,
        });
      }
      return;
    }

    const base = {
      candidate_id: `CZ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: candidate.title,
      merchant: new URL(request.url).hostname,
      category_id: categoryOf(candidate.text),
      decision: 'PUBLIC_ELIGIBLE',
      public_eligible: true,
      origin_status: 'VERIFIED_MADE_IN_CANADA_CLAIM',
      availability_status: 'IN_STOCK_AT_PHYSICAL_STORE',
      product_url: request.url,
      price_observed: candidate.price,
      checked_at: new Date().toISOString(),
    };
    const storeLinks = $('a').filter((_, element) => /prodejn|kontakt|osobní odběr/i.test($(element).text())).map((_, element) => $(element).attr('href')).get();
    for (const href of [...new Set(storeLinks)].slice(0, 3)) {
      try {
        const url = new URL(href, request.url).href;
        if (new URL(url).hostname === new URL(request.url).hostname) {
          await requestQueue.addRequest({ url, userData: { label: 'STORE', candidate: base } });
        }
      } catch {}
    }
  },
  failedRequestHandler({ request }) {
    log.debug(`Skipped inaccessible page: ${request.url}`);
  },
});

await crawler.run(requests);
await Actor.exit();
