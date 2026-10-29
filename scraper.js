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
const PLUS_CODE_PATTERN = /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b(?:[ \t]+[^\r\n]*)?/i;

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

function extractDomain(website) {
  if (!website || website === 'N/A') return 'N/A';
  try {
    return new URL(website).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    const match = String(website).match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/i);
    return match?.[1]?.toLowerCase() || 'N/A';
  }
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
    const value = String(row || '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!value || value.includes('$') || (address && normalizeText(value) === normalizeText(address)) ||
        ADDRESS_PATTERN.test(value)) continue;
    const candidates = value.match(/(?<![\w$])(?:\+\s?\d{1,3}(?:\s*\(0\))?[\s.-]*)?(?:\(?0\d{1,4}\)?[\s.-]*)?\d{1,4}(?:[\s.-]+\d{2,4}){1,2}(?!\d)/g) || [];
    for (const candidate of candidates) {
      const digits = candidate.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) return candidate.trim();
    }
  }
  return '';
}

function extractPlusCodeFromRows(rows) {
  for (const row of rows || []) {
    const match = String(row || '').replace(/\s+/g, ' ').match(PLUS_CODE_PATTERN);
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
      const cards = (await feed.locator(':scope > div').evaluateAll(nodes =>
        nodes.map(node => {
          const anchor = node.querySelector('a.hfpxzc[href*="maps/place"],a[href*="maps/place"]');
          return {
            text: node.textContent?.replace(/\s+/g, ' ').trim() || '',
            ariaLabel: anchor?.getAttribute('aria-label') || '',
            link: anchor?.getAttribute('href') || '',
          };
        }).filter(item => item.link && item.text)
      )).map(item => ({ ...item, link: new URL(item.link, page.url()).href }));
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
    const addResult = (row, listing, index) => {
      const name = normalizeText(row.Name);
      const normalizedAddress = normalizeText(row.Address);
      const identity = normalizedAddress && normalizedAddress !== 'n/a'
        ? `identity:${name}|${normalizedAddress}`
        : getListingKey(listing || uniqueListings[index]);
      if (identity && resultKeys.has(identity)) return;
      resultKeys.add(identity);
      result.push(row);
    };
    const uniqueListings = deduplicateListings(listings).slice(0, target);
    for (let index = 0; index < uniqueListings.length; index += 1) {
      const listing = uniqueListings[index];
      const link = listing.link;
      const expectedNames = [];
      try {
        const placeName = new URL(link).pathname.match(/\/maps\/place\/([^/]+)/i)?.[1];
        if (placeName) expectedNames.push(decodeURIComponent(placeName.replace(/\+/g, ' ')));
      } catch {}
      for (const candidate of [listing.ariaLabel, listing.text]) {
        const name = String(candidate || '').split(/\s+[·•|]\s+/)[0].trim();
        if (name && !expectedNames.includes(name)) expectedNames.push(name);
      }
      const expectedName = expectedNames.find(name =>
        normalizeText(name).length > 2 && !/^(results?|search results|google maps)$/i.test(name)
      ) || '';
      onProgress({ type: 'status', message: `Reading place ${index + 1}/${uniqueListings.length}...` });
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await dismissConsent(page);
        const placeCards = page.locator('a.hfpxzc');
        const resultsFeed = page.locator('[role="feed"]');
        await resultsFeed.waitFor({ state: 'visible', timeout: 20000 });

        let cardIndex = -1;
        for (let attempt = 0; attempt < 8 && cardIndex < 0; attempt += 1) {
          cardIndex = await placeCards.evaluateAll((anchors, href) =>
            anchors.findIndex(anchor => anchor.href === href ||
              new URL(anchor.getAttribute('href'), window.location.href).href === href), link);
          if (cardIndex < 0) {
            await resultsFeed.evaluate(feedNode => { feedNode.scrollTop = feedNode.scrollHeight; });
            await page.waitForTimeout(500);
          }
        }

        const previousUrl = page.url();
        if (cardIndex >= 0) {
          await placeCards.nth(cardIndex).click({ timeout: 10000 });
        } else {
          onProgress({ type: 'warning', message: `Place card was not present in the feed; opening its saved Maps URL instead: ${expectedName || link}` });
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        const waitForSelectedPlace = () => page.waitForFunction(({ names, oldUrl, fallbackUrl }) => {
          const normalize = value => String(value || '').normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const headings = [...document.querySelectorAll('h1.DUwDvf, [role="main"] h1')]
            .map(node => normalize(node.textContent))
            .filter(text => text && !/^(results?|search results|google maps)$/.test(text));
          const expected = names.map(normalize).filter(Boolean);
          const headingMatches = headings.some(heading => expected.some(name =>
            heading === name || heading.startsWith(`${name} `) || name.startsWith(`${heading} `)
          ));
          const currentUrl = window.location.href;
          const placeUrl = currentUrl.includes('/maps/place/') &&
            (/@-?\d+(?:\.\d+)?,-?\d/.test(currentUrl) || /[?&]data=|\/data=/.test(currentUrl));
          return headingMatches && ((placeUrl && currentUrl !== oldUrl) || currentUrl === fallbackUrl);
        }, { names: expectedNames, oldUrl: previousUrl, fallbackUrl: link }, { timeout: 15000 });

        try {
          await waitForSelectedPlace();
        } catch (clickError) {
          if (cardIndex < 0) throw clickError;
          onProgress({ type: 'warning', message: `Place card did not open the expected detail panel; retrying its saved Maps URL: ${expectedName || link}` });
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await waitForSelectedPlace();
        }
      } catch (error) {
        onProgress({ type: 'warning', message: `Could not open a place: ${error.message}` });
        continue;
      }

      const currentUrl = page.url();
      const googleSearchUrl = currentUrl.includes('/maps/place/') ? currentUrl : link;
      const data = await page.evaluate(({ fallbackName, fallbackAriaLabel, expectedNames }) => {
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
        const rows = [
          ...panel.innerText.split(/\n+/).map(clean),
          ...[...panel.querySelectorAll('[data-item-id],button,[aria-label]')]
            .flatMap(node => [
              clean(node.innerText || node.textContent),
              clean(node.getAttribute('aria-label')),
            ]),
        ]
          .filter(Boolean);

        const mainLabel = clean(panel.getAttribute('aria-label'));
        const normalizedNames = expectedNames.map(value => String(value || '').normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
        const headings = [...document.querySelectorAll('h1.DUwDvf, [role="main"] h1')]
          .map(node => clean(node.textContent))
          .filter(value => value && !/^(results?|search results|google maps)$/i.test(value));
        const matchedTitle = headings.find(value => {
          const heading = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          return normalizedNames.some(name => name &&
            (heading === name || heading.startsWith(`${name} `) || name.startsWith(`${heading} `)));
        });
        const title = matchedTitle || firstText(['h1.DUwDvf', 'h1']) ||
          (/^(map|google maps|main content)$/i.test(mainLabel) ? '' : mainLabel) ||
          clean(fallbackAriaLabel) ||
          clean(fallbackName);
        const address = stripPrefix(firstText(['[data-item-id="address"]']), 'Address') ||
          stripPrefix(firstLabel(['button[data-item-id="address"]']), 'Address') ||
          stripPrefix(firstLabel(['[aria-label^="Address:"]']), 'Address') ||
          rows.find(row => /\d+\s+[A-Za-z0-9\s.,'-]+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Way|Hwy|Pde|Parade|Pl|Place|Ct|Court|VIC|NSW|QLD|WA|SA|TAS|ACT|NT|Australia)\b/i.test(row)) ||
          '';
        const phoneNodes = [...document.querySelectorAll(
          '[data-item-id^="phone:tel:"],a[href^="tel:" i],[aria-label^="Phone:" i],button[aria-label*="phone" i]'
        )];
        const contactCandidates = phoneNodes.flatMap(node => [
          node.getAttribute('data-item-id')?.replace(/^phone:tel:/i, ''),
          node.getAttribute('href')?.replace(/^tel:/i, ''),
          node.getAttribute('aria-label')?.replace(/^phone:\s*/i, ''),
          clean(node.innerText || node.textContent),
        ]).filter(Boolean);
        const phoneItem = panel.querySelector('[data-item-id^="phone:tel:"]');
        const phoneId = phoneItem?.getAttribute('data-item-id')?.replace(/^phone:tel:/i, '') || '';
        const contact = phoneId || firstText(['[data-item-id^="phone:tel:"]']) ||
          stripPrefix(firstLabel(['button[aria-label^="Phone:"]']), 'Phone') ||
          stripPrefix(firstLabel(['[aria-label^="Phone:"]']), 'Phone') ||
          '';
        const plusCodeCandidates = [
          ...[...document.querySelectorAll(
            '[data-item-id="oloc"],[aria-label*="plus code" i],[title*="plus code" i],[data-value*="+" i]'
          )].flatMap(node => [
            clean(node.innerText || node.textContent),
            clean(node.getAttribute('aria-label')),
            clean(node.getAttribute('title')),
            clean(node.getAttribute('data-value')),
            clean(node.parentElement?.innerText),
          ]),
          ...clean(document.body.innerText).split(/\n+/).map(clean),
          ...rows,
        ].filter(Boolean);
        const plusCode = plusCodeCandidates.find(value =>
          /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/i.test(value)
        ) || '';
        const websiteNode = panel.querySelector('a[data-item-id="authority"],a[aria-label^="Website:"]') ||
          document.querySelector('a[data-item-id="authority"],a[aria-label^="Website:"]');
        return {
          name: title,
          address,
          contact,
          contactCandidates,
          plusCode,
          plusCodeCandidates,
          website: websiteNode?.getAttribute('href') || '',
          rows,
        };
      }, {
        fallbackName: listing.text,
        fallbackAriaLabel: listing.ariaLabel,
        expectedNames,
      });

      const address = data.address || extractAddressFromRows(data.rows);
      const contact = extractPhoneFromRows([data.contact, ...data.contactCandidates, ...data.rows], address);
      const plusCode = extractPlusCodeFromRows([
        ...(data.plusCodeCandidates || []),
        data.plusCode,
        ...data.rows,
      ]);
      if (!contact) onProgress({ type: 'warning', message: `No phone number was exposed in the Maps detail panel for ${data.name || expectedName || listing.text}.` });
      if (!plusCode) onProgress({ type: 'warning', message: `No Plus Code was exposed in the Maps detail panel for ${data.name || expectedName || listing.text}.` });

      const row = {
        Name: data.name || listing.text || 'N/A',
        Address: address || 'N/A',
        Contact: contact || 'N/A',
        Website: cleanWebsite(data.website) || 'N/A',
        domain: extractDomain(cleanWebsite(data.website)),
        'Plus Code': plusCode || 'N/A',
        Emails: 'N/A',
        googleSearchUrl,
      };
      addResult(row, listing, index);
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
  return cheerio.load(String(value || '').replace(/<[^>]*>/g, ' ')).root().text()
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+)/gi, '@')
    .replace(/(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)/gi, '.')
    .replace(/(?:&#x?0*40;?|&commat;|%40)/gi, '@')
    .replace(/(?:&#x?0*2e;?|&period;|%2e)/gi, '.')
    .replace(/\\u0040/gi, '@')
    .replace(/\\u002e/gi, '.')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.');
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
  $('[data-email], [data-mail]').each((_, element) => {
    candidates.push(decodeObfuscatedText($(element).attr('data-email') || $(element).attr('data-mail')));
  });
  $('a[href^="mailto:" i]').each((_, element) => {
    try {
      candidates.push(decodeURIComponent($(element).attr('href').replace(/^mailto:/i, '').split(/[?#]/, 1)[0]));
    } catch {}
  });
  const visibleText = $('body').text();
  for (const content of [source, decodeObfuscatedText(source), decodeObfuscatedText(visibleText)]) {
    candidates.push(...(content.match(EMAIL_PATTERN) || []));
  }
  return filterEmails(candidates);
}

function getInternalPageUrls(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const base = new URL(baseUrl);
  const urls = new Map();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) return;
    try {
      const url = new URL(href, base);
      if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol)) return;
      url.hash = '';
      if (!/\.(?:png|jpe?g|gif|svg|webp|css|js|woff|pdf|zip)(?:$|[?#])/i.test(url.pathname)) {
        const label = [
          $(element).text(),
          $(element).attr('aria-label'),
          $(element).attr('title'),
        ].filter(Boolean).join(' ');
        urls.set(url.href, { url: url.href, label });
      }
    } catch {}
  });
  return [...urls.values()];
}

function getSitemapLocations(xml, baseUrl) {
  const base = new URL(baseUrl);
  const urls = [];
  for (const match of String(xml || '').matchAll(/<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const location = cheerio.load(match[1]).text().trim();
    try {
      const url = new URL(location, base);
      if (url.origin === base.origin && ['http:', 'https:'].includes(url.protocol)) {
        urls.push(url.href);
      }
    } catch {}
  }
  return [...new Set(urls)];
}

function rankContactPage(url, label = '') {
  const value = `${url} ${label}`.toLowerCase();
  if (/contact|enquir|inquir|get-in-touch|connect|email/.test(value)) return 0;
  if (/about|team|staff|people|location|visit|function|event|booking|reserv/.test(value)) return 1;
  return 2;
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
    validateStatus: status => status >= 200 && status < 500,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const html = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data || '');
  if (!html.trim() && response.status < 400) throw new Error('Website returned an empty response');
  return { html, finalUrl: response.request?.res?.responseUrl || url, status: response.status };
}

async function fetchBrowserHtml(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (!response) throw new Error('No response received');
    if (response.status() === 404) return { html: '', finalUrl: page.url(), status: 404 };
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    return { html: await page.content(), finalUrl: page.url(), status: response.status() };
  } finally {
    await browser.close();
  }
}

async function fetchWebsitePage(url) {
  let axiosResult;
  let axiosError;
  try {
    axiosResult = await fetchHtml(url);
    if (axiosResult.status === 404 || axiosResult.status === 410) {
      return { ...axiosResult, notFound: true };
    }
    if (axiosResult.status < 400 && !isEmptySpaShell(axiosResult.html)) return axiosResult;
    if (axiosResult.status >= 400) axiosError = new Error(`HTTP ${axiosResult.status}`);
  } catch (error) {
    axiosError = error;
  }
  try {
    const browserResult = await fetchBrowserHtml(url);
    return browserResult.status === 404
      ? { ...browserResult, notFound: true }
      : browserResult;
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
  if (homepage.notFound) return { Emails: 'N/A', error: `Official website returned HTTP 404: ${publicUrl.href}` };

  const foundEmails = new Set(extractEmailsFromHtml(homepage.html));
  const firstUrl = homepage.finalUrl;
  const origin = new URL(firstUrl).origin;
  const discovered = getInternalPageUrls(homepage.html, firstUrl);
  const sitemapUrls = new Set();
  const errors = [];
  const sitemapCandidates = new Set();
  try {
    const robots = await fetchWebsitePage(new URL('/robots.txt', firstUrl).href);
    if (!robots.notFound) {
      for (const line of robots.html.split(/\r?\n/)) {
        const match = line.match(/^\s*sitemap:\s*(\S+)/i);
        if (match) sitemapCandidates.add(match[1]);
      }
    }
  } catch (error) {
    errors.push(`robots.txt: ${error.message}`);
  }
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    sitemapCandidates.add(new URL(path, firstUrl).href);
  }

  let sitemapCount = 0;
  for (const sitemapUrl of sitemapCandidates) {
    if (sitemapCount >= 3) break;
    let sitemap;
    try {
      const url = new URL(sitemapUrl);
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) continue;
      sitemap = await fetchWebsitePage(url.href);
    } catch (error) {
      errors.push(`${sitemapUrl}: ${error.message}`);
      continue;
    }
    if (sitemap.notFound || !sitemap.html || !/<(?:urlset|sitemapindex)\b/i.test(sitemap.html)) continue;
    sitemapCount += 1;
    const locations = getSitemapLocations(sitemap.html, sitemap.finalUrl);
    for (const location of locations) {
      if (/\.xml(?:$|[?#])/i.test(new URL(location).pathname)) {
        if (sitemapCount < 3) sitemapCandidates.add(location);
      } else {
        sitemapUrls.add(location);
      }
    }
  }

  const candidatesByUrl = new Map(discovered.map(item => [item.url, item.label]));
  for (const url of sitemapUrls) {
    if (!candidatesByUrl.has(url)) candidatesByUrl.set(url, '');
  }
  const candidates = [...candidatesByUrl]
    .filter(([url]) => url !== firstUrl && new URL(url).origin === origin)
    .sort(([urlA, labelA], [urlB, labelB]) =>
      rankContactPage(urlA, labelA) - rankContactPage(urlB, labelB)
    );
  for (const [subpage] of candidates.slice(0, 8)) {
    try {
      const page = await fetchWebsitePage(subpage);
      if (page.notFound) continue;
      extractEmailsFromHtml(page.html).forEach(email => foundEmails.add(email));
    } catch (error) {
      errors.push(`${subpage}: ${error.message}`);
    }
  }
  return {
    Emails: foundEmails.size ? [...foundEmails].sort().join(', ') : 'N/A',
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

async function crawlLeadEmails(listings, onProgress = () => {}) {
  const limit = createLimit(4);
  let completed = 0;
  const tasks = listings.map((listing, index) => limit(async () => {
    onProgress({ type: 'status', message: `Crawling website ${index + 1}/${listings.length}: ${listing.Name || listing.Website || 'untitled'}` });
    let result = { Emails: 'N/A' };
    if (listing.Website && listing.Website !== 'N/A') {
      try {
        result = await crawlEmails(listing.Website);
      } catch (error) {
        result = { Emails: 'N/A', error: error.message || String(error) };
      }
    }
    const row = {
      ...listing,
      Name: listing.Name || 'N/A',
      Address: listing.Address || 'N/A',
      Contact: listing.Contact || 'N/A',
      Website: listing.Website || 'N/A',
      domain: listing.domain || extractDomain(listing.Website),
      'Plus Code': listing['Plus Code'] || 'N/A',
      Emails: result.Emails || 'N/A',
      googleSearchUrl: listing.googleSearchUrl || 'N/A',
    };
    completed += 1;
    onProgress({ type: 'row', row, index, completed, total: listings.length });
    if (result.error) onProgress({ type: 'warning', message: `${listing.Name || listing.Website}: ${result.error}` });
    else if (result.Emails === 'N/A' && listing.Website && listing.Website !== 'N/A') {
      onProgress({ type: 'warning', message: `No email address was found on the homepage or checked contact pages for ${listing.Name || listing.Website}.` });
    }
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
  extractDomain,
  deduplicateListings,
  getListingKey,
  extractEmailsFromHtml,
  decodeCloudflareEmail,
  extractAddressFromRows,
  extractPhoneFromRows,
  extractPlusCodeFromRows,
  getInternalPageUrls,
  getSitemapLocations,
};
