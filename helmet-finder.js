#!/usr/bin/env node

'use strict';

const fs = require('fs');
const { google } = require('googleapis');
const cheerio = require('cheerio');

const DISCOUNT_THRESHOLD = 0.40;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const REQUEST_DELAY_MS = 1200;
const MIN_PRICE_CAD = 150; // guard against CSS px values, IDs, etc.
const OUTPUT_FILE = 'PRICES.md';

// Approximate retail MSRPs in CAD — reference price when no compare-at price
// is available from the vendor.
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

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : null };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
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

// ── Price record ─────────────────────────────────────────────────────────────

function buildRecord(helmet, vendorName, price, compareAt, url, source) {
  if (!price || isNaN(price) || price < MIN_PRICE_CAD) return null;

  const msrp = HELMET_MSRPS[helmet];
  let discountPct = 0;
  let refPrice = 0;

  if (compareAt && compareAt > price) {
    discountPct = ((compareAt - price) / compareAt) * 100;
    refPrice = compareAt;
  } else if (msrp && price < msrp) {
    discountPct = ((msrp - price) / msrp) * 100;
    refPrice = msrp;
  }

  return {
    helmet,
    vendor: vendorName,
    price,
    refPrice: refPrice > 0 ? refPrice : null,
    discountPct,
    isAlert: discountPct >= DISCOUNT_THRESHOLD * 100,
    url,
    source,
    timestamp: new Date().toISOString(),
  };
}

// ── Helmet name matching ─────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHelmetMatch(text, helmetName) {
  const lower = (text || '').toLowerCase();
  const helmetLower = helmetName.toLowerCase();
  if (lower.includes(helmetLower)) return true;
  const words = helmetLower.split(/\s+/).filter(w => w.length > 1);
  return words.every(w => new RegExp(`\\b${escapeRegex(w)}\\b`, 'i').test(lower));
}

// ── Strategy 1: Shopify predictive-search JSON API ───────────────────────────
// Returns null when the endpoint doesn't exist (not a Shopify store).

async function tryShopifySearch(vendor, helmet) {
  const q = encodeURIComponent(`${helmet} XL`);
  const url = `${vendor.baseUrl}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=20`;

  const data = await fetchJson(url);
  if (!data) return null;
  const products = data?.resources?.results?.products;
  if (!Array.isArray(products)) return null;

  const records = [];
  for (const product of products) {
    if (!isHelmetMatch(product.title || '', helmet)) continue;

    const variants = Array.isArray(product.variants) ? product.variants : [];
    const xlVariants = variants.filter(v =>
      (v.option1 || '').toUpperCase().includes('XL') ||
      (v.option2 || '').toUpperCase().includes('XL') ||
      (v.title || '').toUpperCase().includes('XL'),
    );

    const pricePairs = xlVariants.length > 0
      ? xlVariants.map(v => ({
          price: parseFloat(v.price),
          compareAt: parseFloat(v.compare_at_price) || parseFloat(product.compare_at_price_max) || 0,
        }))
      : [{ price: parseFloat(product.price), compareAt: parseFloat(product.compare_at_price_max) || 0 }];

    for (const { price, compareAt } of pricePairs) {
      const rec = buildRecord(helmet, vendor.name, price, compareAt, `${vendor.baseUrl}${product.url}`, 'shopify');
      if (rec) { records.push(rec); break; }
    }
  }

  return records;
}

// ── Strategy 2a: JSON-LD structured data ─────────────────────────────────────

function extractJsonLdProducts(html) {
  const products = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = data?.['@graph'] ? data['@graph'] : Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      if (node?.['@type'] === 'Product') products.push(node);
    }
  }
  return products;
}

function getPricePairFromOffer(offer) {
  let salePrice = null;
  let listPrice = null;
  const specs = offer.priceSpecification
    ? (Array.isArray(offer.priceSpecification) ? offer.priceSpecification : [offer.priceSpecification])
    : [];
  for (const spec of specs) {
    const p = parseFloat(spec.price);
    if (!p || isNaN(p)) continue;
    const type = (spec.priceType || '').toLowerCase();
    if (type.includes('list') || type.includes('regular') || type.includes('suggested')) listPrice = p;
    else if (type.includes('sale') || type.includes('actual') || type.includes('minimum')) salePrice = p;
  }
  if (salePrice === null) {
    const p = parseFloat(offer.price ?? offer.lowPrice);
    if (!isNaN(p) && p > 0) salePrice = p;
  }
  return { salePrice, listPrice };
}

function searchJsonLd(html, helmet, vendor, searchUrl) {
  const records = [];
  for (const product of extractJsonLdProducts(html)) {
    if (!isHelmetMatch(product.name || '', helmet)) continue;
    const rawOffers = product.offers;
    if (!rawOffers) continue;
    for (const offer of (Array.isArray(rawOffers) ? rawOffers : [rawOffers])) {
      const { salePrice, listPrice } = getPricePairFromOffer(offer);
      if (!salePrice) continue;
      const rec = buildRecord(helmet, vendor.name, salePrice, listPrice || 0, searchUrl, 'json-ld');
      if (rec) { records.push(rec); break; }
    }
  }
  return records;
}

