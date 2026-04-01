#!/usr/bin/env node
/**
 * linkedin-login.mjs — Opens a visible LinkedIn browser session
 * Log in manually. Cookies auto-save after 60 seconds, or when you close the browser.
 */

import { chromium } from './node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const COOKIE_PATH = `${homedir()}/Development/job-hunt-scripts/linkedin-cookies.json`;
const WAIT_SECONDS = 90;

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 }
});

const page = await context.newPage();
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

console.log(`\n✅ Browser open — log in to LinkedIn.`);
console.log(`⏳ Cookies will auto-save in ${WAIT_SECONDS} seconds after you log in.\n`);

await new Promise(resolve => setTimeout(resolve, WAIT_SECONDS * 1000));

const cookies = await context.cookies();
writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
console.log(`\n✅ Cookies saved: ${COOKIE_PATH} (${cookies.length} cookies)`);

await browser.close();
process.exit(0);
