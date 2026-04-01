/**
 * dice.mjs — Dice.com job search via Playwright (no API key needed)
 * Data is server-side rendered — requires a real browser context.
 * Uses Playwright Chromium.
 */

import { chromium } from 'playwright';

const DICE_BASE = 'https://www.dice.com';

const EXCLUDED_TYPES = ['CONTRACTS', 'THIRD_PARTY', 'PARTTIME'];
const EXCLUDED_TITLE_TERMS = ['associate ', 'junior ', ' i ', '(i)', 'intern', 'temp ', 'contract '];

/**
 * searchDice(query, options) → Array of normalized job objects
 * options: { limit, remoteOnly, excludeContract, postedWithin }
 * postedWithin: 'ONE' (today), 'THREE' (3 days), 'SEVEN' (7 days)
 */
export async function searchDice(query, options = {}) {
  const {
    limit = 20,
    remoteOnly = true,
    excludeContract = true,
    postedWithin = 'THREE',
  } = options;

  const params = new URLSearchParams({ q: query, page: '1', pageSize: String(Math.min(limit, 20)) });
  if (remoteOnly) params.set('filters.workplaceTypes', 'Remote');
  if (postedWithin) params.set('filters.postedDate', postedWithin);

  const url = `${DICE_BASE}/jobs?${params}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  let raw = [];
  try {
    const page = await context.newPage();

    // Random delay before loading
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
    await page.goto(url, { timeout: 25000, waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Extract job data from Next.js SSR payload embedded in page
    raw = await page.evaluate(() => {
      // Find the __next_f push calls that contain job data
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const text = script.textContent || '';
        // Look for the large data payload that has jobList.data
        const match = text.match(/"jobList":\{"data":\[(\{.+?\})\]/s);
        if (match) {
          try {
            // Try to extract the full data array
            const startIdx = text.indexOf('"jobList":{"data":[');
            if (startIdx === -1) continue;
            // Find matching bracket
            let depth = 0, i = startIdx + '"jobList":{"data":'.length;
            const arrStart = i;
            for (; i < text.length; i++) {
              if (text[i] === '[') depth++;
              else if (text[i] === ']') { depth--; if (depth === 0) break; }
            }
            const arr = JSON.parse(text.slice(arrStart, i + 1));
            if (Array.isArray(arr) && arr.length > 0) return arr;
          } catch { /* try next */ }
        }
      }

      // Fallback: extract from data-* attributes on job cards
      const cards = Array.from(document.querySelectorAll('[data-job-guid]'));
      return cards.map(card => ({
        guid: card.getAttribute('data-job-guid'),
        id: card.getAttribute('data-id'),
        title: (card.querySelector('[data-testid="job-search-job-detail-link"]') || {}).innerText?.trim() || '',
        companyName: (card.querySelector('a[href*="company-profile"] p') || {}).innerText?.trim() || '',
        detailsPageUrl: (card.querySelector('a[href*="/job-detail/"]') || {}).href || '',
        isRemote: card.innerText.includes('Remote'),
        workplaceTypes: card.innerText.includes('Remote') ? ['Remote'] : [],
        salary: (card.querySelector('[aria-labelledby="salary-label"] p') || {}).innerText?.trim() || '',
        summary: (card.querySelector('p.line-clamp-2') || {}).innerText?.trim() || '',
        easyApply: card.innerText.includes('Easy Apply'),
        postedDate: '',
      })).filter(j => j.guid || j.title);
    });

    await page.close();
  } finally {
    await browser.close();
  }

  // Filter first, then fetch descriptions only for passing jobs
  const filtered = [];
  for (const item of raw) {
    if (filtered.length >= limit) break;
    if (excludeContract && item.employmentType) {
      const empType = item.employmentType.toUpperCase().replace(/[^A-Z_]/g, '_');
      if (EXCLUDED_TYPES.some(t => empType.includes(t.replace('_', '')))) continue;
    }
    const titleLower = (item.title || '').toLowerCase();
    if (EXCLUDED_TITLE_TERMS.some(t => titleLower.includes(t))) continue;
    filtered.push(item);
  }

  // Re-open browser to fetch full descriptions
  const descBrowser = await chromium.launch({ headless: true });
  const descContext = await descBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const jobs = [];
  try {
    for (const item of filtered) {
      const job = normalizeJob(item);
      // Fetch full description if missing or too short
      if (!job.description || job.description.length < 100) {
        try {
          const detailUrl = job.url;
          const dPage = await descContext.newPage();
          await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
          await dPage.goto(detailUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
          await dPage.waitForTimeout(1500);
          const desc = await dPage.evaluate(() => {
            const el = document.querySelector('[data-testid="jobDescriptionHtml"], .job-description, #jobDescriptionText, [class*="description"]');
            return el ? el.innerText.trim() : '';
          });
          if (desc && desc.length > 100) job.description = desc;
          await dPage.close();
        } catch { /* skip description fetch on error */ }
      }
      jobs.push(job);
    }
  } finally {
    await descBrowser.close();
  }

  return jobs;
}

function parseSalary(salaryStr) {
  if (!salaryStr || salaryStr === 'Depends on Experience') return null;

  // Try to extract numbers from salary strings like "USD 130,000.00 - 150,000.00 per year"
  const matches = salaryStr.match(/[\d,]+(?:\.\d+)?/g);
  if (!matches) return null;

  const numbers = matches.map(n => parseFloat(n.replace(/,/g, '')));
  if (numbers.length >= 2) {
    return Math.round((numbers[0] + numbers[1]) / 2);
  } else if (numbers.length === 1) {
    return Math.round(numbers[0]);
  }
  return null;
}

function normalizeJob(item) {
  const location = item.jobLocation
    ? [item.jobLocation.city, item.jobLocation.state].filter(Boolean).join(', ')
    : 'Remote';

  const isRemote = item.isRemote ||
    (item.workplaceTypes || []).includes('Remote') ||
    item.workFromHomeAvailability === 'TRUE';

  const applyUrl = item.detailsPageUrl || `https://www.dice.com/job-detail/${item.guid}`;

  return {
    jobId:       item.guid || item.id,
    title:       (item.title || '').trim(),
    company:     item.companyName || 'Unknown',
    location:    isRemote ? 'Remote' : location,
    remote:      isRemote,
    salary:      parseSalary(item.salary),
    salaryRaw:   item.salary || '',
    description: item.summary || '',
    applyUrl:    applyUrl,
    url:         applyUrl,
    easyApply:   item.easyApply || false,
    trustedUrl:  true, // dice.com is a trusted source
    connections: 0,
    publisher:   'Dice',
    postedAt:    item.postedDate || '',
    source:      'dice',
  };
}
