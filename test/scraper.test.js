'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateListings, getListingKey } = require('../scraper');

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
