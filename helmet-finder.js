#!/usr/bin/env node

/**
 * Motorcycle Helmet Deal Finder
 * Searches multiple vendors daily for XL modular helmets at 40%+ discount
 * Sends email alerts when deals found
 */

const https = require('https');
const nodemailer = require('nodemailer');

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
const USER_EMAIL = process.env.ALERT_EMAIL || 'ben@benschreiber.ca';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// In-memory storage for deals found (in production, use a database)
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
 * Send email notification
 */
async function sendEmailAlert(deals) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('SMTP credentials not configured. Skipping email.');
    console.log(`Found ${deals.length} deals:`, deals);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  const htmlContent = generateEmailHtml(deals);

  const mailOptions = {
    from: SMTP_USER,
    to: USER_EMAIL,
    subject: `🏍️ Helmet Deal Alert: ${deals.length} deals found (40%+ off)`,
    html: htmlContent,
    text: generateEmailText(deals)
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${USER_EMAIL}`);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

/**
 * Generate HTML email content
 */
function generateEmailHtml(deals) {
  const rows = deals.map(deal => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;">${deal.helmet}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;">${deal.vendor}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd; font-weight: bold;">$${deal.price.toFixed(2)}</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd; color: green; font-weight: bold;">${deal.discount}% off</td>
      <td style="padding: 10px; border-bottom: 1px solid #ddd;"><a href="${deal.url}">View</a></td>
    </tr>
  `).join('');

  return `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>🏍️ Motorcycle Helmet Deals Found!</h2>
        <p>Found <strong>${deals.length}</strong> deals at 40%+ discount for XL modular helmets:</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background-color: #f2f2f2;">
              <th style="padding: 10px; text-align: left;">Helmet Model</th>
              <th style="padding: 10px; text-align: left;">Vendor</th>
              <th style="padding: 10px; text-align: left;">Price (CAD)</th>
              <th style="padding: 10px; text-align: left;">Discount</th>
              <th style="padding: 10px; text-align: left;">Link</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        
        <p style="font-size: 0.9em; color: #666;">
          Last checked: ${new Date().toLocaleString()}<br>
          Threshold: 40% off minimum
        </p>
      </body>
    </html>
  `;
}

/**
 * Generate plain text email content
 */
function generateEmailText(deals) {
  let text = `MOTORCYCLE HELMET DEALS FOUND!\n\nFound ${deals.length} deals at 40%+ discount:\n\n`;
  
  deals.forEach(deal => {
    text += `${deal.helmet}\n`;
    text += `  Vendor: ${deal.vendor}\n`;
    text += `  Price: $${deal.price.toFixed(2)} CAD\n`;
    text += `  Discount: ${deal.discount}% off\n`;
    text += `  Link: ${deal.url}\n\n`;
  });
  
  return text;
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
    
    // Send email alert
    await sendEmailAlert(dealsFound);
  } else {
    console.log('No deals found at this time.');
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
