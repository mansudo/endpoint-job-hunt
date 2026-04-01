#!/usr/bin/env node
/**
 * review-queue.mjs — Retroactive reviewer for existing job queue entries
 *
 * Usage:
 *   node review-queue.mjs                    # review today's queue
 *   node review-queue.mjs --date 2026-03-23  # review a specific date
 *   node review-queue.mjs --retailor         # also re-run AI tailoring before review
 *   node review-queue.mjs --fix-only         # only fix bad/ok summaries, skip good ones
 *
 * Writes review.json to each job folder.
 * If summary is bad/ok, automatically corrects resume-tailored.json.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tailorResume } from './lib/tailor.mjs';
import { reviewBatch }  from './lib/reviewer.mjs';
import { todayString }  from './lib/queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { date: todayString(), retailor: false, fixOnly: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--date':     args.date = argv[++i]; break;
      case '--retailor': args.retailor = true; break;
      case '--fix-only': args.fixOnly = true; break;
    }
  }
  return args;
}

function loadConfig() {
  const p = resolve(__dirname, 'job-hunt-config.json');
  if (!existsSync(p)) { console.error('Config not found'); process.exit(1); }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadResume(track) {
  const paths = { security: 'Resume/kofi-resume-security.json', pm: 'Resume/kofi-resume-pm.json' };
  const p = resolve(__dirname, paths[track] || paths.pm);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const dateDir = resolve(__dirname, config.outputDir, args.date);
  if (!existsSync(dateDir)) {
    console.error(`No queue found for date: ${args.date} (${dateDir})`);
    process.exit(1);
  }

  const folders = readdirSync(dateDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(dateDir, e.name));

  console.log(`\n${'═'.repeat(55)}`);
  console.log(` Resume Reviewer — ${args.date}`);
  console.log(`${'═'.repeat(55)}`);
  console.log(` Found: ${folders.length} job(s) | Retailor: ${args.retailor} | Fix-only: ${args.fixOnly}`);

  const jobEntries = [];

  for (const jobDir of folders) {
    const jobPath      = join(jobDir, 'job.json');
    const scorePath    = join(jobDir, 'scorecard.json');
    const tailorPath   = join(jobDir, 'resume-tailored.json');
    const reviewPath   = join(jobDir, 'review.json');

    if (!existsSync(jobPath) || !existsSync(tailorPath)) continue;

    const job       = JSON.parse(readFileSync(jobPath, 'utf8'));
    const scorecard = existsSync(scorePath) ? JSON.parse(readFileSync(scorePath, 'utf8')) : { total: 0 };
    let tailored    = JSON.parse(readFileSync(tailorPath, 'utf8'));

    // Skip if already reviewed and not in retailor mode
    if (existsSync(reviewPath) && !args.retailor) {
      const existing = JSON.parse(readFileSync(reviewPath, 'utf8'));
      if (args.fixOnly && existing.summaryQuality === 'good') {
        console.log(`  ⏭ Skipping (already good): ${job.company} — ${job.title}`);
        continue;
      }
    }

    // Re-run AI tailoring if requested
    if (args.retailor && job.description) {
      const track = tailored._tailoring?.track || 'pm';
      const baseResume = loadResume(track);
      if (baseResume) {
        process.stdout.write(`  ✍ Retailoring: ${job.company} — ${job.title} ... `);
        tailored = await tailorResume(baseResume, job.description, track);
        writeFileSync(tailorPath, JSON.stringify(tailored, null, 2), 'utf8');
        console.log('done');
      }
    }

    jobEntries.push({ jobDir, job, scorecard, tailored });
  }

  if (jobEntries.length === 0) {
    console.log('\nNothing to review.\n');
    return;
  }

  console.log(`\n── Reviewing ${jobEntries.length} job(s) ──\n`);
  const { stats, results } = await reviewBatch(jobEntries);

  console.log(`\n${'═'.repeat(55)}`);
  console.log(` Review Complete`);
  console.log(`${'═'.repeat(55)}`);
  console.log(` ✅ Apply: ${stats.apply || 0}  🟡 Review: ${stats.review || 0}  ❌ Skip: ${stats.skip || 0}`);
  console.log(` 🔧 Summaries auto-corrected: ${stats.corrected || 0}`);

  console.log('\n── Apply List ──');
  for (const { job, scorecard, review } of results) {
    if (review.recommendation === 'apply') {
      const sal = job.salary ? ` · $${Math.round(job.salary/1000)}k` : '';
      console.log(`  [${scorecard.total}] ${job.company} — ${job.title}${sal}`);
      console.log(`       ${job.applyUrl}`);
    }
  }

  console.log('\n── Needs Manual Review ──');
  for (const { job, review } of results) {
    if (review.recommendation === 'review') {
      console.log(`  ${job.company} — ${job.title}`);
      if (review.summaryIssues) console.log(`    Issue: ${review.summaryIssues}`);
      if (review.notes)         console.log(`    Note: ${review.notes}`);
    }
  }

  const skipped = results.filter(r => r.review.recommendation === 'skip');
  if (skipped.length) {
    console.log('\n── Skipped ──');
    for (const { job, review } of skipped) {
      console.log(`  ❌ ${job.company} — ${job.title} (${review.fitReason})`);
    }
  }

  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
