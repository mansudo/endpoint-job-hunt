/**
 * scorer.mjs — Job scoring logic
 * Scores jobs 0–100 across keyword match, OE compatibility, salary, and connections
 */

const OE_POSITIVE = [
  'async', 'output-based', 'flexible hours', 'results-driven',
  'trust-based', 'autonomous', 'self-directed',
  'remote-first', 'work from anywhere', 'flexible schedule',
  'own your schedule', 'no micromanagement', 'outcome-driven',
  'high autonomy', 'independent', 'self-starter', 'distributed team',
  'fully remote', 'asynchronous', 'work independently'
];

const OE_NEGATIVE = [
  'daily standup', 'time tracking', 'monitoring software', 'screenshot'
];

// Extract keywords from resume JSON (ReactiveResume format)
function extractKeywords(resumeData) {
  const tokens = new Set();

  // summary
  const summary = resumeData?.summary?.content || '';
  tokenize(summary).forEach(t => tokens.add(t));

  // sections.experience items
  const expItems = resumeData?.sections?.experience?.items || [];
  for (const item of expItems) {
    tokenize(item.description || '').forEach(t => tokens.add(t));
    tokenize(item.summary || '').forEach(t => tokens.add(t));
    for (const role of (item.roles || [])) {
      tokenize(role.description || '').forEach(t => tokens.add(t));
    }
  }

  // sections.skills items
  const skillItems = resumeData?.sections?.skills?.items || [];
  for (const skill of skillItems) {
    if (skill.name) tokens.add(skill.name.toLowerCase().trim());
    for (const kw of (skill.keywords || [])) {
      tokens.add(kw.toLowerCase().trim());
    }
  }

  // Also handle JSON Resume format (.work and .skills)
  for (const job of (resumeData?.work || [])) {
    tokenize(job.summary || '').forEach(t => tokens.add(t));
    tokenize(job.highlights?.join(' ') || '').forEach(t => tokens.add(t));
  }
  for (const skill of (resumeData?.skills || [])) {
    if (skill.name) tokens.add(skill.name.toLowerCase().trim());
    for (const kw of (skill.keywords || [])) {
      tokens.add(kw.toLowerCase().trim());
    }
  }

  return tokens;
}

function tokenize(text) {
  return (text.replace(/<[^>]+>/g, ' ').toLowerCase().match(/[a-z][a-z0-9\-\/]{1,}/g) || [])
    .filter(t => t.length >= 3);
}

// keyword_match: 0–30
function scoreKeywords(description, resumeData) {
  const keywords = extractKeywords(resumeData);
  if (keywords.size === 0) return 0;

  const descTokens = new Set(tokenize(description));
  let matches = 0;
  for (const kw of keywords) {
    if (descTokens.has(kw)) matches++;
  }

  return Math.min(30, matches * 3);
}

// oe_compat: 0–25
function scoreOECompat(description) {
  const text = description.toLowerCase();

  let signals = 0;
  for (const signal of OE_POSITIVE) {
    if (text.includes(signal)) signals++;
  }

  let deductions = 0;
  for (const signal of OE_NEGATIVE) {
    if (text.includes(signal)) deductions++;
  }

  return Math.max(0, Math.min(25, signals * 4) - deductions * 8);
}

// salary: 0–25
function scoreSalary(salary) {
  if (salary == null || salary === '' || salary === undefined) return 12; // unspecified

  // Numeric value passed directly
  if (typeof salary === 'number') {
    if (salary >= 110000) return 25;
    if (salary <= 0) return 0;
    return Math.round((salary / 110000) * 25);
  }

  // String: extract numbers
  const nums = String(salary).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return 12; // unspecified

  const values = nums.map(n => {
    const v = parseFloat(n);
    return v < 1000 ? v * 1000 : v; // handle "110k" shorthand
  });

  const midpoint = values.reduce((a, b) => a + b, 0) / values.length;

  if (midpoint >= 110000) return 25;
  if (midpoint <= 0) return 0;
  return Math.round((midpoint / 110000) * 25);
}

// connections: 0 or 20
function scoreConnections(connections) {
  if (!connections) return 0;
  if (typeof connections === 'number') return connections > 0 ? 20 : 0;
  if (Array.isArray(connections)) return connections.length > 0 ? 20 : 0;
  return 0;
}

/**
 * scoreJob(jobData, resumeData, track) → {keyword_match, oe_compat, salary, connections, total}
 *
 * jobData: { description, salary, connections, ... }
 * resumeData: full resume JSON object
 * track: 'security' | 'pm' (unused in scoring but available for future weighting)
 */
export function scoreJob(jobData, resumeData, track) {
  const keyword_match = scoreKeywords(jobData.description || '', resumeData);
  const oe_compat = scoreOECompat(jobData.description || '');
  const salary = scoreSalary(jobData.salary);
  const connections = scoreConnections(jobData.connections);
  const total = Math.min(100, keyword_match + oe_compat + salary + connections);

  return { keyword_match, oe_compat, salary, connections, total };
}
