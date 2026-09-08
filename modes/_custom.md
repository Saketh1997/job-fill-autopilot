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

- **agy fills, Claude reviews, agy submits** (added 2026-08-26): the application
  loop is split by what each model is actually good at. `agy` (gemini-3.7-flash,
  via `Job_applicator/agy_step.sh`) is the orchestrator — it navigates, clicks,
  types and uploads, because it has the quota for volume and is good at driving a
  browser. Claude is the planner — it never touches the browser; it reads the
  form back off the live page with `node Job_applicator/readback.mjs <slug>` and
  judges whether each answer is TRUE and actually answers the question asked.
  Per posting, serially:
    1. `./Job_applicator/agy_step.sh fill <slug>` — fills, never submits
       (delegates to `drive_application.sh --no-submit`, so the portal cache,
       credential resolution and honeypot rules all still apply)
    2. `node Job_applicator/readback.mjs <slug>` — live form -> reviewable sheet
    3. Claude reviews and writes `Job_applicator/answers/{slug}.corrections.json`
       with `verdict` ∈ submit | fix | hold
    4. if `fix`: `./Job_applicator/agy_step.sh fix <slug>`, then back to step 2
       (at most two fix rounds; a third means something is wrong that agy cannot
       resolve — set `hold` and leave the tab open)
    5. `./Job_applicator/agy_step.sh submit <slug>`
  Never ask agy to decide whether an answer is right, and never ask Claude to
  drive the browser. Crossing the two is what this split exists to prevent.
- **Verify a drafted contact EXISTS before sending to them** (added 2026-08-26
  after a fabricated one): `outreach-review.mjs` checks the profile URL's SHAPE
  (`linkedin.com/in/...`), not whether it resolves. A redraft produced
  "Mitanshu Hitesh Gada, SDE at Amazon", is_alumni true, evidence "as stated in
  his LinkedIn search snippet" — and the URL returned "This page doesn't exist".
  The note opened "as a fellow OSU grad". Two failures at once: an invented
  profile and an invented shared tie.
  So before approving any outreach draft:
    - open the profile URL and confirm it loads and is that person
    - if `is_alumni` is true, confirm Oregon State appears in their EDUCATION
      section, not in a search snippet. A snippet containing both the company
      and "Oregon State" proves nothing. (Tristan Luther at SpaceX checked out
      this way — BS ECE, OSU, 2017-2022 — so the check passes real ones too.)
    - a draft whose profile 404s is REJECTED, never re-pointed at someone else
  The sender must also be told: if a profile does not exist, record
  "profile_not_found" and stop — never substitute a different person.
- **agy will sometimes submit during a fix step. Assume it can** (added
  2026-08-26 after it happened): `agy_step.sh fix` tells the model three
  separate times not to submit — "DO NOT SUBMIT", "do not click Submit, Apply,
  Finish or Send", "if you find yourself on a confirmation page, something has
  gone wrong". On impact.com it set the field, clicked Submit anyway, and
  reported `"submitted": true` in the same result. Nothing in the shell can stop
  it: the model holds the browser for the whole turn.
  Two consequences, both now handled:
    - `agy_step.sh fix` DETECTS the breach, exits 3, marks the posting applied
      (otherwise a sent application sits at `applied=FALSE` forever, because the
      submitter that normally records it never ran), and appends to
      `Job_applicator/logs/guardrail-breaches.tsv`.
    - The real defence is ORDERING, not instruction: never leave a wrong or
      unverified answer standing while asking agy to fix a different field. Every
      correction batch must be safe to submit at the moment it is applied,
      because it might be. Fix the fabrications and the wrong values FIRST, and
      let the mechanical "did not commit" retries be the last round.
- **Check ELIGIBILITY against the JD before reviewing answers** (added
  2026-08-26, after a wasted application): a form whose every answer is true can
  still be an application the candidate cannot be hired from. The experience
  gate reads years-of-experience, and an internship asks for zero, so these sail
  straight through and every "new grad" marker in the posting rescues them.
  Two disqualifiers now gate at scan time in `experience_gate.py`
  (`skipped_enrollment`), and BOTH must also be checked by the reviewer before
  any submit, because a posting already in the pipeline predates the gate:
    - **active enrolment required** — "actively pursuing a degree", "must be
      currently enrolled", "rising junior/senior", "returning to school". The MS
      was COMPLETED 2026-06-10; he is an alumnus. Postings that accept *either*
      a student or a recent graduate are fine and are deliberately not blocked.
    - **graduation window** — "graduating between December 2026 and June 2027"
      excludes a June 2026 graduate just as firmly as requiring enrolment does.
      This is the one that got through: the Zip application was submitted with
      an honest 06/10/2026 graduation date against a window that opened six
      months later.
  When a posting is ineligible the verdict is `hold`, never `submit`, and the
  reason is the JD line itself. Do not try to answer around it: there is no
  wording of "when do you graduate" that makes an ineligible candidate eligible,
  and the only answers that would are false ones.
