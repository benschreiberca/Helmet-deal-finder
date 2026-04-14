#!/usr/bin/env node

'use strict';

const { google } = require('googleapis');
const cheerio = require('cheerio');

const DISCOUNT_THRESHOLD = 0.40;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const REQUEST_DELAY_MS = 1500;
// Guard against matching CSS px values, IDs, or other non-price numbers
const MIN_PRICE_CAD = 150;

// Approximate retail MSRPs in CAD — used as a reference price only when a
// vendor does not publish a compare-at / was-price alongside the sale price.
const HELMET_MSRPS = {
  'Bell SRT Modular':       749.99,
  'Shoei Neotec 3':        1099.99,
  'Shoei Neotec 2':         849.99,
  'HJC RPHA 91':            699.99,
  'HJC i91':                499.99,
  'HJC i100':               399.99,
  'AGV sportmodular':      1099.99,
  'AGV tourmodular':        799.99,
  'LS2 Advant X':           549.99,
  'LS2 Advant X 2 Carbon':  649.99,
};

const HELMETS = Object.keys(HELMET_MSRPS);

// searchPath is the URL path used for HTML scraping fallback.
const VENDORS = [
  { name: 'FortNine',           baseUrl: 'https://www.fortnine.ca',           searchPath: '/en/catalogsearch/result/?q=' },
  { name: 'GP Bikes',           baseUrl: 'https://www.gpbikes.com',           searchPath: '/search.php?search_query=' },
  { name: 'ADM Sport',          baseUrl: 'https://admsport.com',              searchPath: '/search?q=' },
  { name: 'Studio Cycle',       baseUrl: 'https://studiocycle.ca',            searchPath: '/search?q=' },
  { name: 'RidingGear',         baseUrl: 'https://ridinggear.ca',             searchPath: '/search?q=' },
  { name: 'Royal Distributing', baseUrl: 'https://www.royaldistributing.com', searchPath: '/search?q=' },
  { name: 'Champion Helmets',   baseUrl: 'https://championhelmets.com',       searchPath: '/search?q=' },
  { name: 'Peakboys',           baseUrl: 'https://peakboys.ca',               searchPath: '/search?q=' },
  { name: 'Blackfoot Online',   baseUrl: 'https://blackfootonline.ca',        searchPath: '/search?q=' },
  { name: 'Joe Rocket Canada',  baseUrl: 'https://joerocket.ca',              searchPath: '/search?q=' },
  { name: 'Speed & Strength',   baseUrl: 'https://ssgear.ca',                 searchPath: '/search?q=' },
  { name: 'RevZilla',           baseUrl: 'https://www.revzilla.com',          searchPath: '/search?query=' },
  { name: 'Amazon.ca',          baseUrl: 'https://www.amazon.ca',             searchPath: '/s?k=' },
];

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-CA,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, Accept: 'application/json, */*;q=0.8' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Strategy 1: Shopify predictive-search JSON API ──────────────────────────
// Works for any Shopify store without needing to know HTML structure.
// Returns null (not an empty array) when the endpoint does not exist so the
// caller knows to fall through to HTML-based strategies.

async function tryShopifySearch(vendor, helmet) {
  const q = encodeURIComponent(`${helmet} XL`);
  const url = `${vendor.baseUrl}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=20`;

  const data = await fetchJson(url);
  if (!data) return null;

  const products = data?.resources?.results?.products;
  if (!Array.isArray(products)) return null; // not a Shopify store

  const deals = [];

  for (const product of products) {
    if (!isHelmetMatch(product.title || '', helmet)) continue;

    // Prefer XL-specific variant pricing when the API includes variants.
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const xlVariants = variants.filter(v =>
      ['XL', 'X-LARGE'].includes((v.option1 || '').toUpperCase()) ||
      ['XL', 'X-LARGE'].includes((v.option2 || '').toUpperCase()) ||
      (v.title || '').toUpperCase().includes('XL'),
    );

    const pricePairs = xlVariants.length > 0
      ? xlVariants.map(v => ({
          price: parseFloat(v.price),
          compareAt: parseFloat(v.compare_at_price) || parseFloat(product.compare_at_price_max) || 0,
        }))
      : [{
          price: parseFloat(product.price),
          compareAt: parseFloat(product.compare_at_price_max) || 0,
        }];

    for (const { price, compareAt } of pricePairs) {
      if (!price || isNaN(price) || price < MIN_PRICE_CAD) continue;
      const deal = evaluateDiscount(helmet, vendor, price, compareAt, `${vendor.baseUrl}${product.url}`, 'shopify');
      if (deal) { deals.push(deal); break; }
    }
  }

  return deals;
}

// ── Strategy 2a: JSON-LD structured data ────────────────────────────────────

