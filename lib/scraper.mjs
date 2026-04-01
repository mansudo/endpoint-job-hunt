/**
 * scraper.mjs — Playwright LinkedIn scraper
 * Class-based: LinkedInScraper
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const LINKEDIN_BASE = 'https://www.linkedin.com';

function resolvePath(p) {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export class LinkedInScraper {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.context = null;
  }

  async init(headless = true) {
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });
  }

  async loadCookies(cookiePath) {
    const resolved = resolvePath(cookiePath);
    if (!existsSync(resolved)) return;
    try {
      const cookies = JSON.parse(readFileSync(resolved, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await this.context.addCookies(cookies);
      }
    } catch {
      // ignore malformed cookie file
    }
  }

  async saveCookies(cookiePath) {
    const resolved = resolvePath(cookiePath);
    const dir = dirname(resolved);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cookies = await this.context.cookies();
    writeFileSync(resolved, JSON.stringify(cookies, null, 2), 'utf8');
  }

  async isLoggedIn() {
    const page = await this.context.newPage();
    try {
      await page.goto(`${LINKEDIN_BASE}/feed`, {
        timeout: 15000,
        waitUntil: 'domcontentloaded'
      });
      await page.waitForTimeout(2000);
      const url = page.url();
      if (url.includes('/checkpoint/') || url.includes('/authwall') || url.includes('/login')) {
        return false;
      }
      const navEl = await page.$('.global-nav, #global-nav');
      return navEl !== null;
    } catch {
      return false;
    } finally {
      await page.close();
    }
  }

  async login() {
    // Must be initialized non-headless
    const page = await this.context.newPage();
    await page.goto(`${LINKEDIN_BASE}/login`, { timeout: 15000 });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const url = page.url();
      if (url.includes('/feed') || url.includes('/mynetwork')) {
        await page.close();
        return;
      }
    }
    await page.close();
    throw new Error('Login timed out after 120s');
  }

  /**
   * searchJobs(query, filters) → Array of job stubs
   * filters: { limit, remote, excludeEntryLevel, excludeContract }
   */
  async searchJobs(query, filters = {}) {
    const limit = filters.limit || 20;
    const params = new URLSearchParams({
      keywords: query,
      f_WT: '2',    // remote
      f_AL: 'true', // easy apply
      f_E: '4,5',   // mid-senior + director
      sortBy: 'DD'
    });
    const searchUrl = `${LINKEDIN_BASE}/jobs/search/?${params}`;

    const page = await this.context.newPage();
    const jobs = [];

    try {
      // Random delay before each search page (3–7s) to look human
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 4000));

      await page.goto(searchUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });

      // Wait for page to settle like a human would
      await page.waitForTimeout(2500 + Math.floor(Math.random() * 2000));

      this._checkRateLimit(page);

      // Wait for job cards — try multiple container selectors
      await page.waitForSelector(
        'li[class*="jobs-search-results"], [data-job-id], li[class*="job-card"]',
        { timeout: 10000 }
      ).catch(() => {});

      await page.waitForTimeout(1500);

      // Collect all job links — most reliable approach
      const rawLinks = await page.$$eval(
        'a[href*="/jobs/view/"]',
        (anchors) => {
          const seen = new Set();
          const results = [];
          for (const a of anchors) {
            const href = a.href.split('?')[0];
            const jobId = (href.match(/\/jobs\/view\/(\d+)/) || [])[1] || '';
            if (!jobId || seen.has(jobId)) continue;
            seen.add(jobId);
            const title = a.innerText.trim() || a.getAttribute('aria-label') || '';
            const card = a.closest('li') || a.closest('[data-job-id]') || a.parentElement;
            const company = card ? (card.querySelector('[class*="company"],[class*="subtitle"]') || {innerText:''}).innerText.trim() : '';
            const location = card ? (card.querySelector('[class*="location"],[class*="metadata"]') || {innerText:''}).innerText.trim() : '';
            const salary = card ? (card.querySelector('[class*="salary"],[class*="compensation"]') || {innerText:''}).innerText.trim() : '';
            const easyApply = card ? card.innerText.includes('Easy Apply') : false;
            results.push({ url: href, title, company, location, salary, easyApply, jobId });
          }
          return results;
        }
      );

      for (const job of rawLinks) {
        if (jobs.length >= limit) break;
        jobs.push(job);
      }
    } finally {
      await page.close();
    }

    return jobs;
  }

  /**
   * scrapeJobDetail(url) → { description, connections }
   */
  async scrapeJobDetail(url) {
    const page = await this.context.newPage();

    try {
      // Random delay 2–5s between job pages to avoid rate limiting
      const delay = 2000 + Math.floor(Math.random() * 3000);
      await page.waitForTimeout(delay);

      await page.goto(url, { timeout: 10000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      this._checkRateLimit(page);

      // Expand description
      const seeMore = await page.$('[class*="jobs-description__footer-button"], button[aria-label*="see more"]');
      if (seeMore) await seeMore.click().catch(() => {});
      await page.waitForTimeout(500);

      // Description — try multiple selector strategies
      let description = '';
      const descSelectors = [
        '#job-details',
        '.jobs-description',
        '.description__text',
        '[class*="jobs-description-content"]',
        '[class*="job-description"]',
        'article',
        '[class*="description"]'
      ];
      for (const sel of descSelectors) {
        const el = await page.$(sel);
        if (el) {
          const text = (await el.innerText()).trim();
          if (text.length > 100) { description = text; break; }
        }
      }
      // Fallback: grab all visible text from main content area
      if (!description) {
        const mainEl = await page.$('main');
        if (mainEl) description = (await mainEl.innerText()).trim().slice(0, 5000);
      }

      // 2nd degree connections count
      let connections = 0;
      const connEls = await page.$$('[class*="hirer-card"], [class*="jobs-poster"], [aria-label*="2nd"]');
      for (const el of connEls) {
        const text = await el.innerText().catch(() => '');
        if (text.includes('2nd') || text.includes('2nd degree')) connections++;
      }

      // Also check sidebar insight blocks
      const insightEls = await page.$$('.jobs-premium-applicant-insights, [class*="applicant-insights"]');
      for (const el of insightEls) {
        const text = await el.innerText().catch(() => '');
        if (/\d+\s*(2nd|second)/i.test(text)) {
          const match = text.match(/(\d+)/);
          if (match) connections = Math.max(connections, parseInt(match[1], 10));
        }
      }

      return { description, connections };
    } finally {
      await page.close();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }

  _checkRateLimit(page) {
    const url = page.url();
    if (url.includes('checkpoint') || url.includes('authwall')) {
      throw new Error('RATE_LIMITED');
    }
  }
}