- **A filled form is volatile: never batch-fill and review later** (added
  2026-08-26): a filled application lives only as React state in a tab of the
  shared, persistent Chrome on :9226. It is not saved anywhere and it cannot be
  reconstructed. Anything that ends that tab throws the work away silently.
  Two separate causes hit this in one afternoon:
    - `prime_page.mjs` matched a tab by registrable domain, so each Greenhouse
      posting hijacked the previous one's tab (fixed — see `posting-identity.mjs`)
    - with tabs correctly kept, eight of them made Chrome heavy (881MB peak), it
      stopped answering CDP, and `job-browser.service` was restarted under it.
      Every filled form in the batch died at once.
  So the loop is **per posting, end to end**: fill -> readback -> review -> fix
  -> submit, and only THEN start the next one. One filled form is alive at a
  time and it is used within minutes of being created. Do not fill a queue and
  come back to review it; `run_agy_fill.sh` without `--slug` exists for filling
  a queue only when each posting will be submitted before the next begins.
  When a tab is lost anyway, the posting simply gets re-filled — the ledger in
  `output/agy-fill/ledger.json` must have its entry cleared first or the run
  skips it as already filled.
- **"Autofill from resume" paints the DOM without telling the form** (added
  2026-08-26, cost two failed Submit clicks): Greenhouse's and Ashby's
  autofill-from-resume features write a value into a control's *visible* state
  without firing the change event the form's own React state listens for. The
  chip says "Pennsylvania", the radio shows "Yes", every DOM read agrees the
  field is answered — and the form still rejects Submit with "This field is
  required" / "Missing entry for required field".
  Consequences that are now baked into the loop:
    - **agy's "verified: true" does not settle it.** Re-reading the value it
      just read is not evidence, because the stale value reads back perfectly.
      A fix must force a genuine change: CLEAR the control until the chip is
      gone (or click the other option), then open the dropdown / click the real
      option, and verify with `aria-invalid` or the disappearance of the error —
      never with the displayed text.
    - **`readback.mjs` flags this ahead of the click** for comboboxes: react-select
      keeps a committed choice in a sibling `.select__single-value` and keeps
      uncommitted typing in the input itself, so a field with input text and no
      chip is marked BLOCKER "TYPED BUT NOT COMMITTED". Radios and Ashby's
      button-groups cannot be told apart this way — for those the form's own
      post-Submit error is still the detector.
    - **A fix that toggles a control must never end on a false answer.** Any
      correction that says "click the other option to force an event" states the
      required final state explicitly and says to record a failure rather than
      leave the wrong value standing. Work authorization is the live example.
- **The planner never reads a DOM, and reads as little of a form as it can**
  (added 2026-08-26): Claude's context is the scarce resource in this loop, so
  nothing hands it raw page content — not a snapshot, not HTML, not a full field
  dump. `readback.mjs` triages the form deterministically first and prints only
  the controls that need a decision:
    - `BLOCKER` — required and empty, or named in a visible validation error
    - `MISMATCH` — the form holds something other than what `profile.json` says
    - `JUDGE` — `profile.json` has no answer, so agy improvised one
  Everything that simply matches `profile.json` is collapsed to a count, option
  lists are capped at 12, and long free text is clipped head-and-tail. The full
  sheet is always on disk at `Job_applicator/answers/{slug}.readback.json`; read
  it (or rerun with `--full`) only when a specific verdict actually needs it.
  agy's prompts forbid opening with a snapshot and forbid full-page snapshots
  for verification, so its own runs stay cheap too.
- **Push work to agy wherever judgement is not the bottleneck** (added
  2026-08-26): browser driving, navigation, form filling, correction-applying,
  uploads and submits are all agy's. Claude does the reviewing and nothing else.
  Zero-LLM steps (`scan.mjs`, `jd_extract.py`, `experience_gate.py`,
  `tailor_resume_local.mjs`, `readback.mjs`) stay zero-LLM — never hand a model
  a job a script already does deterministically.
- **Submit without showing me first** (added 2026-08-26, explicit standing
  decision): Claude's review at step 3 above IS the approval gate. Do not stop
  to show me a filled form and do not wait for a per-batch yes — I'm working and
  won't be watching. This deliberately overrides the AGENTS.md "never submit
  without the user reviewing first" default; it is scoped to the ATS application
  loop above and to nothing else. It does NOT extend to sending LinkedIn
  outreach, emails, or anything else that reaches a human directly.
  The refusals that still stand, and that this does not waive:
    - `ats_submit.mjs` re-audits the live form and refuses an empty required
      field, a visible validation error, a generic (untailored) resume, a
      missing tab, or a slug that already submitted
    - a CAPTCHA or emailed verification code is never solved or bypassed —
      the tab is left open and the posting is reported back to me
    - `verdict: hold` never submits; it stops and tells me why
    - a fabricated answer is never acceptable to get past a required field.
      If the answer is not in `cv.md`, `profile.json` or `Job_applicator/data/`,
      it stays empty and the posting is held.