function extractJsonLdProducts(html) {
  const products = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }

    const nodes = data?.['@graph']
      ? data['@graph']
      : Array.isArray(data) ? data : [data];

    for (const node of nodes) {
      if (node?.['@type'] === 'Product') products.push(node);
    }
  }
  return products;
}

function getPricePairFromOffer(offer) {
  let salePrice = null;
  let listPrice = null;

  // Schema.org supports priceSpecification with priceType for sale vs list.
  const specs = offer.priceSpecification
    ? (Array.isArray(offer.priceSpecification) ? offer.priceSpecification : [offer.priceSpecification])
    : [];

  for (const spec of specs) {
    const p = parseFloat(spec.price);
    if (!p || isNaN(p)) continue;
    const type = (spec.priceType || '').toLowerCase();
    if (type.includes('list') || type.includes('regular') || type.includes('suggested')) {
      listPrice = p;
    } else if (type.includes('sale') || type.includes('actual') || type.includes('minimum')) {
      salePrice = p;
    }
  }

  if (salePrice === null) {
    const p = parseFloat(offer.price ?? offer.lowPrice);
    if (!isNaN(p) && p > 0) salePrice = p;
  }

  return { salePrice, listPrice };
}

function searchJsonLd(html, helmet, vendor, searchUrl) {
  const deals = [];

  for (const product of extractJsonLdProducts(html)) {
    if (!isHelmetMatch(product.name || '', helmet)) continue;

    const rawOffers = product.offers;
    if (!rawOffers) continue;
    const offerList = Array.isArray(rawOffers) ? rawOffers : [rawOffers];

    for (const offer of offerList) {
      const { salePrice, listPrice } = getPricePairFromOffer(offer);
      if (!salePrice || salePrice < MIN_PRICE_CAD) continue;
      const deal = evaluateDiscount(helmet, vendor, salePrice, listPrice || 0, searchUrl, 'json-ld');
      if (deal) { deals.push(deal); break; }
    }
  }

  return deals;
}

// ── Strategy 2b: Cheerio HTML price-pair extraction ─────────────────────────

const SALE_PRICE_SELECTORS = [
  '.sale-price', '.price--sale', '.special-price', '.price-sale',
  '.price-item--sale', '.product__price--sale',
  '.price-box .special-price .price',
  '[class*="sale"][class*="price"]', '.current-price',
].join(', ');

const COMPARE_PRICE_SELECTORS = [
  '.compare-at-price', '.compare-price', '.was-price', '.price--compare',
  '.original-price', '.price-item--regular',
  '.price-box .old-price .price',
  '[class*="compare"][class*="price"]',
].join(', ');

const PRODUCT_CONTAINER_SELECTORS = [
  '.product-card', '.product-item', '.product-grid-item', '.product',
  '[class*="product-card"]', '[class*="product-item"]',
  '.search-result', '.result-item', 'li.grid__item', 'article',
].join(', ');

