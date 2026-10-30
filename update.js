const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

function getSentimentRating(gmpPercent) {
  if (isNaN(gmpPercent) || gmpPercent === null) {
    return { stars: '☆☆☆☆☆', score: 'N/A', sentiment: 'Awaiting GMP' };
  }
  if (gmpPercent >= 50) return { stars: '★★★★★', score: '5.0', sentiment: 'Very Strong' };
  if (gmpPercent >= 25) return { stars: '★★★★☆', score: '4.0', sentiment: 'Healthy' };
  if (gmpPercent >= 10) return { stars: '★★★☆☆', score: '3.0', sentiment: 'Moderate' };
  if (gmpPercent >= 0)  return { stars: '★★☆☆☆', score: '2.0', sentiment: 'Subdued' };
  return { stars: '★☆☆☆☆', score: '1.0', sentiment: 'Discount Expected' };
}

async function scrapeIPOData() {
  try {
    console.log('Fetching live IPO GMP data...');
    const url = 'https://www.investorgain.com/report/live-ipo-gmp/331/ipo/';
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    const ipos = [];

    // InvestorGain reports table
    $('table tbody tr').each((_, row) => {
      const rowText = $(row).text().trim();
      if (!rowText || rowText.includes('Advertisement') || rowText.includes('Loading')) return;

      const rawNameCell = $(row).find('td:nth-child(1)').text().trim().replace(/\s+/g, ' ');
      if (!rawNameCell || rawNameCell.toLowerCase() === 'name') return;

      const gmpCell = $(row).find('td:nth-child(2)').text().trim();
      const priceCell = $(row).find('td:nth-child(5)').text().trim() \vert{}\vert{}$(row).find('td:nth-child(3)').text().trim();
      const datesCell = $(row).find('td:nth-child(8)').text().trim() \vert{}\vert{}$(row).find('td:nth-child(7)').text().trim();

      // 1. Detect Category: Mainboard vs SME
      const isSME = /sme/i.test(rawNameCell);
      const category = isSME ? 'sme' : 'mainboard';

      // 2. Detect Status: Open vs Upcoming vs Closed
      let status = 'upcoming';
      let statusLabel = 'Upcoming';
      let statusColor = 'yellow';

      if (rawNameCell.includes('IPOO') || rawNameCell.includes('SMEO') || /open/i.test(rowText)) {
        status = 'open';
        statusLabel = 'Open Now';
        statusColor = 'green';
      } else if (
        rawNameCell.includes('IPOC') || rawNameCell.includes('SMEC') ||
        rawNameCell.includes('L@') || rawNameCell.includes('Listed') ||
        rawNameCell.includes('Allotted') || /closed/i.test(rowText)
      ) {
        status = 'closed';
        statusLabel = 'Closed';
        statusColor = 'red';
      }

      // 3. Clean Display Name (remove raw tracker codes)
      const cleanName = rawNameCell
        .replace(/IPOO|SMEO|IPOU|SMEU|IPOC|SMEC|Allotted/g, '')
        .replace(/L@[\d.]+(\s*\(\d+.*?\))?/g, '')
        .replace(/\b(BSE|NSE|SME|IPO)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanName || cleanName.length < 2) return;

      // 4. Extract Price and GMP numbers
      const priceMatch = priceCell.match(/\d+(\.\d+)?/);
      const price = priceMatch ? parseFloat(priceMatch[0]) : 100;

      let gmp = 0;
      let gmpPercent = 0;
      const gmpMatch = gmpCell.match(/₹?([+-]?\d+(\.\d+)?)/);
      if (gmpMatch && !gmpCell.includes('--')) {
        gmp = parseFloat(gmpMatch[1]);
      }

      const percentMatch = gmpCell.match(/\(([-+]?\d+(\.\d+)?)\%\)/);
      if (percentMatch) {
        gmpPercent = parseFloat(percentMatch[1]);
      } else if (price > 0 && gmp !== 0) {
        gmpPercent = Math.round((gmp / price) * 100);
      }

      const rating = getSentimentRating(gmpPercent);
      const estListing = Math.round(price + gmp);

      ipos.push({
        id: Math.random().toString(36).substr(2, 9),
        name: cleanName,
        category: category,
        status: status,
        statusLabel: statusLabel,
        statusColor: statusColor,
        priceBand: `₹${price}`,
        gmp: gmp !== 0 ? `${gmp >= 0 ? '+' : ''}₹${gmp} (${gmpPercent}%)` : '₹0 (0%)',
        gmpVal: gmp,
        estListing: `₹${estListing}`,
        dates: datesCell || 'TBA',
        ratingStars: rating.stars,
        ratingScore: rating.score,
        sentiment: rating.sentiment,
        applyUrl: "https://your-broker-affiliate-link.com"
      });
    });

    // Sort: Open first, then Upcoming, then Closed
    const statusWeight = { 'open': 1, 'upcoming': 2, 'closed': 3 };
    ipos.sort((a, b) => statusWeight[a.status] - statusWeight[b.status]);

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

    fs.writeFileSync(path.join(publicDir, 'data.json'), JSON.stringify(ipos, null, 2));
    
    const mainCount = ipos.filter(i => i.category === 'mainboard').length;
    const smeCount = ipos.filter(i => i.category === 'sme').length;
    const openCount = ipos.filter(i => i.status === 'open').length;
    const closedCount = ipos.filter(i => i.status === 'closed').length;

    console.log(`✅ Success! Parsed ${ipos.length} total IPOs.`);
    console.log(`📊 Breakdown: ${mainCount} Mainboard | ${smeCount} SME`);
    console.log(`🚦 Status: ${openCount} Open Now | ${closedCount} Closed`);
  } catch (err) {
    console.error('❌ Error updating data:', err.message);
  }
}

scrapeIPOData();