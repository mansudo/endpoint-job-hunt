/**
 * jsearch.mjs — JSearch API client (replaces LinkedIn scraper)
 * Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 */

const JSEARCH_HOST = 'jsearch.p.rapidapi.com';
const JSEARCH_BASE = `https://${JSEARCH_HOST}`;

// Track keywords for relevance filtering (mirrors scraper.mjs logic)
const TRACK_KEYWORDS = {
  security: ['security', 'endpoint', 'mdm', 'device', 'infosec', 'cybersecurity',
             'compliance', 'vulnerability', 'soc', 'identity', 'iam', 'zero trust', 'devsecops'],
  pm:       ['product', 'pm', 'program manager', 'product manager', 'product owner',
             'platform', 'it manager', 'enterprise']
};

const EXCLUDED_TITLE_TERMS = [
  'associate ', 'junior ', ' i ', '(i)', 'intern', 'contract ',
  'staffing -', 'temp ', 'advisory role', '(advisory)'
];

/**
 * searchJobs(query, options) → Array of normalized job objects
 *
 * options: { apiKey, limit, datePosted, track }
 * datePosted: 'today' | '3days' | 'week' | 'month' (default: '3days')
 */

// Trusted apply domains — skip jobs that only link to aggregator spam sites
const TRUSTED_DOMAINS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com',
  'lever.co', 'greenhouse.io', 'workday.com', 'myworkdayjobs.com',
  'jobvite.com', 'icims.com', 'taleo.net', 'smartrecruiters.com',
  'apply.workable.com', 'jobs.ashbyhq.com', 'boards.greenhouse.io',
  'careers.', 'jobs.', 'apply.',  // company career subdomains
  'randstadusa.com', 'weworkremotely.com', 'remote.co',
  'builtin.com', 'dice.com', 'monster.com', 'ziprecruiter.com',
  'simplyhired.com', 'ladders.com', 'wellfound.com', 'angel.co',
];

const BLOCKED_DOMAINS = [
  'flexionis.', 'anchorpoint.social', 'hiredock.', 'careerprogrid.',
  'jooble.org', 'jobleads.com', 'learn4good.com', 'recruit.net',
  'novaedge.', 'grabjobs.', 'everydayvacancies.', 'hirefromhome.',
  'career.zycto.', 'contractsmanagerjobs.', 'securityjobzone.',
  'taskium.', 'tealhq.com', 'jobright.ai', 'lensa.com',
];

function isTrustedApplyUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Block known spam aggregators
    if (BLOCKED_DOMAINS.some(d => hostname.includes(d))) return false;
    // Allow known trusted domains
    if (TRUSTED_DOMAINS.some(d => hostname.includes(d))) return true;
    // Allow company career pages (heuristic: direct employer domains with /jobs or /careers)
    if (url.includes('/careers/') || url.includes('/jobs/') || url.includes('/apply/')) return true;
    return false;
  } catch { return false; }
}

export async function searchJobs(query, options = {}) {
  const {
    apiKey,
    limit = 20,
    datePosted = '3days',
    track = null,
    remoteOnly = true,
  } = options;

  if (!apiKey) throw new Error('JSearch: apiKey is required');

  const numPages = Math.ceil(limit / 10);
  const jobs = [];
  const seenIds = new Set();

  for (let page = 1; page <= numPages && jobs.length < limit; page++) {
    const params = new URLSearchParams({
      query: query, // remoteOnly filter applied via job_requirements param below
      page: String(page),
      num_pages: '1',
      date_posted: datePosted,
      country: 'us',
      language: 'en',
    });

    const res = await fetch(`${JSEARCH_BASE}/search?${params}`, {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': JSEARCH_HOST,
      },
    });

    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) throw new Error(`JSearch error: ${res.status} ${res.statusText}`);

    const body = await res.json();
    const data = body.data || [];

    for (const item of data) {
      if (jobs.length >= limit) break;
      if (seenIds.has(item.job_id)) continue;
      seenIds.add(item.job_id);

      const normalized = normalizeJob(item);

      // Title relevance filter
      if (track) {
        const titleLower = normalized.title.toLowerCase();
        const relevant = (TRACK_KEYWORDS[track] || []).some(kw => titleLower.includes(kw));
        if (!relevant) continue;
      }

      // Exclude entry-level / contract by title
      const titleLower = normalized.title.toLowerCase();
      if (EXCLUDED_TITLE_TERMS.some(t => titleLower.includes(t))) continue;

      // Skip jobs without a trusted apply URL (aggregator spam)
      if (!normalizeJob(item).trustedUrl) continue;

      // Skip contract / part-time employment types
      const empTypes = item.job_employment_types || [];
      if (empTypes.some(t => ['CONTRACTOR', 'PARTTIME', 'INTERN'].includes(t))) continue;

      jobs.push(normalized);
    }
  }

  return jobs;
}

/**
 * normalizeJob(raw) → normalized job object compatible with existing scorer/tailor/queue
 */
function normalizeJob(item) {
  // Best apply link: prefer direct apply links
  const directLink = (item.apply_options || []).find(o => o.is_direct)?.apply_link;
  const applyUrl = directLink || item.job_apply_link || item.job_google_link || '';

  // Salary: use midpoint or max for scoring
  let salary = null;
  if (item.job_min_salary && item.job_max_salary) {
    salary = Math.round((item.job_min_salary + item.job_max_salary) / 2);
  } else if (item.job_max_salary) {
    salary = item.job_max_salary;
  } else if (item.job_min_salary) {
    salary = item.job_min_salary;
  }

  // Build description from available fields
  const highlights = item.job_highlights || {};
  const highlightText = [
    ...(highlights.Responsibilities || []),
    ...(highlights.Qualifications || []),
    ...(highlights.Benefits || []),
  ].join('\n');

  const description = [item.job_description || '', highlightText].filter(Boolean).join('\n\n');

  return {
    jobId:       item.job_id,
    title:       (item.job_title || '').replace(/\s*with verification\s*/gi, '').trim(),
    company:     item.employer_name || 'Unknown',
    location:    [item.job_city, item.job_state].filter(Boolean).join(', ') || 'Remote',
    remote:      item.job_is_remote || false,
    salary:      salary,
    salaryRaw:   salary ? `$${salary.toLocaleString()}/yr` : '',
    description: description,
    applyUrl:    applyUrl,
    url:         item.job_google_link || applyUrl,
    easyApply:   false, // JSearch doesn't track LinkedIn Easy Apply
    trustedUrl:  isTrustedApplyUrl(applyUrl),
    connections: 0,     // JSearch doesn't have LinkedIn connections data
    publisher:   item.job_publisher || '',
    postedAt:    item.job_posted_at || '',
    source:      'jsearch',
  };
}
