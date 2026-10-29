'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanWebsite,
  crawlLeadEmails,
  decodeCloudflareEmail,
  deduplicateListings,
  extractDomain,
  extractAddressFromRows,
  extractEmailsFromHtml,
  extractPhoneFromRows,
  extractPlusCodeFromRows,
  getInternalPageUrls,
  getSitemapLocations,
  getListingKey,
  isTimeoutError,
} = require('../scraper');

test('deduplicates repeated Maps cards that use the same place URL', () => {
  const listings = [
    { text: 'Cafe One', link: 'https://www.google.com/maps/place/Cafe+One/data=!4m2!3m1!1s0x6ad6429b12345678:0xabcdef1234567890' },
    { text: 'Cafe One', link: 'https://www.google.com/maps/place/Cafe+One/data=!4m2!3m1!1s0x6ad6429b12345678:0xabcdef1234567890' },
  ];

  assert.deepEqual(deduplicateListings(listings), [listings[0]]);
  assert.equal(getListingKey(listings[0]), getListingKey(listings[1]));
});

test('keeps distinct places with Google Maps hexadecimal place IDs', () => {
  const first = 'https://www.google.com/maps/place/Brick+Lane/data=!4m2!3m1!1s0x6ad65d355ff1028d:0x22562049e5a0a09b';
  const second = 'https://www.google.com/maps/place/Higher+Ground/data=!4m2!3m1!1s0x6ad65d4f001f1ff9:0x4dcf756c236e21df';

  assert.equal(getListingKey({ link: first }), 'place-id:0x6ad65d355ff1028d:0x22562049e5a0a09b');
  assert.equal(getListingKey({ link: second }), 'place-id:0x6ad65d4f001f1ff9:0x4dcf756c236e21df');
  assert.equal(deduplicateListings([{ link: first }, { link: second }]).length, 2);
});

test('uses a normalized place-name URL when no place ID is available', () => {
  const listings = [
    { text: 'Abbey Cafe', link: 'https://www.google.com/maps/place/Abbey%20Cafe/@-37.8,144.9,17z/' },
    { text: 'Abbey Cafe', link: 'https://maps.google.com/maps/place/Abbey+Cafe/?hl=en' },
  ];

  assert.deepEqual(deduplicateListings(listings), [listings[0]]);
});

test('uses name and address identity for cards with no stable URL identity', () => {
  const listings = [
    { Name: '  Abbey   Cafe ', Address: '123 Main Street, Abbotsford' },
    { Name: 'Abbey Cafe', Address: '123 Main Street, Abbotsford' },
  ];

  assert.deepEqual(deduplicateListings(listings), [listings[0]]);
});

