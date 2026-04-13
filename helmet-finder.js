#!/usr/bin/env node

const https = require('https');
const { google } = require('googleapis');

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

const DISCOUNT_THRESHOLD = 0.40;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

let dealsFound = [];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function searchVendor(vendor, helmet) {
  try {
    const searchUrl = `${vendor.url}/search?q=${encodeURIComponent(helmet + ' XL')}`;
    const html = await fetchUrl(searchUrl);
    const deals = parseHtmlForDeals(html, helmet, vendor);
    return deals;
  } catch (error) {
    console.error(`Error searching ${vendor.name} for ${helmet}:`, error.message);
    return [];
  }
}

function parseHtmlForDeals(html, helmet, vendor) {
  const deals = [];
  const priceRegex = /[\$CAD]*\s*(\d+(?:,\d{3})*\.?\d*)/g;
  let match;
  
  while ((match = priceRegex.exec(html)) !== null) {
    const price = parseFloat(match[1].replace(/,/g, ''));
    const estimatedMsrp = 600;
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

async function initializeSheet(auth) {
  if (!auth || !SPREADSHEET_ID) {
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A1:F1'
    });

    if (!result.data.values || result.data.values.length === 0) {
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
      console.log('Initialized Google Sheet headers');
    }
  } catch (error) {
    console.error('Error initializing sheet:', error.message);
  }
}

async function writeToGoogleSheets(auth, deals) {
  if (!auth || !SPREADSHEET_ID) {
    console.log('Skipping Google Sheets write.');
    return;
  }

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const rows = deals.map(deal => [
      new Date(deal.timestamp).toLocaleString(),
      deal.helmet,
      deal.vendor,
      `$${deal.price.toFixed(2)}`,
      `${deal.discount}%`,
      deal.url
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deals!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: rows
      }
    });

    console.log(`Wrote ${deals.length} deals to Google Sheets`);
  } catch (error) {
    console.error('Error writing to Google Sheets:', error.message);
  }
}

async function main() {
  console.log('Starting Helmet Deal Finder...');
  console.log(`Searching ${HELMETS.length} helmets across ${VENDORS.length} vendors`);
  console.log(`Minimum discount threshold: ${(DISCOUNT_THRESHOLD * 100).toFixed(0)}%\n`);

  dealsFound = [];

  for (const vendor of VENDORS) {
    console.log(`Searching ${vendor.name}...`);
    
    for (const helmet of HELMETS) {
      const deals = await searchVendor(vendor, helmet);
      dealsFound.push(...deals);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`\nSearch complete! Found ${dealsFound.length} deals.`);

  if (dealsFound.length > 0) {
    console.log('\nDeals found:');
    dealsFound.forEach(deal => {
      console.log(`${deal.helmet} at ${deal.vendor}: $${deal.price.toFixed(2)} (${deal.discount}% off)`);
    });
    
    const auth = await authenticate();
    if (auth) {
      await initializeSheet(auth);
      await writeToGoogleSheets(auth, dealsFound);
    }
  } else {
    console.log('No deals found at this time.');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
