#!/usr/bin/env node
/**
 * daily-job-hunt.mjs — Automated job hunting via JSearch + LinkedIn scraper
 * Usage: node daily-job-hunt.mjs [--track security|pm|both] [--limit N] [--dry-run] [--no-pdf]
 *
 * Pipeline:
 *   JSearch API (primary) + LinkedIn Playwright (fallback/supplement)
 *   → dedupe → score/filter → AI tailor → rx.resume (PDF) → queue
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchJobs }     from './lib/jsearch.mjs';
import { searchDice }     from './lib/dice.mjs';
import { LinkedInScraper } from './lib/scraper.mjs';
import { scoreJob }       from './lib/scorer.mjs';
import { tailorResume }   from './lib/tailor.mjs';
import { reviewJob }      from './lib/reviewer.mjs';
import { writeJobToQueue, isDuplicate, loadExistingSlugs, todayString } from './lib/queue.mjs';
import { getResume, exportPDF, RESUME_IDS } from './lib/rxresume.mjs';
import { keys } from './lib/keychain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LINKEDIN_COOKIES = resolve(__dirname, 'linkedin-cookies.json');

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { track: 'both', limit: 20, dryRun: false, noPdf: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--track':
        args.track = argv[++i];
        if (!['security', 'pm', 'both', 'tam', 'grc'].includes(args.track)) {
          console.error(`Invalid --track: "${args.track}". Must be security, pm, tam, grc, or both.`);
          process.exit(1);
        }
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10);
        if (isNaN(args.limit) || args.limit < 1) {
          console.error('--limit must be a positive integer.');
          process.exit(1);
        }
        break;
      case '--dry-run': args.dryRun = true; break;
      case '--no-pdf':  args.noPdf = true;  break;
    }
  }
  return args;
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const p = resolve(__dirname, 'job-hunt-config.json');
  if (!existsSync(p)) { console.error(`Config not found: ${p}`); process.exit(1); }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadResume(trackName) {
  // TAM and GRC share the security resume as base
  const paths = {
    security: 'Resume/kofi-resume-security.json',
    pm:       'Resume/kofi-resume-pm.json',
    tam:      'Resume/kofi-resume-security.json',
    grc:      'Resume/kofi-resume-security.json',
  };
  const p = resolve(__dirname, paths[trackName] || paths.security);
  if (!existsSync(p)) { console.error(`Resume not found: ${p}`); process.exit(1); }
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ─── LinkedIn source ───────────────────────────────────────────────────────────

async function fetchLinkedInJobs(scraper, query, limit) {
  try {
    const raw = await scraper.searchJobs(query, { limit, remote: true });
    return raw.map(j => ({
      jobId:       j.jobId,
      title:       j.title,
      company:     j.company,
      location:    j.location || 'Remote',
      remote:      true,
      salary:      null,
      salaryRaw:   j.salary || '',
      description: '', // filled in scrapeJobDetail if needed
      applyUrl:    j.url,
      url:         j.url,
      easyApply:   j.easyApply,
      trustedUrl:  true,
      connections: 0,
      source:      'linkedin',
    }));
  } catch (err) {
    if (err.message === 'RATE_LIMITED') throw err;
    console.warn(`  ⚠ LinkedIn scrape failed for "${query}": ${err.message}`);
    return [];
  }
}

// ─── Summary printer ──────────────────────────────────────────────────────────

function printSummary(dateStr, track, stats, topJobs) {
  const line = '═'.repeat(55);
  console.log(`\n${line}`);
  console.log(` Job Hunt Run — ${dateStr}`);
  console.log(line);
  console.log(` Track: ${track} | Scraped: ${stats.scraped} (JSearch: ${stats.jsearchScraped} / Dice: ${stats.diceScraped} / LI: ${stats.linkedInScraped}) | Queued: ${stats.queued}`);
  console.log(` Skipped (dup): ${stats.skipped_dup} | Low score: ${stats.skipped_score} | Errors: ${stats.errors}`);
  console.log(` PDFs generated: ${stats.pdfs}`);

  if (topJobs.length > 0) {
    console.log('');
    console.log(' Top 5 by score:');
    const top5 = topJobs.sort((a, b) => b.score - a.score).slice(0, 5);
    for (const j of top5) {
      const pdfTag = j.hasPdf ? ' │ PDF ✓' : '';
      const salaryTag = j.salary ? ` │ $${Math.round(j.salary / 1000)}k` : '';
      const srcTag = ` │ ${j.source}`;
      console.log(`  ${String(j.score).padStart(3)} │ ${j.company} — ${j.title}${salaryTag}${srcTag}${pdfTag}`);
    }
  }

  console.log(line);
}

// ─── Telegram digest formatter ─────────────────────────────────────────────────

function buildTelegramDigest(dateStr, stats, topJobs) {
  const top5 = topJobs.sort((a, b) => b.score - a.score).slice(0, 5);
  const lines = [
    `📋 *Job Hunt — ${dateStr}*`,
    `Queued: ${stats.queued} | PDFs: ${stats.pdfs} | JSearch: ${stats.jsearchScraped} / Dice: ${stats.diceScraped} / LI: ${stats.linkedInScraped}`,
    '',
    '*Top picks:*',
  ];

  for (const j of top5) {
    const sal = j.salary ? ` · $${Math.round(j.salary / 1000)}k` : '';
    const pdf = j.hasPdf ? ' · PDF ✓' : '';
    const src = j.source === 'linkedin' ? ' · LI' : '';
    lines.push(`• [${j.company} — ${j.title}](${j.applyUrl})${sal}${src}${pdf}`);
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dateStr = todayString();

  const jsearchKey = keys.jsearch;
  const rxresumeKey = keys.rxresume;

  if (!rxresumeKey && !args.noPdf) {
    console.warn('Warning: rxresumeApiKey not set — PDF generation disabled (--no-pdf implied)');
    args.noPdf = true;
  }

  const hasJSearch = !!jsearchKey;
  const hasLinkedIn = existsSync(LINKEDIN_COOKIES);
  const hasDice = true; // always available, no key needed

  if (!hasJSearch && !hasLinkedIn && !hasDice) {
    console.error('No job sources available.');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(55)}`);
  console.log(` Daily Job Hunt — ${dateStr}`);
  console.log(`${'═'.repeat(55)}`);
  console.log(` Track: ${args.track} | Limit: ${args.limit}/query | Dry run: ${args.dryRun} | PDF: ${!args.noPdf}`);
  console.log(` Sources: ${[hasJSearch && 'JSearch', 'Dice', hasLinkedIn && 'LinkedIn'].filter(Boolean).join(' + ')}`);

  // ── Load base resumes for scoring/tailoring ──
  const tracks = args.track === 'both' ? ['security', 'pm', 'tam', 'grc'] : [args.track];
  const resumes = {};
  for (const t of tracks) resumes[t] = loadResume(t);

  // ── Load rx.resume base data (for tailored PDF generation) ──
  const rxBaseData = {};
  if (!args.noPdf && !args.dryRun) {
    for (const t of tracks) {
      const resumeId = RESUME_IDS[t];
      if (resumeId) {
        try {
          const full = await getResume(resumeId, rxresumeKey);
          rxBaseData[t] = full.data;
          console.log(` ✓ Loaded rx.resume base (${t}): ${full.name}`);
        } catch (err) {
          console.warn(` ⚠ Could not load rx.resume base (${t}): ${err.message}`);
        }
      }
    }
  }

  // ── Init LinkedIn scraper (reused across all tracks) ──
  let linkedInScraper = null;
  if (hasLinkedIn) {
    linkedInScraper = new LinkedInScraper({});
    await linkedInScraper.init(true); // headless
    await linkedInScraper.loadCookies(LINKEDIN_COOKIES);
    const loggedIn = await linkedInScraper.isLoggedIn();
    if (!loggedIn) {
      console.warn(' ⚠ LinkedIn cookies expired — skipping LinkedIn source');
      await linkedInScraper.close();
      linkedInScraper = null;
    } else {
      console.log(' ✓ LinkedIn session active');
    }
  }

  const existingSlugs = loadExistingSlugs(config.outputDir, dateStr);
  const allStats = { scraped: 0, jsearchScraped: 0, diceScraped: 0, linkedInScraped: 0, queued: 0, skipped_dup: 0, skipped_score: 0, errors: 0, pdfs: 0, reviewed: 0, skipped_review: 0 };
  const allTopJobs = [];

  try {
    // ── Process each track ──
    for (const track of tracks) {
      const resume = resumes[track];
      const queries = config.searchQueries[track] || [];

      console.log(`\n── Track: ${track.toUpperCase()} ──`);

      for (const query of queries) {
        // Combine results from all available sources
        let results = [];

        // JSearch (primary)
        if (hasJSearch) {
          console.log(`\n  [JSearch] "${query}"`);
          try {
            const jsearchResults = await searchJobs(query, {
              apiKey: jsearchKey,
              limit: args.limit,
              datePosted: config.datePosted || '3days',
              track,
              remoteOnly: config.filters?.remote !== false,
            });
            results.push(...jsearchResults);
            allStats.jsearchScraped += jsearchResults.length;
            console.log(`  Found ${jsearchResults.length} via JSearch`);
          } catch (err) {
            if (err.message === 'RATE_LIMITED') {
              console.warn('  JSearch rate limited — falling back to LinkedIn only');
            } else {
              console.error(`  JSearch error: ${err.message}`);
              allStats.errors++;
            }
          }
        }

        // Dice (free, always runs)
        console.log(`  [Dice] "${query}"`);
        try {
          const diceResults = await searchDice(query, {
            limit: args.limit,
            remoteOnly: config.filters?.remote !== false,
            excludeContract: config.filters?.excludeContract !== false,
            postedWithin: config.datePosted === 'today' ? 'ONE' : config.datePosted === 'week' ? 'SEVEN' : 'THREE',
          });
          const existingKeys = new Set(results.map(j => `${j.company}|${j.title}`.toLowerCase()));
          const newDice = diceResults.filter(j => !existingKeys.has(`${j.company}|${j.title}`.toLowerCase()));
          results.push(...newDice);
          allStats.diceScraped += newDice.length;
          console.log(`  Found ${newDice.length} new via Dice`);
          // Polite delay
          await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
        } catch (err) {
          if (err.message !== 'RATE_LIMITED') {
            console.warn(`  ⚠ Dice error for "${query}": ${err.message}`);
          }
        }

        // Brief pause between JSearch and LinkedIn for same query
        if (hasJSearch && linkedInScraper) {
          await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
        }

        // LinkedIn (supplement / fallback)
        if (linkedInScraper) {
          console.log(`  [LinkedIn] "${query}"`);
          try {
            const liResults = await fetchLinkedInJobs(linkedInScraper, query, args.limit);
            // Dedupe against JSearch results by title+company
            const jSearchKeys = new Set(results.map(j => `${j.company}|${j.title}`.toLowerCase()));
            const newLiResults = liResults.filter(j => !jSearchKeys.has(`${j.company}|${j.title}`.toLowerCase()));
            results.push(...newLiResults);
            allStats.linkedInScraped += newLiResults.length;
            console.log(`  Found ${newLiResults.length} new via LinkedIn`);
          } catch (err) {
            if (err.message === 'RATE_LIMITED') {
              console.warn('  LinkedIn rate limited — pausing scraper');
              await linkedInScraper.close();
              linkedInScraper = null;
            }
          }
        }

        allStats.scraped += results.length;

        for (const job of results) {
          // Duplicate check
          const slug = `${job.company}-${job.title}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);

          if (existingSlugs.has(slug) || isDuplicate(config.outputDir, dateStr, slug)) {
            allStats.skipped_dup++;
            continue;
          }

          // Score
          const scorecard = scoreJob(job, resume, track);
          if (scorecard.total < (config.scoreThreshold || 35)) {
            allStats.skipped_score++;
            continue;
          }

          // Tailor resume
          const tailored = await tailorResume(resume, job.description, track);

          // Generate PDF via rx.resume
          let resumePdfUrl = null;
          if (!args.noPdf && !args.dryRun && rxBaseData[track] && RESUME_IDS[track]) {
            try {
              const patchedData = JSON.parse(JSON.stringify(rxBaseData[track]));
              if (tailored.summary?.content && patchedData.sections?.summary) {
                patchedData.sections.summary.content = tailored.summary.content;
              }

              const { updateResume } = await import('./lib/rxresume.mjs');
              await updateResume(RESUME_IDS[track], patchedData, rxresumeKey);
              resumePdfUrl = await exportPDF(RESUME_IDS[track], rxresumeKey);
              allStats.pdfs++;

              if (rxBaseData[track]) {
                await updateResume(RESUME_IDS[track], rxBaseData[track], rxresumeKey);
              }
            } catch (err) {
              console.warn(`  ⚠ PDF gen failed: ${err.message}`);
            }
          }

          // Write to queue
          const jobWithPdf = { ...job, resumePdfUrl };
          let jobDir = null;
          if (!args.dryRun) {
            jobDir = writeJobToQueue(config.outputDir, dateStr, jobWithPdf, scorecard, tailored);
            existingSlugs.add(slug);
          }

          // AI review
          let review = null;
          if (!args.dryRun && jobDir) {
            process.stdout.write(`  👁 Reviewing ... `);
            review = await reviewJob(jobDir, jobWithPdf, scorecard, tailored);
            const { writeFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            writeFileSync(join(jobDir, 'review.json'), JSON.stringify(review, null, 2), 'utf8');

            const emoji = { apply: '✅', review: '🟡', skip: '❌' }[review.recommendation] || '❓';
            const qualTag = review.summaryQuality !== 'good' ? ` summary:${review.summaryQuality}` : '';
            console.log(`${emoji} ${review.recommendation} | fit:${review.jobFit}${qualTag}`);
            if (review.redFlags?.length) {
              for (const f of review.redFlags) console.log(`    ⚠ ${f}`);
            }
            if (review.recommendation !== 'skip') allStats.reviewed++;
            else allStats.skipped_review++;
          }

          allStats.queued++;
          allTopJobs.push({
            score:      scorecard.total,
            company:    job.company,
            title:      job.title,
            salary:     job.salary,
            applyUrl:   job.applyUrl,
            hasPdf:     !!resumePdfUrl,
            recommend:  review?.recommendation || 'unknown',
            source:     job.source || 'unknown',
          });

          const dryTag = args.dryRun ? ' [DRY RUN]' : '';
          const pdfTag = resumePdfUrl ? ' [PDF ✓]' : '';
          const salTag = job.salary ? ` [$${Math.round(job.salary/1000)}k]` : '';
          if (args.dryRun) {
            console.log(`  ✓ [${scorecard.total}/100]${dryTag}${pdfTag}${salTag} ${job.company} — ${job.title}`);
          }
        }
      }
    }
  } finally {
    if (linkedInScraper) await linkedInScraper.close();
  }

  printSummary(dateStr, args.track, allStats, allTopJobs);

  if (allTopJobs.length > 0) {
    console.log('\n── TELEGRAM DIGEST ──');
    console.log(buildTelegramDigest(dateStr, allStats, allTopJobs));
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
