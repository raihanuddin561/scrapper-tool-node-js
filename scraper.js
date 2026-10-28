'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns/promises');
const net = require('node:net');

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}/g;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const DELIVERY_HOSTS = [
  'ubereats.com', 'doordash.com', 'menulog.com.au', 'deliveroo.com',
  'grubhub.com', 'opentable.com',
];
const ADDRESS_PATTERN = /\d+\s+[A-Za-z0-9\s.,'-]+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Way|Hwy|Pde|Parade|Pl|Place|Ct|Court|VIC|NSW|QLD|WA|SA|TAS|ACT|NT|Australia)\b.*/i;
const PHONE_PATTERN = /(\+\d{1,3}[\s-]?)?(\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}/;
const PLUS_CODE_PATTERN = /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b.*$/i;

function createLimit(concurrency) {
  const limit = Math.max(1, Math.min(5, Number(concurrency) || 4));
  let active = 0;
  const queue = [];
  const run = () => {
    if (!queue.length || active >= limit) return;
    const [task, resolve] = queue.shift();
    active += 1;
    Promise.resolve().then(task).then(
      value => resolve({ status: 'fulfilled', value }),
      reason => resolve({ status: 'rejected', reason })
    ).finally(() => { active -= 1; run(); });
  };
  return fn => new Promise((resolve) => { queue.push([fn, resolve]); run(); });
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] >= 224;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

async function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid website URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Website must be a public HTTP(S) URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(hostname)) addresses = [{ address: hostname }];
  else addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Local or private websites cannot be crawled');
  }
  return url;
}

