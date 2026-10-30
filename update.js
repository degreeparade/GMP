const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://www.investorgain.com/report/live-ipo-gmp/331/ipo/';
const LIVE_TABLE_URL = 'https://www.investorgain.com/report/ipo-gmp-live/331/';
const REGISTRAR_URLS = {
  'link intime': 'https://linkintime.co.in/initial_offer/public-issues.html',
  'mufg intime': 'https://linkintime.co.in/initial_offer/public-issues.html',
  'kfin technologies': 'https://ris.kfintech.com/ipostatus/',
  kfintech: 'https://ris.kfintech.com/ipostatus/',
  'bigshare services': 'https://ipo.bigshareonline.com/IPO_Status.html',
  'cameo corporate': 'https://ipo.cameoindia.com/',
  maashitla: 'https://maashitla.com/allotment-status',
  skyline: 'https://www.skylinerta.com/ipo.php'
};

function getSentimentRating(gmpPercent) {
  if (!Number.isFinite(gmpPercent)) {
    return { stars: '☆☆☆☆☆', score: 'N/A', sentiment: 'Awaiting GMP' };
  }
  if (gmpPercent >= 50) return { stars: '★★★★★', score: '5.0', sentiment: 'Very Strong' };
  if (gmpPercent >= 25) return { stars: '★★★★☆', score: '4.0', sentiment: 'Healthy' };
  if (gmpPercent >= 10) return { stars: '★★★☆☆', score: '3.0', sentiment: 'Moderate' };
  if (gmpPercent >= 0) return { stars: '★★☆☆☆', score: '2.0', sentiment: 'Subdued' };
  return { stars: '★☆☆☆☆', score: '1.0', sentiment: 'Discount Expected' };
}

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function numbers(value) {
  return clean(value).match(/\d+(\.\d+)?/g) || [];
}

function highestNumber(...values) {
  const parsed = values
    .flatMap(numbers)
    .map(Number)
    .filter(Number.isFinite);
  return parsed.length ? Math.max(...parsed) : 0;
}