## Custom Workflows

- **"run the pipeline" / "start the pipeline"** (loop rewritten 2026-08-26 —
  this is now the ONLY meaning of the phrase; agy orchestrates, Claude plans):
  Whenever the user says "run the pipeline" or "start the pipeline", execute the complete serial pipeline:
  1. **Scan**: Run `run_scan.sh` (or `node scan.mjs` + normalizers/experience gates/relink/dedup) to discover new postings and refresh `data/pipeline.csv`.
  2. **Per-Posting Loop (Serially, one application at a time)**:
     a. **Fill & Submit** — agy drives the browser, Claude judges the answers,
        and Claude never opens a page. Per posting:
        i.   `./Job_applicator/get_jd.sh <slug>` — zero-LLM JD fetch (often
             already cached by `experience_gate.py` during the scan)
        ii.  `./Job_applicator/tailor_resume.sh <slug> <swe|ml|robotics>` —
             near-zero-LLM tailoring, hard-gated by `verify-cv-facts.mjs`
        iii. `./Job_applicator/agy_step.sh fill <slug>` — agy
             (gemini-3.7-flash) fills the whole form and CANNOT submit
        iv.  `node Job_applicator/readback.mjs <slug>` — deterministic triage of
             the live form; prints only BLOCKER / MISMATCH / JUDGE controls
        v.   Claude reviews only those, and writes
             `Job_applicator/answers/{slug}.corrections.json`
             (`verdict`: submit | fix | hold)
        vi.  on `fix`: `./Job_applicator/agy_step.sh fix <slug>`, then back to
             (iv). At most two fix rounds, then `hold`.
        vii. on `submit`: `./Job_applicator/agy_step.sh submit <slug>` — which
             routes Greenhouse/Lever/Ashby through `ats_submit.mjs` so the live
             form is re-audited one last time.
        Submit without stopping to ask (standing decision above). Never let agy
        judge whether an answer is right; never let Claude drive the browser.
     b. **LinkedIn Outreach Drafting**: `Job_applicator/linkedin-draft.sh <slug>
        <company> <role> <jd_url>`. The drafter works DOWN a preference ladder
        and must commit: (1) an OSU alumnus on or beside the team that owns the
        role, (2) any OSU alumnus at the company, (3) a non-alumni in-house
        recruiter / eng manager / tech lead / team peer who owns the role.
        Tiers 2 and 3 are real answers. A draft returning `contact_name: null`
        while listing three usable `alt_targets` is a FAILURE, not caution — it
        means nobody gets contacted for that posting. Never invent a person, a
        title, or a profile URL.
     c. **Contact Deduplication** — mechanical, not advisory. Anyone at that
        employer already at status sent / approved / connected / pending_approval
        is off limits. Company matching is on a NORMALISED key, so "Amazon",
        " Amazon.com Services LLC" and "Amazon Web Services, Inc." are one
        employer, and a short name never substring-swallows a longer one ("Zip"
        must not match "Zipline"). Dedup is on the PERSON (profile URL first,
        name second), because the same human reachable under three employer
        names is still one human. This was a real incident: Amit Bawaskar was
        messaged twice, once under each Amazon legal name, *after* the prompt
        had been told not to. A rule in a prompt is not enforcement.
     d. **Outreach Review (Claude, before anything sends)**:
        `node outreach-review.mjs` triages every pending draft and prints only:
          - `BLOCKER` — no contact, a repeat person, note over 300 chars, an em
            dash, or text implying the candidate is a current student
          - `MISMATCH` — the draft's own claims contradict each other (inmail
            channel without alumni+high referral power, `is_alumni` with no
            evidence, `referral_power: none`, a bad `contact_type`)
          - `JUDGE` — nothing mechanical is wrong; Claude decides whether this
            is the right person and whether the message says only true things
        Every factual claim in a note must trace to `cv.md`. A note may not
        imply a shared school, employer or connection that does not exist —
        on a tier-3 contact the OSU opener is a false claim of a shared tie.
     e. **Send Outreach**: only after (d) clears it —
        `Job_applicator/linkedin-approve.sh <slug> approve` then
        `Job_applicator/linkedin-send.sh <slug>`. The standing "don't show me
        first" decision applies here too: a draft that passes every mechanical
        gate AND Claude's read of contact-fit and truthfulness goes out without
        stopping. What does NOT go out on Claude's say-so, because this reaches
        a named human and cannot be recalled:
          - anything still BLOCKER or MISMATCH after a redraft
          - any note whose factual claims Claude cannot trace to `cv.md`
          - any contact whose fit Claude is genuinely unsure of
        Those are collected and raised with the user instead of being sent.
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
