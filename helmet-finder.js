#!/usr/bin/env node

/**
 * Motorcycle Helmet Deal Finder
 * Searches multiple vendors daily for XL modular helmets at 40%+ discount
 * Writes results to Google Sheets
 */

const https = require('https');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Configuration
const HELMETS = [
  'Bell SRT Modular',
  'Shoei Neotec 3',
  'Shoei Neotec 2',
  'HJC RPHA 91',
  'HJC i91',
  'HJC i100',
  'AGV sportmodular',
  'AGV tourmodular',
  'LS2 Advant X',
  'LS2 Advant X 2 Carbon'
];

const VENDORS = [
  { name: 'FortNine', url: 'https://fortnine.ca' },
  { name: 'GP Bikes', url: 'https://www.gpbikes.com' },
  { name: 'ADM Sport', url: 'https://admsport.com' },
  { name: 'Studio Cycle', url: 'https://studiocycle.ca' },
  { name: 'RidingGear', url: 'https://ridinggear.ca' },
  { name: 'Royal Distributing', url: 'https://royaldistributing.com' },
  { name: 'Champion Helmets', url: 'https://championhelmets.com' },
  { name: 'Peakboys', url: 'https://peakboys.ca' },
  { name: 'Blackfoot Online', url: 'https://blackfootonline.ca' },
  { name: 'Joe Rocket Canada', url: 'https://joerocket.ca' },
  { name: 'Speed & Strength', url: 'https://ssgear.ca' },
  { name: 'RevZilla', url: 'https://www.revzilla.com' },
  { name: 'Amazon.ca', url: 'https://amazon.ca' }
];

const DISCOUNT_THRESHOLD = 0.40; // 40% off
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

let dealsFound = [];

/**
 * Fetch a URL and return HTML content
 */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Search for a helmet model on a vendor's website
 * Returns array of deals found
 */
async function searchVendor(vendor, helmet) {
  try {
    const searchUrl = `${vendor.url}/search?q=${encodeURIComponent(helmet + ' XL')}`;
    const html = await fetchUrl(searchUrl);
    
    // Parse HTML for prices (simplified - in production use cheerio/jsdom)
    const deals = parseHtmlForDeals(html, helmet, vendor);
    return deals;
  } catch (error) {
    console.error(`Error searching ${vendor.name} for ${helmet}:`, error.message);
    return [];
  }
}

/**
 * Parse HTML to find deals
 * This is simplified - in production, use a proper HTML parser
 */
function parseHtmlForDeals(html, helmet, vendor) {
  const deals = [];
  
  // Look for price patterns (simplified regex)
  const priceRegex = /[\$CAD]*\s*(\d+(?:,\d{3})*\.?\d*)/g;
  let match;
  
  while ((match = priceRegex.exec(html)) !== null) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    
    // Rough MSRP estimates for modular helmets (CAD)
    const estimatedMsrp = 600; // Average modular helmet MSRP
    const discountPercent = (1 - (price / estimatedMsrp));
    
    if (discountPercent >= DISCOUNT_THRESHOLD) {
      deals.push({
        helmet: helmet,
        vendor: vendor.name,
        price: price,
        discount: (discountPercent * 100).toFixed(1),
        url: vendor.url,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  return deals;
}

/**
 * Authenticate with Google Sheets API
 */
async function authenticate() {
  if (!GOOGLE_CREDENTIALS) {
    console.log('GOOGLE_CREDENTIALS not set. Skipping Google Sheets update.');
    return null;
  }

  try {
    const credentials = JSON.parse(GOOGLE_CREDENTIALS);
    
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return auth;
  } catch (error) {
    console.error('Failed to authenticate with Google:', error.message);
    return null;
  }
}

/**
 * Write deals to Google Sheets
 */
async function writeToGoogleSheets(auth, deals) {
  if (!auth || !SPREADSHEET_ID) {
    console.log('Skipping Google Sheets write.');
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    // Prepare data for sheet
    const rows = deals.map(deal => [
      new Date(deal.timestamp).toLocaleString(),
      deal.helmet,
      deal.vendor,
      `$${deal.price.toFixed(2)}`,
      `${deal.discount}%`,
      deal.url
    ]);

    // Append to sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: rows
      }
    });

    console.log(`✅ Wrote ${deals.length} deals to Google Sheets`);
  } catch (error) {
    console.error('Error writing to Google Sheets:', error.message);
  }
}

/**
 * Initialize Google Sheet headers (if needed)
 */
async function initializeSheet(auth) {
  if (!auth || !SPREADSHEET_ID) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });

    // Check if headers exist
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A1:F1'
    });

    if (!result.data.values || result.data.values.length === 0) {
      // Add headers
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Deals!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[
            'Timestamp',
            'Helmet Model',
            'Vendor',
            'Price (CAD)',
            'Discount',
            'Vendor URL'
          ]]
        }
      });

      console.log('✅ Initialized Google Sheet headers');
    }
  } catch (error) {
    console.error('Error initializing sheet:', error.message);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🏍️ Starting Helmet Deal Finder...');
  console.log(`Searching for: ${HELMETS.length} helmet models`);
  console.log(`Vendors: ${VENDORS.length} retailers`);
  console.log(`Minimum discount: ${(DISCOUNT_THRESHOLD * 100).toFixed(0)}%\n`);

  dealsFound = [];

  // Search all vendors and helmets
  for (const vendor of VENDORS) {
    console.log(`\nSearching ${vendor.name}...`);
    
    for (const helmet of HELMETS) {
      const deals = await searchVendor(vendor, helmet);
      dealsFound.push(...deals);
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Report results
  console.log(`\n✅ Search complete!`);
  console.log(`Found ${dealsFound.length} deals matching criteria.`);

  if (dealsFound.length > 0) {
    console.log('\nDeals:');
    dealsFound.forEach(deal => {
      console.log(`  • ${deal.helmet} at ${deal.vendor}: $${deal.price.toFixed(2)} (${deal.discount}% off)`);
    });
    
    // Write to Google Sheets
    const auth = await authenticate();
    if (auth) {
      await initializeSheet(auth);
      await writeToGoogleSheets(auth, dealsFound);
    }
  } else {
    console.log('No deals found at this time.');
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
