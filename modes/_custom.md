# Custom Instructions -- career-ops

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.

     Put your own house rules, custom workflows, and automations
     here -- anything you want the agent to ALWAYS do (or never do).

     This is for PROCEDURAL rules ("HOW I want things done").
     For WHO you are (archetypes, narrative, comp, negotiation),
     use modes/_profile.md instead. Keeping the two separate keeps
     each one readable.

     The agent reads this file alongside the system instructions;
     your rules here take precedence over the defaults, as long as
     they don't break the Data Contract (your files are never
     touched, and we never auto-submit an application for you).

     Because this is a user-layer file, anything you write here
     survives `node update-system.mjs`. Put customizations HERE,
     not in CLAUDE.md / modes/_shared.md / other system files --
     those get overwritten on update.
     ============================================================ -->

## House Rules

<!-- Rules the agent should always follow. Examples:
     - Always write evaluation summaries in British English.
     - Never include a photo in my CV (US / ATS-first market).
     - Cap each batch run at 20 listings unless I say otherwise.
     - If a report scores below 6, skip the cover letter. -->

- **MS Degree Completed on June 10, 2026** (added 2026-08-24): I finished and
  graduated with my Master of Science in Computer Science (Minor in AI) from
  Oregon State University on June 10, 2026. I am an alumnus/graduate, not a current
  student. All outreach notes, cover letters, and application responses must
  accurately reflect that I completed my MS on June 10, 2026, and never state that
  I am currently pursuing a degree or have a future expected graduation date.
- **Experience gate is mandatory after every scan** (added 2026-07-05): I have
  no professional experience (new grad). After any scan adds entries to
  `data/pipeline.md`, run `python3 experience_gate.py --date {today}` and then
  `python3 sync_pipeline_csv.py`. The gate fetches each JD (zero-token, ATS
  APIs) and removes offers whose minimum requirement exceeds
  `experience_filter.max_required_years` in `portals.yml` (currently 1), roles
  with level II/III/IV titles, and PhD-only roles (I hold an MS). Blocked
  entries get status `skipped_experience` in `data/scan-history.tsv`.
- **Never evaluate or apply to roles requiring 2+ years of experience** — if a
  JD's required qualifications demand years I don't have, skip it and mark it
  `skipped_experience`, even if the title looked entry-level.
- **After scan.mjs runs:** rewrite each new pipeline entry's trailing field
  from location to the scan date (`| YYYY-MM-DD`) — `sync_pipeline_csv.py`
  reads field 4 as the date.
- **Never scan, evaluate, or pipeline Palantir or Anduril — or any role
  requiring a US security clearance / US person status** (added 2026-07-12):
  I'm on an F-1 visa with no clearance, so these roles are ineligible
  regardless of title or seniority. Both companies are `enabled: false` in
  `portals.yml`; if their roles surface anyway (LinkedIn, WebSearch, referral
  links), skip them and mark `skipped_clearance` in `data/scan-history.tsv`.
  Same rule for any other JD whose requirements state active clearance,
  ability to obtain one, or US citizenship.
- **Auto-skip Amazon "Amazon Dedicated Cloud" / "ADC" roles** (added
  2026-07-14): any Amazon role with "Amazon Dedicated Cloud" or "ADC" in the
  title or team name is an air-gapped US-government-cloud role requiring
  TS/SCI clearance + US citizenship (confirmed in the 2026-07-13 scan:
  Network Infrastructure Engineer I, ADC — TS/SCI, polygraph, US citizen).
  Skip on title alone, no JD fetch needed; mark `skipped_clearance` in
  `data/scan-history.tsv`. This is a title-level shortcut for the general
  clearance rule above.
