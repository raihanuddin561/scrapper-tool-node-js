'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanWebsite,
  decodeCloudflareEmail,
  deduplicateListings,
  extractAddressFromRows,
  extractEmailsFromHtml,
  extractPhoneFromRows,
  extractPlusCodeFromRows,
  getListingKey,
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

test('unwraps Google website redirects and ignores delivery providers', () => {
  assert.equal(cleanWebsite('https://www.google.com/url?q=https%3A%2F%2Frestaurant.example.au%2Fcontact'), 'https://restaurant.example.au/contact');
  assert.equal(cleanWebsite('https://www.ubereats.com/au/store/example'), '');
  assert.equal(cleanWebsite('https://restaurant.example.au/'), 'https://restaurant.example.au');
});
