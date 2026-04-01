# Job Hunt Automation — Build Spec

Build a Node.js ESM job hunt automation system. Write complete working code — no placeholders, no TODOs.

## Files to create:

### package.json
```json
{"name":"job-hunt","type":"module","dependencies":{"playwright":"^1.41.0"}}
```

### job-hunt-config.json
Config with: outputDir (./JobQueue), cookiePath (~/.job-hunt/linkedin-cookies.json), scoreThreshold (60), searchQueries for security track ["endpoint security specialist", "MDM engineer", "device management engineer"] and pm track ["security product manager", "MDM product manager", "IT platform PM"], filters object: {remote: true, minSalary: 110000, excludeEntryLevel: true, excludeContract: true}

### lib/scorer.mjs
Export `scoreJob(jobData, resumeData, track)`. Returns `{keyword_match, oe_compat, salary, connections, total}`.

Weights: keyword_match=30pts, oe_compat=25pts, salary=25pts, connections=20pts.

- keyword_match: extract skills/keywords from resumeData.work and resumeData.skills sections, count how many appear in jobData.description. Score = Math.min(30, matches * 3).
- oe_compat: count OE signals in description: ["async", "output-based", "flexible hours", "results-driven", "trust-based", "autonomous", "self-directed"]. Deduct if ["daily standup", "time tracking", "monitoring software", "screenshot"]. Score = Math.min(25, signals * 5) - deductions * 5.
- salary: if jobData.salary >= 110000 → 25pts. If unspecified → 12pts. Scale linearly below 110k.
- connections: jobData.connections > 0 → 20pts, else 0.

### lib/tailor.mjs
Export `tailorResume(resumeJson, jobDescription, track)`.

1. Extract top keywords from jobDescription (split on spaces, filter stopwords, count frequency, take top 10).
2. Pick 2-3 keywords that don't already appear in resumeJson.basics.summary.
3. Return deep copy of resumeJson with summary modified to naturally include those keywords. Keep summary professional and under 3 sentences.

### lib/queue.mjs
Export `writeJobToQueue(outputDir, date, job, scorecard, tailoredResume)`:
- slug = `${job.company}-${job.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
- Create dir: `{outputDir}/{date}/{slug}/`
- Write: job.json, scorecard.json, resume-tailored.json, apply.txt (just the URL)
- Return slug

Export `isDuplicate(outputDir, date, slug)`: check if dir exists.

Export `loadExistingSlugs(outputDir, date)`: return Set of existing slugs for the date.

### lib/scraper.mjs
Export class `LinkedInScraper`. 

```js
constructor(config) // stores config
async init(headless = true) // launch playwright chromium
async loadCookies(cookiePath) // load JSON cookie file into browser context
async saveCookies(cookiePath) // save cookies to JSON file, create parent dirs
async isLoggedIn() // navigate to linkedin.com/feed, check for .global-nav or #global-nav
async login() // open linkedin.com/login non-headless, poll isLoggedIn() every 2s up to 120s, then saveCookies
async searchJobs(query, filters) 
// Navigate to linkedin.com/jobs/search/?keywords={query}&f_AL=true&f_WT=2 (remote)
// Parse job cards: .job-card-container or [data-job-id]
// For each card extract: title, company, location, url, salary (if shown), easy_apply (boolean)
// Return array, up to filters.limit items
async scrapeJobDetail(url)
// Navigate to url with 10s timeout
// Extract: full job description (.jobs-description or .description__text)
// Extract 2nd degree connections count from sidebar (.jobs-premium-applicant-insights or similar)
// Return {description, connections: number}
async close() // close browser
```

Handle CAPTCHA/rate-limit: if page URL contains "checkpoint" or "authwall", throw new Error("RATE_LIMITED").

### daily-job-hunt.mjs
Main entry point.

```
Usage: node daily-job-hunt.mjs [--track security|pm|both] [--limit N] [--dry-run] [--login]
```

Flow:
1. Parse args (no deps, manual parseArgs)
2. Load job-hunt-config.json
3. Init LinkedInScraper
4. If --login: run scraper.login(), save cookies, exit
5. Load cookies. Call isLoggedIn(). If not logged in: print "Not authenticated. Run: node daily-job-hunt.mjs --login" and exit 1.
6. Load resume JSONs from Resume/kofi-resume-security.json and Resume/kofi-resume-pm.json
7. Get today's date YYYY-MM-DD
8. Load existing slugs to skip duplicates
9. For each track (security, pm, or both):
   - For each query in config.searchQueries[track]:
     - searchJobs(query, {...config.filters, limit: args.limit})
     - For each job result:
       - Check isDuplicate → skip if yes
       - scrapeJobDetail(job.url) with try/catch (timeout/rate-limit → log + break)
       - scoreJob(fullJob, resumeData, track)
       - if score.total < config.scoreThreshold → skip
       - tailorResume(resumeJson, fullJob.description, track)
       - if not --dry-run: writeJobToQueue(...)
       - Track stats: scraped, queued, skipped_dup, skipped_score, errors
10. Print summary:
```
═══════════════════════════════════════
 Job Hunt Run — YYYY-MM-DD
═══════════════════════════════════════
 Track: both | Scraped: 18 | Queued: 12
 Skipped (dup): 3 | Low score: 2 | Errors: 1

 Top 5 by score:
  92 │ Acme Corp — Security Engineer    │ Easy Apply │ 2nd°
  88 │ Beta Inc — MDM Platform PM       │ Easy Apply
  ...
═══════════════════════════════════════
```

## Notes
- All files use ESM (import/export)
- No external deps except playwright
- Cookie dir: create with fs.mkdirSync recursive if missing
- Graceful shutdown on SIGINT: close browser