test('extracts email addresses from mailto, Cloudflare, entities, and obfuscated text', () => {
  const email = 'contact@keifcafe.com.au';
  const key = 0x5c;
  const encoded = [key, ...[...email].map(character => character.charCodeAt(0) ^ key)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const html = `
    <a href="mailto:hello@restaurant.com?subject=Hello">Email</a>
    <span data-cfemail="${encoded}"></span>
    <p>team[at]cafe[dot]com &#115;ales&#64;shop.org</p>
    <p>image@assets.png junk@wixpress.com</p>`;

  assert.equal(decodeCloudflareEmail(encoded), email);
  assert.deepEqual(extractEmailsFromHtml(html), [
    'contact@keifcafe.com.au',
    'hello@restaurant.com',
    'sales@shop.org',
    'team@cafe.com',
  ]);
});

test('decodes additional common email obfuscations and reads every email match', () => {
  const html = `
    <p>info (at) example (dot) org</p>
    <p>hello at cafe dot com.au</p>
    <a href="mailto:sales%40shop.org?subject=Sales">Sales</a>
    <span data-email="events@cafe.com"></span>`;

  assert.deepEqual(extractEmailsFromHtml(html), [
    'events@cafe.com',
    'hello@cafe.com.au',
    'info@example.org',
    'sales@shop.org',
  ]);
});

test('discovers labeled internal pages and restricts sitemap links to the official origin', () => {
  const links = getInternalPageUrls(`
    <a href="/page-42" aria-label="Contact us">Contact</a>
    <a href="/about/">About</a>
    <a href="https://other.example/contact">External</a>
    <a href="mailto:hello@example.org">Email</a>`,
  'https://cafe.example/');
  assert.deepEqual(links, [
    { url: 'https://cafe.example/page-42', label: 'Contact Contact us' },
    { url: 'https://cafe.example/about/', label: 'About' },
  ]);
  assert.deepEqual(getSitemapLocations(`
    <urlset>
      <url><loc>https://cafe.example/contact/</loc></url>
      <url><loc>https://external.example/contact/</loc></url>
    </urlset>`,
  'https://cafe.example/sitemap.xml'), ['https://cafe.example/contact/']);
});

test('extracts address, phone, and plus code while ignoring price and postcode digits', () => {
  const rows = [
    '$1–20 per person',
    '12 High Street, Abbotsford VIC 3067',
    '03 9417 1234',
    '6VWR+6Q Aberfeldie, Victoria, Australia',
  ];

  const address = extractAddressFromRows(rows);
  assert.equal(address, '12 High Street, Abbotsford VIC 3067');
  assert.equal(extractPhoneFromRows(rows, address), '03 9417 1234');
  assert.equal(extractPlusCodeFromRows(rows), '6VWR+6Q Aberfeldie, Victoria, Australia');
});

test('ignores Maps copy controls and extracts a code from Plus Code labels or nearby text', () => {
  assert.equal(extractPlusCodeFromRows([
    'Copy plus code',
    'Plus code: 6VWR+6Q Aberfeldie, Victoria, Australia',
  ]), '6VWR+6Q Aberfeldie, Victoria, Australia');
  assert.equal(extractPlusCodeFromRows(['Copy plus code']), '');
  assert.equal(extractPlusCodeFromRows(['Location details', '7XHX+2V']), '7XHX+2V');
});

test('extracts full labeled phone numbers and ignores short prices and postcodes', () => {
  assert.equal(extractPhoneFromRows([
    '$1–20 per person',
    '12 High Street, Abbotsford VIC 3067',
    'Phone: +61 (0) 3 9417 1234',
  ], '12 High Street, Abbotsford VIC 3067'), '+61 (0) 3 9417 1234');
  assert.equal(extractPhoneFromRows(['Phone: 0412 345 678']), '0412 345 678');
});

test('unwraps Google website redirects and ignores delivery providers', () => {
  assert.equal(cleanWebsite('https://www.google.com/url?q=https%3A%2F%2Frestaurant.example.au%2Fcontact'), 'https://restaurant.example.au/contact');
  assert.equal(cleanWebsite('https://www.ubereats.com/au/store/example'), '');
  assert.equal(cleanWebsite('https://restaurant.example.au/'), 'https://restaurant.example.au');
});

test('extracts the clean root hostname from an official website URL', () => {
  const website = cleanWebsite('https://www.examplecafe.com.au/menu');
  assert.equal(website, 'https://www.examplecafe.com.au/menu');
  assert.equal(extractDomain(website), 'examplecafe.com.au');
  assert.equal(extractDomain('N/A'), 'N/A');
});

test('preserves all output fields and skips email crawling without an official website', async () => {
  const [row] = await crawlLeadEmails([{
    Name: 'Cafe',
    Address: 'N/A',
    Contact: 'N/A',
    Website: 'N/A',
    domain: 'N/A',
    'Plus Code': 'N/A',
    googleSearchUrl: 'https://www.google.com/maps/place/Cafe/data=!abc',
  }]);

  assert.deepEqual(row, {
    Name: 'Cafe',
    Address: 'N/A',
    Contact: 'N/A',
    Website: 'N/A',
    domain: 'N/A',
    'Plus Code': 'N/A',
    googleSearchUrl: 'https://www.google.com/maps/place/Cafe/data=!abc',
    Emails: 'N/A',
  });
});

test('stops queued website email crawling when its abort signal is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    crawlLeadEmails([{ Name: 'Cafe', Website: 'N/A' }], () => {}, { signal: controller.signal }),
    { name: 'AbortError', message: 'Scraping stopped by user.' }
  );
});

test('identifies slow website requests so they do not get a redundant browser retry', () => {
  assert.equal(isTimeoutError({ code: 'ECONNABORTED', message: 'timeout of 4000ms exceeded' }), true);
  assert.equal(isTimeoutError({ code: 'ETIMEDOUT', message: 'socket timeout' }), true);
  assert.equal(isTimeoutError({ code: 'ERR_BAD_RESPONSE', message: 'Request failed with status code 403' }), false);
});