function parsePrice(text) {
  const m = /\$?\s*([\d,]+\.?\d*)/.exec((text || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const p = parseFloat(m[1].replace(/,/g, ''));
  return p >= MIN_PRICE_CAD ? p : null;
}

function searchCheerio(html, helmet, vendor, searchUrl) {
  const $ = cheerio.load(html);
  const deals = [];

  $(PRODUCT_CONTAINER_SELECTORS).each((_, el) => {
    if (!isHelmetMatch($(el).text(), helmet)) return;

    const link = $(el).find('a[href]').first().attr('href') || '';
    const productUrl = link.startsWith('http') ? link : `${vendor.baseUrl}${link}`;

    const salePrice =
      parsePrice($(el).find(SALE_PRICE_SELECTORS).first().text()) ??
      parsePrice($(el).find('.price').first().text());

    const comparePrice =
      parsePrice($(el).find(COMPARE_PRICE_SELECTORS).first().text()) ??
      parsePrice($(el).find('s, del').first().text());

    if (!salePrice) return;

    const deal = evaluateDiscount(
      helmet, vendor, salePrice, comparePrice || 0,
      productUrl || searchUrl, 'html',
    );
    if (deal) deals.push(deal);
  });

  return deals;
}

// ── Core discount evaluation ────────────────────────────────────────────────

function evaluateDiscount(helmet, vendor, price, compareAt, url, source) {
  let discount = 0;

  if (compareAt && compareAt > price) {
    discount = (compareAt - price) / compareAt;
  } else {
    // Fallback: compare against known MSRP only when no explicit compare-at
    // price is available, and only when the price has already crossed the
    // threshold — avoids false positives from MSRP estimates being off.
    const msrp = HELMET_MSRPS[helmet];
    if (msrp && price <= msrp * (1 - DISCOUNT_THRESHOLD)) {
      discount = (msrp - price) / msrp;
    }
  }

  if (discount < DISCOUNT_THRESHOLD) return null;

  return {
    helmet,
    vendor: vendor.name,
    price,
    discount: (discount * 100).toFixed(1),
    url,
    timestamp: new Date().toISOString(),
    source,
  };
}

// ── Helmet name matching ────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHelmetMatch(text, helmetName) {
  const lower = text.toLowerCase();
  const helmetLower = helmetName.toLowerCase();

  if (lower.includes(helmetLower)) return true;

  // All significant words must be present as whole words.
  const words = helmetLower.split(/\s+/).filter(w => w.length > 1);
  return words.every(w => new RegExp(`\\b${escapeRegex(w)}\\b`, 'i').test(lower));
}

// ── Per-vendor search orchestration ─────────────────────────────────────────

async function searchVendor(vendor, helmet) {
  // Strategy 1 — Shopify JSON API (returns null if store is not Shopify)
  const shopifyDeals = await tryShopifySearch(vendor, helmet);
  if (shopifyDeals !== null) {
    if (shopifyDeals.length > 0)
      console.log(`    [shopify] ${shopifyDeals.length} deal(s): "${helmet}"`);
    return shopifyDeals;
  }

  // Strategy 2 — Fetch the search-results page; try JSON-LD then Cheerio
  const searchUrl = `${vendor.baseUrl}${vendor.searchPath}${encodeURIComponent(helmet + ' XL')}`;
  const html = await fetchText(searchUrl);

  if (!html) {
    console.log(`    [skip] No response for "${helmet}"`);
    return [];
  }

  // 2a — JSON-LD structured data
  const ldDeals = searchJsonLd(html, helmet, vendor, searchUrl);
  if (ldDeals.length > 0) {
    console.log(`    [json-ld] ${ldDeals.length} deal(s): "${helmet}"`);
    return ldDeals;
  }

  // 2b — Cheerio HTML price-pair parsing
  const htmlDeals = searchCheerio(html, helmet, vendor, searchUrl);
  if (htmlDeals.length > 0)
    console.log(`    [html] ${htmlDeals.length} deal(s): "${helmet}"`);

  return htmlDeals;
}

// ── Deduplication ───────────────────────────────────────────────────────────

function deduplicateDeals(deals) {
  const seen = new Set();
  return deals.filter(d => {
    const key = `${d.vendor}|${d.helmet}|${d.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Google Sheets ───────────────────────────────────────────────────────────

async function authenticate() {
  if (!GOOGLE_CREDENTIALS) {
    console.log('GOOGLE_CREDENTIALS not set — skipping Sheets update.');
    return null;
  }
  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } catch (err) {
    console.error('Google auth failed:', err.message);
    return null;
  }
}

async function ensureSheetHeaders(auth) {
  if (!auth || !SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A1:F1',
    });
    if (!data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Deals!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Timestamp', 'Helmet Model', 'Vendor', 'Price (CAD)', 'Discount %', 'Vendor URL']],
        },
      });
      console.log('Wrote sheet headers.');
    }
  } catch (err) {
    console.error('Sheet header init failed:', err.message);
  }
}

async function writeDealsToSheet(auth, deals) {
  if (!auth || !SPREADSHEET_ID) {
    console.log('Sheets not configured — skipping write.');
    return;
  }
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const rows = deals.map(d => [
      new Date(d.timestamp).toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
      d.helmet,
      d.vendor,
      `$${parseFloat(d.price).toFixed(2)} CAD`,
      `${d.discount}%`,
      d.url,
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
    console.log(`Wrote ${deals.length} deal(s) to Google Sheets.`);
  } catch (err) {
    console.error('Sheet write failed:', err.message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('==========================================');
  console.log('  Helmet Deal Finder');
  console.log('==========================================');
  console.log(`Helmets: ${HELMETS.length}  Vendors: ${VENDORS.length}  Threshold: ${(DISCOUNT_THRESHOLD * 100).toFixed(0)}%\n`);

  const allDeals = [];

  for (const vendor of VENDORS) {
    console.log(`\n>> ${vendor.name}`);
    for (const helmet of HELMETS) {
      const deals = await searchVendor(vendor, helmet);
      allDeals.push(...deals);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const uniqueDeals = deduplicateDeals(allDeals);

  console.log('\n==========================================');
  console.log(`Found ${uniqueDeals.length} unique deal(s).`);

  if (uniqueDeals.length > 0) {
    console.log('\nDeals:');
    uniqueDeals.forEach(d =>
      console.log(`  ${d.helmet} @ ${d.vendor}: $${parseFloat(d.price).toFixed(2)} (${d.discount}% off) [${d.source}]`),
    );

    const auth = await authenticate();
    if (auth) {
      await ensureSheetHeaders(auth);
      await writeDealsToSheet(auth, uniqueDeals);
    }
  } else {
    console.log('No deals found at this time.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
