'use strict';

const { chromium } = require('playwright');
const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns/promises');
const net = require('node:net');

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

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
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
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
    while (listings.length < target && stalled < 5) {
      const cards = await feed.locator(':scope > div').evaluateAll(nodes =>
        nodes.map(node => ({ text: node.textContent?.replace(/\s+/g, ' ').trim() || '', link: node.querySelector('a[href*="maps/place"]')?.href || '' }))
          .filter(item => item.link && item.text)
      );
      const seenLinks = new Set(listings.map(item => item.link));
      listings.push(...cards.filter(item => {
        if (seenLinks.has(item.link)) return false;
        seenLinks.add(item.link);
        return true;
      }));
      onProgress({ type: 'status', message: `Found ${Math.min(listings.length, target)} places on Maps...` });
      if (listings.length >= target) break;

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
      const link = uniqueListings[index].link;
      onProgress({ type: 'status', message: `Reading place ${index + 1}/${uniqueListings.length}...` });
      const card = page.locator(`a[href="${link}"]`).first();
      const cardName = (await card.getAttribute('aria-label').catch(() => '') ||
        await card.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
      const previousHeading = await page.locator('h1').first().textContent().catch(() => '');
      try {
        await card.click({ timeout: 5000 });
        await page.waitForFunction(value => {
          const heading = [...document.querySelectorAll('h1')]
            .map(node => node.textContent?.replace(/\s+/g, ' ').trim() || '')
            .find(text => text && text !== value);
          return Boolean(heading);
        }, previousHeading, { timeout: 5000 });
      } catch (error) {
        onProgress({ type: 'warning', message: `Could not open a place: ${error.message}` });
      }

      const data = await page.evaluate((fallbackName) => {
        const clean = value => value?.replace(/\s+/g, ' ').replace(/[\u{e000}-\u{f8ff}]/gu, '').trim() || '';
        const nameNode = [...document.querySelectorAll('h1')].find(node => {
          const text = clean(node.textContent);
          return text && !/^(results?|ফলাফল|search results)$/i.test(text);
        });
        const addressNode = document.querySelector('[data-item-id="address"]');
        const phoneNode = document.querySelector('[data-item-id*="phone"]');
        const authorityLink = document.querySelector('[data-item-id="authority"] a[href^="http"]');
        const phoneLink = document.querySelector('a[href^="tel:"]');
        const actionLinks = [...document.querySelectorAll('a[href]')];
        const webLink = authorityLink || actionLinks.find(link => {
          const href = link.getAttribute('href') || '';
          return /^https?:\/\//i.test(href) && !href.includes('google.') && !/google\/maps/i.test(href);
        });
        return {
          name: clean(nameNode?.textContent) || fallbackName,
          address: clean(addressNode?.textContent),
          phone: clean(phoneNode?.textContent) || clean(phoneLink?.textContent) || clean(phoneLink?.getAttribute('href')?.replace(/^tel:/, '')),
          website: webLink?.getAttribute('href') || '',
        };
      }, cardName);

      const row = {
        Name: data.name,
        Address: data.address,
        Phone: data.phone,
        Website: cleanWebsite(data.website),
        Emails: '',
      };
      const name = normalizeText(row.Name);
      const address = normalizeText(row.Address);
      const identity = address
        ? `identity:${name}|${address}`
        : getListingKey(uniqueListings[index]);
      if (identity && resultKeys.has(identity)) continue;
      resultKeys.add(identity);
      result.push(row);
    }
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

function filterEmails(values) {
  const deniedDomains = new Set(['example.com', 'example.net', 'example.org', 'sentry.io']);
  const deniedPatterns = /(?:@[^\s]*?(?:@2x|\.webp|\.png|\.jpg|\.jpeg|\.gif|\.svg)(?:\.[a-z]{2,})?)$/i;
  const emails = new Set();
  for (const value of values || []) {
    const email = String(value).trim().toLowerCase().replace(/^mailto:/i, '').replace(/[?#].*$/, '');
    const match = email.match(EMAIL_PATTERN);
    if (!match) continue;
    const candidate = match[0];
    const domain = candidate.split('@')[1];
    if (!deniedDomains.has(domain) && !deniedPatterns.test(candidate)) emails.add(candidate);
  }
  return [...emails].sort();
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 400,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  return { html: response.data, finalUrl: response.request?.res?.responseUrl || url };
}

async function fetchBrowserHtml(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response || response.status() >= 400) throw new Error(`HTTP ${response?.status() || 'error'}`);
    await page.waitForTimeout(500);
    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

async function crawlEmails(website) {
  let publicUrl;
  try { publicUrl = await validatePublicUrl(website); }
  catch (error) { return { Emails: 'N/A', error: error.message }; }

  let pages;
  try { pages = [await fetchHtml(publicUrl.href)]; }
  catch (error) {
    try { pages = [await fetchBrowserHtml(publicUrl.href)]; }
    catch (browserError) {
      return { Emails: 'N/A', error: browserError.message || error.message };
    }
  }

  const emails = filterEmails(pages.flatMap(page => {
    const $ = cheerio.load(page.html);
    const text = `${$('body').text()} ${$('a[href^="mailto:"]').map((_, item) => $(item).attr('href')).get().join(' ')}`;
    return text.match(EMAIL_PATTERN) || [];
  }));
  if (emails.length) return { Emails: emails.join(', ') };

  const firstUrl = pages[0].finalUrl;
  const $ = cheerio.load(pages[0].html);
  const origin = new URL(firstUrl).origin;
  const candidates = [];
  $('a[href]').each((_, element) => {
    const text = $($(element)).text();
    const href = $(element).attr('href');
    if (/contact|about|connect/i.test(`${text} ${href}`)) {
      try {
        const url = new URL(href, firstUrl);
        if (url.origin === origin && !candidates.includes(url.href)) candidates.push(url.href);
      } catch {}
    }
  });

  for (const subpage of candidates.slice(0, 2)) {
    try {
      const page = await fetchHtml(subpage);
      const sub$ = cheerio.load(page.html);
      const content = `${sub$('body').text()} ${sub$('a[href^="mailto:"]').map((_, item) => sub$(item).attr('href')).get().join(' ')}`;
      const found = filterEmails(content.match(EMAIL_PATTERN) || []);
      if (found.length) return { Emails: found.join(', ') };
    } catch (error) {
      continue;
    }
  }
  return { Emails: 'N/A' };
}

async function crawlLeadEmails(listings, onProgress = () => {}) {
  const limit = createLimit(4);
  let completed = 0;
  const tasks = listings.map((listing, index) => limit(async () => {
    onProgress({ type: 'status', message: `Crawling website ${index + 1}/${listings.length}: ${listing.Name || listing.Website || 'untitled'}` });
    const result = listing.Website ? await crawlEmails(listing.Website) : { Emails: 'N/A' };
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
};