function cleanName(value) {
  return clean(value)
    .replace(/L@[\d.]+(?:\s*\([^)]*\))?/gi, '')
    .replace(/\b(?:IPOO|SMEO|IPOU|SMEU|IPOC|SMEC|BSE|NSE|IPO)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGmp(value) {
  const text = clean(value);
  const match = text.match(/₹?\s*([-+]?\d+(\.\d+)?)/);
  if (!match || /--/.test(text)) return { value: 0, reported: false };
  return { value: Number(match[1]), reported: true };
}

function parsePercent(value) {
  const match = clean(value).match(/\(([-+]?\d+(\.\d+)?)%\)/);
  return match ? Number(match[1]) : null;
}

function parseDate(value, referenceDate = new Date()) {
  const matches = clean(value).match(/\b\d{1,2}[-/\s][A-Za-z]{3,9}\b/g) || [];
  const match = matches[0]?.match(/(\d{1,2})[-/\s]([A-Za-z]{3,9})/);
  if (!match) return null;
  const month = new Date(`${match[2]} 1, ${referenceDate.getFullYear()}`).getMonth();
  if (!Number.isInteger(month)) return null;
  const date = new Date(referenceDate.getFullYear(), month, Number(match[1]));
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateBounds(value, referenceDate) {
  const matches = clean(value).match(/\b\d{1,2}[-/\s][A-Za-z]{3,9}\b/g) || [];
  return {
    start: parseDate(matches[0] || '', referenceDate),
    end: parseDate(matches[matches.length - 1] || '', referenceDate)
  };
}

function statusFor(rawName, rowText, openText, closeText) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const openBounds = dateBounds(openText, today);
  const closeBounds = dateBounds(closeText, today);
  const openDate = openBounds.start;
  const closeDate = closeBounds.end || openBounds.end || openDate;
  if (closeDate) closeDate.setHours(23, 59, 59, 999);
  const text = `${rawName} ${rowText}`;

  if (openDate && closeDate) {
    if (today < openDate) return { value: 'upcoming', label: 'Upcoming', color: 'yellow' };
    if (today <= closeDate && today >= openDate) return { value: 'open', label: 'Open Now', color: 'green' };
    return { value: 'closed', label: 'Closed', color: 'red' };
  }
  if (openDate && today < openDate) {
    return { value: 'upcoming', label: 'Upcoming', color: 'yellow' };
  }
  if (openDate && openDate < today) {
    return { value: 'closed', label: 'Closed', color: 'red' };
  }
  if (/(?:IPOC|SMEC|L@|Listed|Allotted|\bclosed\b)/i.test(text)) {
    return { value: 'closed', label: 'Closed', color: 'red' };
  }
  if (/(?:IPOO|SMEO|\bopen\b)/i.test(text)) {
    return { value: 'open', label: 'Open Now', color: 'green' };
  }
  return { value: 'upcoming', label: 'Upcoming', color: 'yellow' };
}

function registrarDetails(value) {
  const text = clean(value).toLowerCase();
  const registrarName = Object.keys(REGISTRAR_URLS).find((name) => text.includes(name));
  if (!registrarName) {
    return { name: 'Registrar details unavailable', url: 'https://www.sebi.gov.in/' };
  }
  const displayName = registrarName === 'kfintech'
    ? 'KFintech'
    : registrarName === 'mufg intime'
      ? 'Link Intime'
      : registrarName.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { name: displayName, url: REGISTRAR_URLS[registrarName] };
}

async function fetchRegistrar(detailUrl) {
  if (!detailUrl) return registrarDetails('');
  try {
    const html = await fetchPage(new URL(detailUrl, SOURCE_URL).toString());
    const $ = cheerio.load(html);
    const structured = $('script').map((_, script) => $(script).html()).get().join(' ');
    return registrarDetails(`${$('body').text()} ${structured}`);
  } catch (error) {
    console.warn(`Registrar lookup failed for ${detailUrl}: ${error.message}`);
    return registrarDetails('');
  }
}

async function parseRows(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const rawName = clean(cells.eq(0).text());
    if (!rawName || /^name$/i.test(rawName)) return;

    const rowText = clean($(row).text());
    const name = cleanName(cells.eq(0).find('a').attr('title') || rawName);
    if (!name) return;

    const gmpText = clean(cells.eq(1).text());
    const gmp = parseGmp(gmpText);
    const priceText = clean(cells.eq(4).text() || cells.eq(2).text());
    const price = highestNumber(priceText);
    const percentFromSource = parsePercent(gmpText);
    const gmpPercent = gmp.reported && percentFromSource !== null
      ? percentFromSource
      : gmp.reported && price > 0
        ? Number(((gmp.value / price) * 100).toFixed(2))
        : null;
    const rating = getSentimentRating(gmpPercent);
    const openText = clean(cells.eq(7).text() || cells.eq(6).text()).split(/GMP:/i)[0].trim();
    const closeText = clean(cells.eq(8).text()).split(/GMP:/i)[0].trim();
    const dates = [openText, closeText].filter(Boolean).join(' to ') || 'TBA';
    const status = statusFor(rawName, rowText, openText, closeText);
    const estListing = `₹${Math.round(price + gmp.value)}`;

    rows.push({
      detailUrl: cells.eq(0).find('a').attr('href') || '',
      record: {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rows.length + 1}`,
      name,
      category: /SME/i.test(rawName) ? 'sme' : 'mainboard',
      status: status.value,
      statusLabel: status.label,
      statusColor: status.color,
      priceBand: `₹${price}`,
      gmp: gmp.reported ? `${gmp.value >= 0 ? '+' : ''}₹${gmp.value} (${gmpPercent}%)` : 'Awaiting GMP',
      gmpVal: gmp.value,
      gmpPercent: gmpPercent === null ? 'N/A' : gmpPercent,
      estListing,
      dates,
      ratingStars: rating.stars,
      ratingScore: rating.score,
      sentiment: rating.sentiment,
      registrarName: 'Registrar details unavailable',
      allotmentUrl: 'https://www.sebi.gov.in/'
      }
    });
  });

  return Promise.all(rows.map(async ({ detailUrl, record }) => {
    const registrar = await fetchRegistrar(detailUrl);
    return { ...record, registrarName: registrar.name, allotmentUrl: registrar.url };
  }));
}

async function fetchPage(url = SOURCE_URL) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache'
    },
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });
  if (response.status >= 300 && response.headers.location) {
    return fetchPage(new URL(response.headers.location, url).toString());
  }
  return response.data;
}

async function scrapeIPOData() {
  try {
    console.log('Fetching live IPO GMP data...');
    let ipos = await parseRows(await fetchPage());
    if (!ipos.length) ipos = await parseRows(await fetchPage(LIVE_TABLE_URL));
    if (!ipos.length) throw new Error('No IPO table rows found.');

    const statusWeight = { open: 1, upcoming: 2, closed: 3 };
    ipos.sort((a, b) => statusWeight[a.status] - statusWeight[b.status]);

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'data.json'), `${JSON.stringify(ipos, null, 2)}\n`);

    const mainCount = ipos.filter((ipo) => ipo.category === 'mainboard').length;
    const smeCount = ipos.filter((ipo) => ipo.category === 'sme').length;
    const openCount = ipos.filter((ipo) => ipo.status === 'open').length;
    const closedCount = ipos.filter((ipo) => ipo.status === 'closed').length;
    console.log(`Success! Parsed ${ipos.length} total IPOs.`);
    console.log(`Breakdown: ${mainCount} Mainboard | ${smeCount} SME`);
    console.log(`Status: ${openCount} Open Now | ${closedCount} Closed`);
  } catch (error) {
    console.error(`Error updating data: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

scrapeIPOData();