function cleanWebsite(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    let url = new URL(raw.trim());
    if (url.hostname === 'www.google.com' || url.hostname.endsWith('.google.com')) {
      url = new URL(url.searchParams.get('q') || url.searchParams.get('url') || raw);
    }
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (DELIVERY_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return '';
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
}

function extractAddressFromRows(rows) {
  for (const row of rows || []) {
    const value = String(row || '').replace(/\s+/g, ' ').trim();
    const match = value.match(ADDRESS_PATTERN);
    if (match) return match[0].trim();
  }
  return '';
}

function extractPhoneFromRows(rows, address = '') {
  for (const row of rows || []) {
    const value = String(row || '').replace(/\s+/g, ' ').trim();
    if (!value || value.includes('$') || (address && normalizeText(value) === normalizeText(address)) ||
        ADDRESS_PATTERN.test(value)) continue;
    const match = value.match(PHONE_PATTERN);
    if (match && match[0].replace(/\D/g, '').length >= 8) return match[0].trim();
  }
  return '';
}

function extractPlusCodeFromRows(rows) {
  for (const row of rows || []) {
    const match = String(row || '').match(PLUS_CODE_PATTERN);
    if (match) return match[0].trim();
  }
  return '';
}

async function dismissConsent(page) {
  const labels = [
    'Accept all', 'I agree', 'Reject all', 'Accept',
  ];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label, exact: true }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getListingKey(listing) {
  const rawLink = String(listing?.link || '').trim();
  let linkKey = '';

  try {
    const url = new URL(rawLink);
    const placeMatch = url.pathname.match(/\/maps\/place\/([^/]+)/i);
    const placeIdMatch = rawLink.match(/(?:!1s|[?&](?:ftid|cid)=)([^!&?]+)/i);

    if (placeIdMatch) linkKey = `place-id:${placeIdMatch[1].toLowerCase()}`;
    else if (placeMatch) {
      const placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      linkKey = `place-name:${normalizeText(placeName)}`;
    }
  } catch {}

  const name = normalizeText(listing?.Name || listing?.name || listing?.text);
  const address = normalizeText(listing?.Address || listing?.address);
  const identity = address ? `${name}|${address}` : name;

  // A stable place ID or place-name URL is preferred. Address/name is used for
  // cards whose Maps URL does not expose a recognizable place identity.
  return linkKey || (identity ? `identity:${identity}` : `link:${normalizeText(rawLink)}`);
}

function deduplicateListings(listings) {
  const seen = new Set();
  return (listings || []).filter(listing => {
    const key = getListingKey(listing);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrapeGoogleMaps(query, limit, onProgress = () => {}) {
  const target = Math.max(1, Math.min(200, Number(limit) || 20));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-AU',
    timezoneId: 'Australia/Melbourne',
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();
  const listings = [];

  try {
    onProgress({ type: 'status', message: 'Opening Google Maps...' });
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissConsent(page);

    const feed = page.locator('[role="feed"]');
    await feed.waitFor({ state: 'visible', timeout: 30000 });

    let previousCount = 0;
    let stalled = 0;
    while (deduplicateListings(listings).length < target && stalled < 5) {
      const cards = await feed.locator(':scope > div').evaluateAll(nodes =>
        nodes.map(node => {
          const anchor = node.querySelector('a[href*="maps/place"]');
          return {
            text: node.textContent?.replace(/\s+/g, ' ').trim() || '',
            ariaLabel: anchor?.getAttribute('aria-label') || '',
            link: anchor?.href || '',
          };
        }).filter(item => item.link && item.text)
      );
      const seenLinks = new Set(listings.map(item => item.link));
      listings.push(...cards.filter(item => {
        if (seenLinks.has(item.link)) return false;
        seenLinks.add(item.link);
        return true;
      }));
      onProgress({ type: 'status', message: `Found ${Math.min(deduplicateListings(listings).length, target)} places on Maps...` });
      if (deduplicateListings(listings).length >= target) break;

      await feed.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.waitForTimeout(1000);
      const newCount = await feed.locator(':scope > div').evaluateAll(nodes => nodes.length);
      stalled = newCount <= previousCount ? stalled + 1 : 0;
      previousCount = newCount;
    }

    const result = [];
    const resultKeys = new Set();
    const uniqueListings = deduplicateListings(listings).slice(0, target);
    for (let index = 0; index < uniqueListings.length; index += 1) {
      const listing = uniqueListings[index];
      const link = listing.link;
      let expectedName = listing.ariaLabel || listing.text;
      try {
        const placeName = new URL(link).pathname.match(/\/maps\/place\/([^/]+)/i)?.[1];
        if (placeName) expectedName = decodeURIComponent(placeName.replace(/\+/g, ' '));
      } catch {}
      onProgress({ type: 'status', message: `Reading place ${index + 1}/${uniqueListings.length}...` });
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForFunction(expected => {
          const normalize = value => String(value || '').normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const target = normalize(expected);
          const headings = [...document.querySelectorAll('h1')]
            .map(node => normalize(node.textContent))
            .filter(text => text && !/^(results?|search results)$/.test(text));
          return headings.some(text => text === target || text.startsWith(`${target} `));
        }, expectedName, { timeout: 15000 });
      } catch (error) {
        onProgress({ type: 'warning', message: `Could not open a place: ${error.message}` });
        continue;
      }

      const data = await page.evaluate(({ fallbackName, fallbackAriaLabel }) => {
        const clean = value => value?.replace(/\s+/g, ' ').replace(/[\u{e000}-\u{f8ff}]/gu, '').trim() || '';
        const panel = document.querySelector('[role="main"]') || document.body;
        const firstText = selectors => {
          for (const selector of selectors) {
            const node = panel.querySelector(selector);
            const value = clean(node?.innerText || node?.textContent);
            if (value) return value;
          }
          return '';
        };
        const firstLabel = selectors => {
          for (const selector of selectors) {
            const value = clean(panel.querySelector(selector)?.getAttribute('aria-label'));
            if (value) return value;
          }
          return '';
        };
        const stripPrefix = (value, prefix) => clean(value).replace(new RegExp(`^${prefix}:?\\s*`, 'i'), '');
        const rows = [...panel.querySelectorAll('[data-item-id],button,[aria-label]')]
          .flatMap(node => [
            clean(node.innerText || node.textContent),
            clean(node.getAttribute('aria-label')),
          ])
          .filter(Boolean);

        const mainLabel = clean(panel.getAttribute('aria-label'));
        const title = firstText(['h1.DUwDvf', 'h1']) ||
          clean(fallbackAriaLabel) ||
          (/^(map|google maps|main content)$/i.test(mainLabel) ? '' : mainLabel) ||
          clean(fallbackName);
        const address = firstText(['[data-item-id="address"]']) ||
          stripPrefix(firstLabel(['button[data-item-id="address"]']), 'Address') ||
          stripPrefix(firstLabel(['[aria-label^="Address:"]']), 'Address') ||
          rows.find(row => /\d+\s+[A-Za-z0-9\s.,'-]+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Way|Hwy|Pde|Parade|Pl|Place|Ct|Court|VIC|NSW|QLD|WA|SA|TAS|ACT|NT|Australia)\b/i.test(row)) ||
          '';
        const phoneItem = panel.querySelector('[data-item-id^="phone:tel:"]');
        const phoneId = phoneItem?.getAttribute('data-item-id')?.replace(/^phone:tel:/i, '') || '';
        const contact = phoneId || firstText(['[data-item-id^="phone:tel:"]']) ||
          stripPrefix(firstLabel(['button[aria-label^="Phone:"]']), 'Phone') ||
          stripPrefix(firstLabel(['[aria-label^="Phone:"]']), 'Phone') ||
          '';
        const plusCode = firstText(['[data-item-id="oloc"]']) ||
          stripPrefix(firstLabel(['button[aria-label^="Plus code:"]']), 'Plus code') ||
          stripPrefix(firstLabel(['[aria-label^="Plus code:"]']), 'Plus code') ||
          rows.find(row => /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b.*$/i.test(row)) ||
          '';
        const websiteNode = panel.querySelector('a[data-item-id="authority"],a[aria-label^="Website:"]');
        return {
          name: title,
          address,
          contact,
          plusCode,
          website: websiteNode?.getAttribute('href') || '',
          rows,
        };
      }, { fallbackName: listing.text, fallbackAriaLabel: listing.ariaLabel });

      const address = data.address || extractAddressFromRows(data.rows);
      const contact = extractPhoneFromRows([data.contact, ...data.rows], address);
      const plusCode = data.plusCode || extractPlusCodeFromRows(data.rows);

      const row = {
        Name: data.name || listing.text || 'N/A',
        Address: address || 'N/A',
        Contact: contact || 'N/A',
        Website: cleanWebsite(data.website) || 'N/A',
        'Plus Code': plusCode || 'N/A',
        Emails: '',
      };
      const name = normalizeText(row.Name);
      const normalizedAddress = normalizeText(row.Address);
      const identity = normalizedAddress && normalizedAddress !== 'n/a'
        ? `identity:${name}|${normalizedAddress}`
        : getListingKey(uniqueListings[index]);
      if (identity && resultKeys.has(identity)) continue;
      resultKeys.add(identity);
      result.push(row);
    }
    if (uniqueListings.length && !result.length) {
      throw new Error('Google Maps returned listings, but none could be opened. Please try again.');
    }
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

function filterEmails(values) {
  const deniedDomains = ['sentry.io', 'wixpress.com', 'example.com', 'domain.com'];
  const deniedExtensions = /\.(?:png|jpe?g|gif|svg|webp|css|js|woff)$/i;
  const emails = new Set();
  for (const value of values || []) {
    const email = String(value).trim().toLowerCase().replace(/^mailto:/i, '').replace(/[?#].*$/, '');
    const match = email.match(EMAIL_PATTERN);
    if (!match) continue;
    const candidate = match[0];
    const domain = candidate.split('@')[1];
    if (!deniedDomains.some(denied => domain === denied || domain.endsWith(`.${denied}`)) &&
        !deniedExtensions.test(domain)) emails.add(candidate);
  }
  return [...emails].sort();
}

function decodeCloudflareEmail(encoded) {
  if (typeof encoded !== 'string' || !/^[\da-f]+$/i.test(encoded) || encoded.length < 4 || encoded.length % 2) return '';
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  let decoded = '';
  for (let index = 2; index < encoded.length; index += 2) {
    decoded += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 2), 16) ^ key);
  }
  return decoded;
}

function decodeObfuscatedText(value) {
  return cheerio.load(String(value || '')).root().text()
    .replace(/\[\s*at\s*\]|\(\s*at\s*\)/gi, '@')
    .replace(/\[\s*dot\s*\]|\(\s*dot\s*\)/gi, '.')
    .replace(/&#x?0*40;?/gi, '@')
    .replace(/&#x?0*2e;?/gi, '.');
}

function extractEmailsFromHtml(html) {
  const source = String(html || '');
  const $ = cheerio.load(source);
  const candidates = [];
  $('a[href^="mailto:" i]').each((_, element) => {
    candidates.push($(element).attr('href').replace(/^mailto:/i, '').split(/[?#]/, 1)[0]);
  });
  $('[data-cfemail]').each((_, element) => {
    candidates.push(decodeCloudflareEmail($(element).attr('data-cfemail')));
  });
  const visibleText = $('body').text();
  for (const content of [source, decodeObfuscatedText(source), decodeObfuscatedText(visibleText)]) {
    candidates.push(...(content.match(EMAIL_PATTERN) || []));
  }
  return filterEmails(candidates);
}

function isEmptySpaShell(html) {
  const $ = cheerio.load(String(html || ''));
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const appRoots = $('#root, #app, [data-reactroot]');
  const hasRenderedRoot = appRoots.toArray().some(element => $(element).children().length > 0);
  const hasEmailSource = $('a[href^="mailto:" i], [data-cfemail]').length > 0;
  return !hasEmailSource && bodyText.length < 40 &&
    (!hasRenderedRoot || /^(loading|please enable javascript|javascript is required)$/i.test(bodyText));
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 400,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const html = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data || '');
  if (!html.trim()) throw new Error('Website returned an empty response');
  return { html, finalUrl: response.request?.res?.responseUrl || url };
}

async function fetchBrowserHtml(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() || 'error'}`);
    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

async function fetchWebsitePage(url) {
  let axiosResult;
  let axiosError;
  try {
    axiosResult = await fetchHtml(url);
    if (!isEmptySpaShell(axiosResult.html)) return axiosResult;
  } catch (error) {
    axiosError = error;
  }
  try {
    return await fetchBrowserHtml(url);
  } catch (browserError) {
    const reason = browserError.message || String(browserError);
    if (axiosError) throw new Error(`Axios failed (${axiosError.message}); browser fallback failed (${reason})`);
    throw new Error(`Axios returned an empty SPA shell; browser fallback failed (${reason})`);
  }
}

async function crawlEmails(website) {
  let publicUrl;
  try { publicUrl = await validatePublicUrl(website); }
  catch (error) { return { Emails: 'N/A', error: error.message }; }

  let homepage;
  try { homepage = await fetchWebsitePage(publicUrl.href); }
  catch (error) {
    return { Emails: 'N/A', error: error.message };
  }

  const emails = extractEmailsFromHtml(homepage.html);
  if (emails.length) return { Emails: emails.join(', ') };

  const firstUrl = homepage.finalUrl;
  const $ = cheerio.load(homepage.html);
  const origin = new URL(firstUrl).origin;
  const candidates = [];
  $('a[href]').each((_, element) => {
    const text = $($(element)).text();
    const href = $(element).attr('href');
    if (/contact|about|connect|get-in-touch|enquir|support/i.test(`${text} ${href}`)) {
      try {
        const url = new URL(href, firstUrl);
        if (url.origin === origin && !candidates.includes(url.href) &&
            !['mailto:', 'tel:', 'javascript:'].includes(url.protocol)) candidates.push(url.href);
      } catch {}
    }
  });

  const errors = [];
  for (const subpage of candidates.slice(0, 3)) {
    try {
      const page = await fetchWebsitePage(subpage);
      const found = extractEmailsFromHtml(page.html);
      if (found.length) return { Emails: found.join(', ') };
    } catch (error) {
      errors.push(`${subpage}: ${error.message}`);
    }
  }
  return { Emails: 'N/A', ...(errors.length ? { error: errors.join('; ') } : {}) };
}

async function crawlLeadEmails(listings, onProgress = () => {}) {
  const limit = createLimit(4);
  let completed = 0;
  const tasks = listings.map((listing, index) => limit(async () => {
    onProgress({ type: 'status', message: `Crawling website ${index + 1}/${listings.length}: ${listing.Name || listing.Website || 'untitled'}` });
    const result = listing.Website && listing.Website !== 'N/A'
      ? await crawlEmails(listing.Website)
      : { Emails: 'N/A' };
    const row = { ...listing, Emails: result.Emails };
    completed += 1;
    onProgress({ type: 'row', row, index, completed, total: listings.length });
    if (result.error) onProgress({ type: 'warning', message: `${listing.Name || listing.Website}: ${result.error}` });
    return row;
  }));
  const wrappedRows = await Promise.all(tasks);
  return wrappedRows.map(result => result.status === 'fulfilled' ? result.value : { Emails: 'N/A' });
}

module.exports = {
  scrapeGoogleMaps,
  crawlEmails,
  crawlLeadEmails,
  cleanWebsite,
  deduplicateListings,
  getListingKey,
  extractEmailsFromHtml,
  decodeCloudflareEmail,
  extractAddressFromRows,
  extractPhoneFromRows,
  extractPlusCodeFromRows,
};
