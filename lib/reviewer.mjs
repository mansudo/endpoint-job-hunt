/**
 * reviewer.mjs — AI-powered resume + job match reviewer
 *
 * Acts as a checks-and-balances layer after tailoring.
 * Reviews each queued job for:
 *   1. Summary quality (is it coherent, relevant, not keyword-stuffed?)
 *   2. Job fit (does this role actually match Kofi's background?)
 *   3. Red flags (contract disguised as FT, suspiciously low salary, job mill)
 *
 * Returns a review object that gets written to review.json in each job folder.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getAnthropicKey() {
  try {
    const profiles = JSON.parse(
      readFileSync(resolve(process.env.HOME, '.openclaw/agents/main/agent/auth-profiles.json'), 'utf8')
    );
    const profile = profiles?.profiles?.['anthropic:anthony'];
    if (profile?.token) return profile.token;
  } catch {}
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return null;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

const REVIEW_PROMPT = (jobTitle, company, jdSnippet, tailoredSummary, originalSummary, score, track) => `
You are a senior recruiter and resume coach reviewing an AI-tailored resume for a job application.

CANDIDATE BACKGROUND: Kofi Asirifi — 8+ years endpoint security, MDM (Intune, JAMF, Tanium), 
Windows hardening, Zero Trust, device compliance, identity infrastructure. Also experienced as 
a Technical Product Manager for security/IT platforms.

APPLYING TO: ${jobTitle} at ${company}
TRACK: ${track === 'security' ? 'Endpoint Security Engineer' : 'Technical Product Manager'}
PIPELINE SCORE: ${score}/100

ORIGINAL SUMMARY:
${originalSummary}

TAILORED SUMMARY:
${tailoredSummary}

JOB DESCRIPTION (first 1500 chars):
${jdSnippet}

Review this and respond with ONLY valid JSON (no markdown):
{
  "summaryQuality": "good" | "ok" | "bad",
  "summaryIssues": "<specific issues if bad/ok, or empty string>",
  "suggestedSummary": "<improved summary if quality is bad/ok, else empty string>",
  "jobFit": "strong" | "moderate" | "weak",
  "fitReason": "<one sentence>",
  "redFlags": ["<flag1>", "<flag2>"],
  "recommendation": "apply" | "skip" | "review",
  "notes": "<any other observations for Kofi>"
}

Scoring guide:
- summaryQuality "bad": keywords are generic/nonsensical, company name stuffed in, reads awkwardly
- summaryQuality "ok": usable but could be improved
- summaryQuality "good": reads naturally, keywords are meaningful, strong ATS match
- recommendation "apply": strong fit, clean summary, go for it
- recommendation "review": questionable fit or summary needs manual fix before applying
- recommendation "skip": weak fit, red flags, or embarrassing summary — not worth sending
`;

/**
 * reviewJob(jobDir, job, scorecard, tailored) → review object
 *
 * jobDir: path to the job's folder
 * job: job.json data
 * scorecard: scorecard.json data
 * tailored: resume-tailored.json data
 */
export async function reviewJob(jobDir, job, scorecard, tailored) {
  const apiKey = getAnthropicKey();

  if (!apiKey) {
    return {
      summaryQuality: 'unknown',
      summaryIssues: 'No API key — review skipped',
      suggestedSummary: '',
      jobFit: 'unknown',
      fitReason: '',
      redFlags: [],
      recommendation: 'review',
      notes: 'Reviewer unavailable — check manually',
      reviewedAt: new Date().toISOString(),
      model: null,
    };
  }

  const originalSummary = stripHtml(tailored._tailoring?.originalSummary || tailored.summary?.content || '');
  const tailoredSummary = stripHtml(tailored.summary?.content || '');
  const jdSnippet = (job.description || '').slice(0, 1500);
  const track = tailored._tailoring?.track || 'unknown';

  const prompt = REVIEW_PROMPT(
    job.title, job.company, jdSnippet,
    tailoredSummary, originalSummary,
    scorecard.total, track
  );

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }

    const body = await res.json();
    const text = body?.content?.[0]?.text?.trim() || '';
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const review = JSON.parse(clean);

    review.reviewedAt = new Date().toISOString();
    review.model = 'claude-haiku-4-5';

    // If reviewer suggests a better summary, apply it to the tailored resume
    if (review.suggestedSummary && review.summaryQuality !== 'good') {
      tailored.summary.content = `<p><strong>${review.suggestedSummary}</strong></p>`;
      tailored._tailoring = {
        ...tailored._tailoring,
        reviewerCorrected: true,
        reviewerSuggestion: review.suggestedSummary,
      };
      // Overwrite resume-tailored.json with the corrected version
      writeFileSync(
        resolve(jobDir, 'resume-tailored.json'),
        JSON.stringify(tailored, null, 2),
        'utf8'
      );
    }

    return review;

  } catch (err) {
    return {
      summaryQuality: 'unknown',
      summaryIssues: `Review error: ${err.message}`,
      suggestedSummary: '',
      jobFit: 'unknown',
      fitReason: '',
      redFlags: [],
      recommendation: 'review',
      notes: 'Reviewer failed — check manually',
      reviewedAt: new Date().toISOString(),
      model: null,
    };
  }
}

/**
 * reviewBatch(jobEntries) → summary stats
 *
 * jobEntries: array of { jobDir, job, scorecard, tailored }
 * Writes review.json to each dir and returns aggregate stats.
 */
export async function reviewBatch(jobEntries) {
  const stats = { apply: 0, review: 0, skip: 0, corrected: 0, errors: 0 };
  const results = [];

  for (const entry of jobEntries) {
    const { jobDir, job, scorecard, tailored } = entry;

    process.stdout.write(`  👁 Reviewing: ${job.company} — ${job.title} ... `);

    const review = await reviewJob(jobDir, job, scorecard, tailored);

    // Write review.json
    writeFileSync(
      resolve(jobDir, 'review.json'),
      JSON.stringify(review, null, 2),
      'utf8'
    );

    stats[review.recommendation] = (stats[review.recommendation] || 0) + 1;
    if (tailored._tailoring?.reviewerCorrected) stats.corrected++;

    const emoji = { apply: '✅', review: '🟡', skip: '❌' }[review.recommendation] || '❓';
    const qualityTag = review.summaryQuality !== 'good' ? ` [summary:${review.summaryQuality}]` : '';
    console.log(`${emoji} ${review.jobFit} fit${qualityTag}`);

    if (review.redFlags?.length) {
      for (const flag of review.redFlags) console.log(`    ⚠ ${flag}`);
    }

    results.push({ ...entry, review });
  }

  return { stats, results };
}