- **Every job source is a scan.mjs provider — nothing writes to
  `data/pipeline.csv` directly** (added 2026-08-05): the scrapers (LinkedIn via
  `Webscrapper/linkedin_scan_parser.py`, Indeed via `jobspy_scan_parser.py`,
  the JobRight new-grad lists via `jobright_scan_parser.py`) are all
  `local_parser` entries in `portals.yml`, so every one of them passes through
  the same gates: `title_filter`, `location_filter`, `data/blacklist.md`,
  scan-history dedup, then `experience_gate.py`. `data/pipeline.md` stays the
  single source of truth and `sync_pipeline_csv.py` regenerates the CSV from it.
  The old `python3 jobright.py data/pipeline.csv` step did the opposite — it
  appended straight to the CSV, bypassing every filter, and those rows were
  wiped by the next sync; don't reintroduce that pattern for a new source.
- **JobRight rows carry the EMPLOYER's apply URL, not a jobright.ai link**
  (added 2026-08-05): JobRight server-renders `applyLink`/`originalUrl` into a
  job page only for a logged-in session, so `jobright_scan_parser.py` resolves
  it using `JOBRIGHT_COOKIE` from `.env` and writes the employer URL into the
  pipeline (JobRight's `utm_source`/`jr_id` params stripped). Resolution is
  read-only by design: `/swan/job/apply` also returns the link but is a POST
  that records an application against the user's JobRight account — never use
  it. Links are cached per job id in `jobright_apply_cache.json`, so each
  posting costs one lookup ever.
  - **The cookie expires.** Check with
    `.venv-jobspy/bin/python jobright_login.py --check`; refresh by running
    `jobright_login.py` (no flags) and logging in when the browser opens. It
    reads cookies over CDP from the Chrome on port 9222 and validates them
    before saving. Without a valid cookie nothing breaks — the parser logs it
    and keeps jobright.ai links, and `jobright_relink.py` repairs them later.
  - `.env` holds a live session cookie: it is gitignored and chmod 600. Never
    commit it, never paste its value into a report, tracker note, or PR.
- **LinkedIn rows carry the EMPLOYER's apply URL, not a linkedin.com/jobs/view
  link** (added 2026-08-06): the same treatment as JobRight above, for the same
  reason — the pipeline should point at the place you actually apply. LinkedIn's
  guest job page hides the offsite apply target behind a sign-in modal, so
  `linkedin_apply.py` reads `applyMethod.companyApplyUrl` from the Voyager
  job-posting API using `LINKEDIN_COOKIE` from `.env`, unshortens `grnh.se`-style
  employer links, and strips tracking params. Cached per posting id in
  `linkedin_apply_cache.json`, so each posting costs one lookup ever.
  - **Easy Apply postings have no employer URL and correctly keep their
    linkedin.com link** — that IS their apply route. A linkedin.com URL left in
    the pipeline is not necessarily an unresolved row.
  - A `companyApplyUrl` pointing back at linkedin.com is only accepted when it
    is an apply path; some postings set it to the company *profile* page
    (`/company/111556386`), which would lose the posting entirely.
  - **The cookie expires.** Check with
    `.venv-jobspy/bin/python linkedin_login.py --check`; refresh by running
    `linkedin_login.py` (no flags) and logging in when the browser opens — it
    reads cookies over CDP from the Chrome on port 9222. Voyager needs the
    `JSESSIONID` value echoed as the `csrf-token` header, which is why the whole
    cookie header is stored rather than just `li_at`. Without a valid cookie
    nothing breaks: the parser logs it and keeps linkedin.com links.
  - **The parser drops postings already in scan history BEFORE resolving.**
    `scan.mjs` dedups on the URL the parser hands it, so a newly resolved
    employer URL would make a posting scanned last week look brand new.
    `linkedin_relink.py` keeps the original linkedin.com row in
    `data/scan-history.tsv` for the same reason — don't "clean up" those rows.
  - Lookups are bounded per run (parser: 200; `linkedin_relink.py --limit 60` in
    `run_scan.sh`) so a scan cannot blow past its `timeout_ms`. Whatever misses
    the budget keeps its LinkedIn link and is repaired on a later run.
- **Company names in `data/pipeline.csv` carry one leading space** (added
  2026-08-05): applied by `pad_company()` in `sync_pipeline_csv.py`, at the one
  place the CSV is written, so it survives every resync. `data/pipeline.md`
  stays unpadded — it is the source of truth and the padding is presentation
  only. Don't hand-edit the CSV to add it, and strip the company value before
  matching it against anything (tracker rows, blacklist, filenames).
- **Generic "Software Engineer" titles are allowed, and the STACK is judged
  from the JD** (added 2026-08-05): `title_filter.positive` now includes
  "Software Engineer" / "Software Developer" / "Software Development Engineer",
  because new-grad boards title most roles that way (788 of 798 rows in the
  JobRight SWE repo previously failed for having no positive keyword). A plain
  title says nothing about the stack, so `content_filter.by_title_keyword` in
  `portals.yml` scopes a description-level rule to *only* those three keywords:
  mobile tooling (xcode, cocoapods, swiftui, objective-c, android studio,
  jetpack compose, react native, flutter) and legacy/CRM stacks (cobol,
  mainframe, abap, salesforce, servicenow developer …) reject the posting, and
  at least one engineering signal must be present. Bare "kotlin"/"swift" are
  deliberately NOT negatives — polyglot employers list every language they use.
  `scan.mjs` applies this wherever a provider returns a description; the local
  parsers apply it themselves (via `scan_common.stack_gate`) because
  `local-parser.mjs` strips descriptions before scan.mjs sees them.
- **Never retro-apply the current filters to old pending entries** (added
  2026-08-05): tightening a filter governs FUTURE scans. Sweeping the whole
  pending list with today's `title_filter` deleted 57 DevOps/Embedded/SRE rows
  that predate those negatives — entries the user had deliberately kept. If a
  newly-added row slips through a filter gap, remove that row only.
- **Run `dedup_pipeline.py` as the last step of any scan** (added 2026-08-05):
  it collapses duplicate postings in `data/pipeline.md` (same URL, same job id,
  and same company+title within 45 days — the last one is how the same role
  surfaced by Indeed, LinkedIn and the employer's own Greenhouse board gets
  collapsed), prefers the employer's ATS URL over an aggregator redirect, never
  drops a row that already has a report, then regenerates and verifies
  `data/pipeline.csv`. `run_scan.sh` already ends with it.
- **New scan entries go at the TOP of the Pendientes section** (added
  2026-07-06): always insert new offers at the top of `data/pipeline.md`'s
  pending list, newest scan first, so `data/pipeline.csv` (which mirrors the
  file order) shows the latest additions in its first rows. Never append new
  entries to the bottom (scan.mjs appends — move them up before syncing).

## Custom Workflows

- **"run the pipeline" / "start the pipeline"**:
  Whenever the user says "run the pipeline" or "start the pipeline", execute the complete serial pipeline:
  1. **Scan**: Run `run_scan.sh` (or `node scan.mjs` + normalizers/experience gates/relink/dedup) to discover new postings and refresh `data/pipeline.csv`.
  2. **Per-Posting Loop (Serially, one application at a time)**:
     a. **Fill & Submit**: Fill the job application and submit it.
     b. **LinkedIn Outreach Drafting**: Draft a targeted LinkedIn outreach message for that company (preferring OSU alumni or relevant hiring managers/recruiters/peers).
     c. **Contact Deduplication**: If a person from that company has already been contacted (exists in `data/linkedin-outreach-queue.json` as sent/connected), select an alternative contact person from that company who has not been messaged yet.
     d. **Send Outreach**: Approve and send the LinkedIn outreach message for that application.
     e. **Iterate**: Proceed to the next application in the queue and repeat.

## Output Preferences

<!-- How you like results formatted. Examples:
     - Reports: lead with the score and the one-line verdict.
     - Show the per-step token breakdown after a batch run.
     - Save PDFs date-first: YYYY-MM-DD-company.pdf -->

(none yet -- add yours above)

## Off-Limits

<!-- Things the agent must never do for you. Examples:
     - Never auto-fill or submit an application without showing me first.
     - Never edit a system file to customize my setup -- put it here. -->

(none yet -- add yours above)