// ── Strategy 2b: Cheerio HTML price-pair extraction ──────────────────────────

const SALE_SELS = [
  '.sale-price', '.price--sale', '.special-price', '.price-sale',
  '.price-item--sale', '.product__price--sale', '.price-box .special-price .price',
  '[class*="sale"][class*="price"]', '.current-price',
].join(', ');

const COMPARE_SELS = [
  '.compare-at-price', '.compare-price', '.was-price', '.price--compare',
  '.original-price', '.price-item--regular', '.price-box .old-price .price',
  '[class*="compare"][class*="price"]',
].join(', ');

const CONTAINER_SELS = [
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
  const records = [];
  $(CONTAINER_SELS).each((_, el) => {
    if (!isHelmetMatch($(el).text(), helmet)) return;
    const link = $(el).find('a[href]').first().attr('href') || '';
    const productUrl = link.startsWith('http') ? link : `${vendor.baseUrl}${link}`;
    const salePrice =
      parsePrice($(el).find(SALE_SELS).first().text()) ??
      parsePrice($(el).find('.price').first().text());
    const comparePrice =
      parsePrice($(el).find(COMPARE_SELS).first().text()) ??
      parsePrice($(el).find('s, del').first().text());
    if (!salePrice) return;
    const rec = buildRecord(helmet, vendor.name, salePrice, comparePrice || 0, productUrl || searchUrl, 'html');
    if (rec) records.push(rec);
  });
  return records;
}

// ── Vendor search orchestration ──────────────────────────────────────────────

async function searchVendor(vendor, helmet) {
  // Strategy 1 — Shopify JSON API
  const shopifyRecords = await tryShopifySearch(vendor, helmet);
  if (shopifyRecords !== null) return { records: shopifyRecords, via: 'shopify' };

  // Strategy 2 — Fetch the search results page
  const searchUrl = `${vendor.baseUrl}${vendor.searchPath}${encodeURIComponent(helmet + ' XL')}`;
  const { ok, status, body } = await fetchText(searchUrl);
  if (!ok || !body) return { records: [], via: `http-${status || 'err'}` };

  // 2a — JSON-LD
  const ldRecords = searchJsonLd(body, helmet, vendor, searchUrl);
  if (ldRecords.length > 0) return { records: ldRecords, via: 'json-ld' };

  // 2b — Cheerio
  const htmlRecords = searchCheerio(body, helmet, vendor, searchUrl);
  return { records: htmlRecords, via: htmlRecords.length > 0 ? 'html' : 'no-match' };
}

// ── Main search loop ─────────────────────────────────────────────────────────

async function runAllSearches() {
  const allRecords = [];
  const vendorStatuses = [];

  for (const vendor of VENDORS) {
    console.log(`\n>> ${vendor.name}`);
    const vendorRecords = [];
    const vias = new Set();

    for (const helmet of HELMETS) {
      const { records, via } = await searchVendor(vendor, helmet);
      vendorRecords.push(...records);
      vias.add(via);
      if (records.length > 0) {
        const best = Math.min(...records.map(r => r.price));
        console.log(`   ${helmet}: $${best.toFixed(0)} CAD [${via}]`);
      }
      await sleep(REQUEST_DELAY_MS);
    }

    allRecords.push(...vendorRecords);

    const isBlocked = [...vias].some(v => /^http-(403|429|0|err)$/.test(v));
    let statusStr;
    if (vendorRecords.length > 0) {
      const method = vias.has('shopify') ? 'Shopify API' : vias.has('json-ld') ? 'JSON-LD' : 'HTML';
      statusStr = `✓ ${method} — ${vendorRecords.length} price(s) found`;
    } else if (isBlocked) {
      statusStr = `✗ Blocked / no response (${[...vias].join(', ')})`;
    } else {
      statusStr = `~ Responded — no matching XL products found`;
    }

    vendorStatuses.push({ name: vendor.name, status: statusStr });
    console.log(`   → ${statusStr}`);
  }

  return { allRecords, vendorStatuses };
}

// ── Best prices per helmet ───────────────────────────────────────────────────

function computeBestPrices(allRecords) {
  const best = {};
  for (const rec of allRecords) {
    if (!best[rec.helmet] || rec.price < best[rec.helmet].price) {
      best[rec.helmet] = rec;
    }
  }
  return best;
}

