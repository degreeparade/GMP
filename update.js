const fs = require("node:fs/promises");
const path = require("node:path");
const axios = require("axios");
const cheerio = require("cheerio");

const SOURCES = {
  issues: "https://www.ipo360.in/gmp",
  gmp: "https://www.ipo360.in/gmp",
};
const headers = {
  "User-Agent":
    "Mozilla/5.0 (compatible; IndianIpoTracker/1.0; +https://github.com/)",
  Accept: "text/html,application/xhtml+xml",
};

function clean(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function key(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\b(limited|ltd|ipo|public issue)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function displayName(value) {
  return clean(value).replace(/\s+ipo\b.*$/i, "").trim() || clean(value);
}

function categoryFromName(value) {
  return /\bSME\b/i.test(value) ? "sme" : "mainboard";
}

function number(value) {
  const match = clean(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function dateRange(value) {
  const text = clean(value);
  const dates = text.match(/\d{1,2}(?:[-/]\d{1,2})?(?:\s+[A-Za-z]{3,9})?(?:[-/]\d{1,2})?(?:\s+[A-Za-z]{3,9})?(?:[-/]\d{2,4})?/g);
  if (!dates) return text || "TBA";
  return dates.join(" - ");
}

function closingDate(value) {
  const text = clean(value);
  const match = text.match(/(\d{1,2})(?:[-/]\d{1,2})?\s+([A-Za-z]{3,9})/);
  if (!match) return null;
  const year = new Date().getFullYear();
  const date = new Date(`${match[1]} ${match[2]} ${year} 23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function findColumn(headers, candidates) {
  return headers.findIndex((header) =>
    candidates.some((candidate) => header.includes(candidate))
  );
}

function tables(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $("table").each((_, table) => {
    const tableRows = [];
    $(table)
      .find("tr")
      .each((__, row) => {
        const cells = $(row)
          .find("th,td")
          .map((___, cell) => clean($(cell).text()))
          .get();
        if (cells.length > 1) tableRows.push(cells);
      });
    if (tableRows.length > 1) rows.push(tableRows);
  });
  return rows;
}

function parseIssues(html) {
  const results = [];
  for (const rows of tables(html)) {
    const header = rows[0].map((cell) => cell.toLowerCase());
    const nameIndex = findColumn(header, ["ipo name", "company", "name"]);
    const priceIndex = findColumn(header, ["price band", "price"]);
    const dateIndex = findColumn(header, ["open", "issue date", "dates"]);
    if (nameIndex < 0 || priceIndex < 0) continue;

    for (const row of rows.slice(1)) {
      const name = displayName(row[nameIndex]);
      const rawName = clean(row[nameIndex]);
      const priceText = clean(row[priceIndex]);
      if (!name || !priceText || name.toLowerCase() === "company") continue;
      const prices = priceText.match(/\d[\d,]*(?:\.\d+)?/g) || [];
      const low = prices.length > 1 ? number(prices[0]) : number(priceText);
      const high = prices.length > 1 ? number(prices[prices.length - 1]) : low;
      if (!high) continue;
      results.push({
        name,
        category: categoryFromName(rawName),
        dates: dateRange(dateIndex >= 0 ? row[dateIndex] : ""),
        closingDate: closingDate(rawName),
        priceBand: low === high ? `₹${high}` : `₹${low} - ₹${high}`,
        issuePrice: high,
      });
    }
  }
  return results;
}

function parseGmp(html) {
  const results = [];
  for (const rows of tables(html)) {
    const header = rows[0].map((cell) => cell.toLowerCase());
    const nameIndex = findColumn(header, ["ipo name", "company", "name"]);
    const gmpIndex = findColumn(header, ["gmp", "grey market"]);
    const priceIndex = findColumn(header, ["price", "upper"]);
    if (nameIndex < 0 || gmpIndex < 0) continue;

    for (const row of rows.slice(1)) {
      const name = displayName(row[nameIndex]);
      const gmpValue = number(row[gmpIndex]);
      if (!name || gmpValue === null) continue;
      results.push({
        name,
        gmp: gmpValue,
        issuePrice: priceIndex >= 0 ? number(row[priceIndex]) : null,
      });
    }
  }
  return results;
}

function rating(percent) {
  if (percent >= 40) return 5;
  if (percent >= 25) return 4;
  if (percent >= 10) return 3;
  if (percent >= 0) return 2;
  return 1;
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    headers,
    timeout: 30000,
    responseType: "text",
  });
  return response.data;
}

async function main() {
  const [issueHtml, gmpHtml] = await Promise.all([
    fetchPage(SOURCES.issues),
    fetchPage(SOURCES.gmp),
  ]);
  const issues = parseIssues(issueHtml);
  const gmps = parseGmp(gmpHtml);
  if (!issues.length) throw new Error("No IPO issue rows were found in the issue source.");
  if (!gmps.length) throw new Error("No GMP rows were found in the GMP source.");

  const gmpByName = new Map(gmps.map((item) => [key(item.name), item]));
  const data = issues
    .map((issue) => {
      const gmp = gmpByName.get(key(issue.name));
      if (!gmp) return null;
      const issuePrice = issue.issuePrice || gmp.issuePrice;
      if (!issuePrice) return null;
      const gmpPercent = Number(((gmp.gmp / issuePrice) * 100).toFixed(2));
      return {
        name: issue.name,
        category:
          issue.closingDate && issue.closingDate < new Date()
            ? "past"
            : issue.category,
        dates: issue.dates,
        priceBand: issue.priceBand,
        issuePrice,
        gmp: gmp.gmp,
        gmpPercent,
        listingEstimate: issuePrice + gmp.gmp,
        rating: rating(gmpPercent),
        ratingLabel:
          gmpPercent >= 50
            ? "Strong Demand"
            : gmpPercent >= 25
              ? "Healthy Demand"
              : gmpPercent >= 10
                ? "Moderate"
                : gmpPercent >= 0
                  ? "Subdued"
                  : "Discount Expected",
        applyUrl: `https://example.com/affiliate-broker?ipo=${encodeURIComponent(issue.name)}`,
        source: "IPO360",
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);

  if (!data.length) {
    throw new Error("Issue and GMP tables had no matching IPO names.");
  }
  const output = path.join(__dirname, "public", "data.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Saved ${data.length} IPO records to ${output}`);
}

main().catch((error) => {
  console.error(`IPO update failed: ${error.message}`);
  process.exitCode = 1;
});
