/**
 * tailor.mjs — AI-powered resume tailoring via Claude
 *
 * Uses Claude claude-haiku-4-5 to intelligently inject 2-3 high-signal keywords
 * from the JD into the resume summary — no dumb word-frequency nonsense.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy-load the Anthropic key from OpenClaw auth profiles
function getAnthropicKey() {
  try {
    const profiles = JSON.parse(
      readFileSync(resolve(process.env.HOME, '.openclaw/agents/main/agent/auth-profiles.json'), 'utf8')
    );
    const profile = profiles?.profiles?.['anthropic:anthony'];
    if (profile?.token) return profile.token;
  } catch {}
  // Fallback: env var
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return null;
}

// Strip HTML tags
function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * tailorResume(resumeJson, jobDescription, track) → deep copy of resume with tailored summary
 *
 * Uses Claude to identify 2-3 meaningful keywords from the JD that:
 *   - Are not already in the summary
 *   - Are actual skills/tools/methodologies (not generic words or company names)
 *   - Would improve ATS match without looking keyword-stuffed
 *
 * Falls back to the original summary if AI is unavailable.
 */
export async function tailorResume(resumeJson, jobDescription, track) {
  const tailored = JSON.parse(JSON.stringify(resumeJson));

  const currentContent = tailored.summary?.content || '';
  const currentPlain = stripHtml(currentContent);

  if (!currentPlain || !jobDescription) return tailored;

  const apiKey = getAnthropicKey();

  if (!apiKey) {
    console.warn('  ⚠ No Anthropic API key — skipping AI tailoring, using original summary');
    return tailored;
  }

  try {
    const prompt = buildPrompt(currentPlain, jobDescription, track);
    const result = await callClaude(apiKey, prompt);

    if (!result || result.error) {
      console.warn(`  ⚠ AI tailoring failed: ${result?.error || 'no response'} — using original`);
      return tailored;
    }

    tailored.summary.content = `<p><strong>${result.tailoredSummary}</strong></p>`;
    tailored._tailoring = {
      track,
      injectedKeywords: result.injectedKeywords,
      rationale: result.rationale,
      achievementBullets: result.achievementBullets || [],
      originalSummary: currentContent,
      model: 'claude-haiku-4-5',
    };

  } catch (err) {
    console.warn(`  ⚠ AI tailoring error: ${err.message} — using original summary`);
  }

  return tailored;
}

function buildPrompt(currentSummary, jobDescription, track) {
  return `You are the combined embodiment of the world's best technical recruiters and resume coaches.
You know exactly what hiring managers at top tech companies look for, what ATS systems reward,
and what makes a candidate stand out vs. blend in.

CANDIDATE: Kofi Asirifi — 8+ years endpoint security/MDM (Tanium, Jamf, Intune), 
directed 30-person team at Tanium across 500+ enterprises / 25M endpoints, 
Gartner MQ contributor, hands-on security practitioner + product leader.

CURRENT RESUME SUMMARY:
${currentSummary}

JOB DESCRIPTION (first 2000 chars):
${jobDescription.slice(0, 2000)}

TRACK: ${track === 'security' ? 'Endpoint Security / Cybersecurity Engineer' : 'Technical Product Manager'}

YOUR TASK — rewrite the summary AND generate 3 tailored achievement bullets:

SUMMARY RULES:
1. Lead with the strongest, most specific credential that matches this JD — not generic fluff
2. Inject 2-3 high-signal keywords from the JD: specific tools, technologies, or domain terms only
   (NEVER: generic words like "remote", "job", "engineer", company names, or words already in summary)
3. Every word must earn its place — cut anything that doesn't directly support this application
4. Outcomes > responsibilities. "Drove 13% adoption growth" beats "Led product teams"
5. Must read like a human wrote it — not keyword-stuffed, not corporate drone
6. 2-3 sentences max. Tight. Punchy. Memorable.

ACHIEVEMENT BULLET RULES (Google XYZ formula):
- Format: "Accomplished [X] as measured by [Y] by doing [Z]"
- X = the outcome or impact (what changed)
- Y = the metric or proof (how you know it worked)
- Z = the specific action or method (what you actually did)
- Draw ONLY from Kofi's real experience: Tanium (500+ enterprises, 25M endpoints, 30-person team), 
  Jamf/Intune MDM, CIS Benchmarks, Defender ASR, Gartner MQ, CSP/WMI validation
- Each bullet must connect to a skill or requirement in the JD
- Be specific — real numbers, real tools, real scale. No fabrication.
- 1-2 lines each. No fluff verbs ("helped", "assisted", "worked on").

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "tailoredSummary": "<the full updated summary text, no HTML>",
  "injectedKeywords": ["kw1", "kw2"],
  "rationale": "one sentence explaining why these keywords were chosen",
  "achievementBullets": [
    "Accomplished X as measured by Y by doing Z",
    "Accomplished X as measured by Y by doing Z",
    "Accomplished X as measured by Y by doing Z"
  ]
}`;
}

async function callClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `API ${res.status}: ${text.slice(0, 200)}` };
  }

  const body = await res.json();
  const text = body?.content?.[0]?.text?.trim() || '';

  // Parse JSON response
  try {
    // Strip markdown code blocks if present
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return { error: `Could not parse Claude response: ${text.slice(0, 100)}` };
  }
}