function deduplicateRecords(records) {
  const seen = new Set();
  return records.filter(r => {
    const key = `${r.vendor}|${r.helmet}|${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Markdown output ──────────────────────────────────────────────────────────

function buildMarkdown(bestPerHelmet, uniqueRecords, vendorStatuses) {
  const now = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const deals = uniqueRecords
    .filter(r => r.isAlert)
    .sort((a, b) => b.discountPct - a.discountPct);

  let md = `# Helmet Price Tracker\n\n`;
  md += `*Updated: ${now}*\n\n`;
  md += `---\n\n`;

  // Deals section
  md += `## Active Deals — 40%+ Off\n\n`;
  if (deals.length === 0) {
    md += `*No deals meeting the 40% threshold were found in this run.*\n\n`;
  } else {
    md += `| Helmet | Price | Vendor | Discount | URL |\n`;
    md += `|--------|-------|--------|----------|-----|\n`;
    for (const d of deals) {
      const ref = d.refPrice ? `$${d.refPrice.toFixed(0)}` : `$${HELMET_MSRPS[d.helmet].toFixed(0)} MSRP`;
      md += `| ${d.helmet} (XL) | **$${d.price.toFixed(2)} CAD** | ${d.vendor} | ${d.discountPct.toFixed(1)}% off ${ref} | [link](${d.url}) |\n`;
    }
    md += '\n';
  }

  // Best prices table
  md += `## Lowest Available XL Prices\n\n`;
  md += `| Helmet | MSRP | Best Price | Vendor | Off MSRP | URL |\n`;
  md += `|--------|------|------------|--------|----------|-----|\n`;
  for (const helmet of HELMETS) {
    const msrp = HELMET_MSRPS[helmet];
    const best = bestPerHelmet[helmet];
    if (best) {
      const ref = best.refPrice || msrp;
      const pct = ((ref - best.price) / ref * 100).toFixed(1);
      const flag = best.isAlert ? ' 🔥' : '';
      md += `| ${helmet} | $${msrp.toFixed(0)} | **$${best.price.toFixed(2)}**${flag} | ${best.vendor} | ${pct}% | [link](${best.url}) |\n`;
    } else {
      md += `| ${helmet} | $${msrp.toFixed(0)} | *not found* | — | — | — |\n`;
    }
  }
  md += '\n';

  // Vendor diagnostics
  md += `## Vendor Status\n\n`;
  md += `| Vendor | Result |\n`;
  md += `|--------|--------|\n`;
  for (const vs of vendorStatuses) {
    md += `| ${vs.name} | ${vs.status} |\n`;
  }
  md += '\n';

  md += `---\n`;
  md += `*Searches ${VENDORS.length} vendors daily at 9 AM UTC · Discount threshold: 40% · Size: XL only*\n`;

  return md;
}

// ── Google Sheets (optional — only fires when deals exist and creds are set) ─

async function authenticate() {
  if (!GOOGLE_CREDENTIALS) return null;
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
        resource: { values: [['Timestamp', 'Helmet Model', 'Vendor', 'Price (CAD)', 'Discount %', 'Vendor URL']] },
      });
      console.log('Wrote sheet headers.');
    }
  } catch (err) {
    console.error('Sheet header init failed:', err.message);
  }
}

async function writeDealsToSheet(auth, deals) {
  if (!auth || !SPREADSHEET_ID) return;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const rows = deals.map(d => [
      new Date(d.timestamp).toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
      d.helmet,
      d.vendor,
      `$${parseFloat(d.price).toFixed(2)} CAD`,
      `${d.discountPct.toFixed(1)}%`,
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('==========================================');
  console.log('  Helmet Deal Finder');
  console.log('==========================================');
  console.log(`Helmets: ${HELMETS.length}  Vendors: ${VENDORS.length}  Threshold: ${(DISCOUNT_THRESHOLD * 100).toFixed(0)}%\n`);

  const { allRecords, vendorStatuses } = await runAllSearches();
  const uniqueRecords = deduplicateRecords(allRecords);
  const bestPerHelmet = computeBestPrices(uniqueRecords);
  const deals = uniqueRecords.filter(r => r.isAlert);

  console.log('\n==========================================');
  console.log(`Total price records: ${uniqueRecords.length}`);
  console.log(`Active deals (40%+): ${deals.length}`);

  // Always write PRICES.md — even if empty, so the file shows the run happened
  const markdown = buildMarkdown(bestPerHelmet, uniqueRecords, vendorStatuses);
  fs.writeFileSync(OUTPUT_FILE, markdown, 'utf8');
  console.log(`\nWrote ${OUTPUT_FILE}`);

  // Google Sheets — only for 40%+ deals, only when credentials are configured
  if (deals.length > 0) {
    const auth = await authenticate();
    if (auth) {
      await ensureSheetHeaders(auth);
      await writeDealsToSheet(auth, deals);
    } else {
      console.log('GOOGLE_CREDENTIALS not set — deals recorded in PRICES.md only.');
    }
  }

  // Console summary
  console.log('\nSummary:');
  for (const helmet of HELMETS) {
    const best = bestPerHelmet[helmet];
    if (best) {
      const alert = best.isAlert ? '  *** DEAL ***' : '';
      console.log(`  ${helmet}: $${best.price.toFixed(2)} @ ${best.vendor}${alert}`);
    } else {
      console.log(`  ${helmet}: not found`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
