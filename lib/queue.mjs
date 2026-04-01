/**
 * queue.mjs — Output file writing and queue management
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Generate URL-safe slug from company + title
function makeSlug(company, title) {
  return `${company}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * writeJobToQueue(outputDir, date, job, scorecard, tailoredResume) → slug
 *
 * Creates: {outputDir}/{date}/{slug}/job.json, scorecard.json, resume-tailored.json, apply.txt
 */
export function writeJobToQueue(outputDir, date, job, scorecard, tailoredResume) {
  const slug = makeSlug(job.company || 'unknown', job.title || 'unknown');
  const dir = join(outputDir, date, slug);

  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  writeFileSync(join(dir, 'scorecard.json'), JSON.stringify(scorecard, null, 2), 'utf8');
  writeFileSync(join(dir, 'resume-tailored.json'), JSON.stringify(tailoredResume, null, 2), 'utf8');

  // apply.txt: apply URL + PDF link (if available)
  const applyLines = [job.applyUrl || job.url || ''];
  if (job.resumePdfUrl) applyLines.push(`PDF: ${job.resumePdfUrl}`);
  writeFileSync(join(dir, 'apply.txt'), applyLines.join('\n'), 'utf8');

  return dir; // return full path so caller can write review.json
}

/**
 * isDuplicate(outputDir, date, slug) → boolean
 *
 * Check if {outputDir}/{date}/{slug}/ already exists
 */
export function isDuplicate(outputDir, date, slug) {
  return existsSync(join(outputDir, date, slug));
}

/**
 * loadExistingSlugs(outputDir, date) → Set<string>
 *
 * Returns slugs already written for this date
 */
export function loadExistingSlugs(outputDir, date) {
  const dateDir = join(outputDir, date);
  if (!existsSync(dateDir)) return new Set();

  const entries = readdirSync(dateDir, { withFileTypes: true });
  return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
}

// Today's date as YYYY-MM-DD
export function todayString() {
  return new Date().toISOString().split('T')[0];
}
