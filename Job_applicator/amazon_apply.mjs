#!/usr/bin/env node
// amazon_apply.mjs — stage 3 for amazon.jobs. Deterministic everywhere except
// the Job-specific questions step, which is the only part that genuinely
// differs per requisition.
//
//   node amazon_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]
//                               [--endpoint http://localhost:9226] [--keep-tab]
//                               [--refill-questions] [--no-llm]
//
// Why this exists: the amazon.jobs wizard is the same twelve steps on every
// posting, and cache/amazon.json already records every selector, quirk and
// answer rule the model rediscovered. The 2026-08-09 Annapurna run cost $3.99
// and 33 turns to do three things: skip SMS, set two radios, replace the
// carried-over resume. None of that needs a model, so this script does it with
// hard selectors instead.
//
// The exception is Job-specific questions, whose wording and options are
// written per requisition. There the split is: scrape the fields from the DOM
// (no model) -> ONE text-only claude call that never sees the page (field list
// + the candidate's own files in, JSON out) -> fill the answers from the DOM
// (no model). Answers cache to answers/{slug}.jobq.json, so re-running the
// same posting costs nothing. --no-llm blocks instead of calling.
//
// What it will NOT do, by design:
//   - guess an answer. Every value comes from profile.json; a step this script
//     has no rule for is reported in blocked_on, never improvised.
//   - type a credential. Sign-in is the two-click "Login with Amazon" consent
//     flow from portal_rules.json; an expired retail session stops the run.
//   - submit with a carried-over resume. The tailored PDF must be uploaded in
//     THIS run and its filename must be visible on the page (the submit
//     precondition in portal_rules.json).
//
// Writes answers/{slug}.drive.json in the same shape drive_application.sh
// expects from the model path, so the two are interchangeable downstream.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked,
// a human has to finish it. On 2 the tab is left open on purpose.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(BASE, '..');
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
let slug = '';
let resumeArg = '';
let endpoint = process.env.CDP_ENDPOINT || 'http://localhost:9226';
let allowSubmit = true;
let dryRun = false;
let keepTab = false;
let refillQuestions = false;
let noLlm = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--resume') resumeArg = argv[++i];
  else if (a === '--endpoint') endpoint = argv[++i];
  else if (a === '--no-submit') allowSubmit = false;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--keep-tab') keepTab = true;
  else if (a === '--refill-questions') refillQuestions = true;
  else if (a === '--no-llm') noLlm = true;
  else if (a === 'swe' || a === 'ml' || a === 'robotics') { /* role: stage 2 owns it */ }
  else if (a.startsWith('-')) fail(`unknown flag: ${a}`);
  else if (!slug) slug = a;
}
if (!slug) fail('usage: amazon_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]');
if (slug !== path.basename(slug)) fail(`bad slug: ${slug}`);

function fail(msg) {
  console.error(`AMAZON_ERR: ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------ slug -> posting
// resolve_slug.py is the single shared lookup all three stages use, so this
// script can never disagree with stage 1 or 2 about which posting a slug means.
let url;
try {
  url = execFileSync('python3', [path.join(BASE, 'resolve_slug.py'), slug], {
    cwd: BASE, encoding: 'utf8',
  }).trim();
} catch {
  fail(`no pipeline.csv row whose slugify(company,title) == '${slug}'`);
}
const host = new URL(url).host.toLowerCase();
if (!/(^|\.)amazon\.jobs$/.test(host)) {
  fail(`${host} is not amazon.jobs — use drive_application.sh for this posting`);
}

// Every amazon.jobs posting URL carries the numeric job id, and the applicant
// wizard is addressed by that id alone.
const jobId = (url.match(/\/jobs\/(\d+)/) || [])[1];
if (!jobId) fail(`no numeric job id in ${url}`);
const applyUrl = `https://www.amazon.jobs/en-US/applicant/jobs/${jobId}/apply`;

// --------------------------------------------------------------- preflight
const jdPath = path.join(BASE, 'jd', `${slug}.txt`);
const statusPath = path.join(BASE, 'answers', `${slug}.drive.json`);
const jobqPath = path.join(BASE, 'answers', `${slug}.jobq.json`);
const cachePath = path.join(BASE, 'cache', 'amazon.json');
const profile = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8'));

// Stage 3 never fetches a JD and never tailors a resume: a missing artefact
// means an earlier stage failed, and the chain stops rather than applying with
// nothing or with the generic resume.
if (!fileHasBytes(jdPath)) fail(`no JD at ${jdPath} — run stage 1 first: ./get_jd.sh ${slug}`);

let resume = resumeArg || path.join(BASE, 'resumes', `${slug}.pdf`);
let resumeKind = 'tailored';
if (!fileHasBytes(resume)) {
  resume = profile.resume_path;
  resumeKind = 'generic';
  console.error(`WARN: no resumes/${slug}.pdf — run stage 2 (./tailor_resume.sh ${slug}).`);
  console.error('      Falling back to the generic resume; SUBMIT IS BLOCKED for this run.');
}
if (!fileHasBytes(resume)) fail(`no resume at ${resume}`);
resume = path.resolve(resume);
const resumeName = path.basename(resume);
if (resumeKind === 'generic') allowSubmit = false;

function fileHasBytes(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

if (dryRun) {
  console.log(JSON.stringify({
    slug, url, apply_url: applyUrl, host, ats: 'amazon', job_id: jobId,
    cache: cachePath, jd: jdPath, resume, resume_kind: resumeKind,
    driver: noLlm ? 'deterministic (no-llm)' : 'deterministic + llm for job-specific questions',
    job_questions_cache: fileHasBytes(jobqPath) && !refillQuestions ? jobqPath : null,
    submit_allowed: allowSubmit,
  }));
  process.exit(0);
}

// ------------------------------------------------------------ answer mapping
// Values are DERIVED from profile.json, never hardcoded here. If profile ever
// says something these maps do not cover, the run blocks instead of guessing.
const q = profile.application_questions || {};
const sponsorship = yesNo(q.require_sponsorship_now_or_future);
const govEmployee = yesNo(q.government_or_public_institution_employment_past_5y);

function yesNo(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'yes' || s === 'true') return 'yes';
  if (s === 'no' || s === 'false') return 'no';
  return null;
}

const radioPlan = [
  {
    // profile: F-1 OPT, EAD holder, will require sponsorship in the future.
    // Never state sponsorship is not required.
    name: 'REQUIRE_SPONSORSHIP',
    value: sponsorship === 'yes' ? 'YES' : sponsorship === 'no' ? 'NO' : null,
    from: 'application_questions.require_sponsorship_now_or_future',
  },
  {
    name: 'GEF_EXT_USA_GOVERNMENT_EMPLOYEE',
    value: govEmployee === 'no' ? 'NEVER' : null, // FORMER/CURRENT are a human call
    from: 'application_questions.government_or_public_institution_employment_past_5y',
  },
];

// ------------------------------------------------------------------- run log
const state = {
  slug,
  url,
  ats: 'amazon',
  driver: 'deterministic',
  job_id: jobId,
  steps_completed: [],
  filled: [],
  left_for_human: [],
  blocked_on: [],
  cache_updated: false,
  submitted: false,
  submitted_evidence: '',
  already_applied: false,
  already_applied_evidence: '',
  ready_to_submit: false,
  resume_uploaded_this_run: false,
  nav_states: [],
};

const log = (...m) => console.error('AMAZON:', ...m);

// Thrown to unwind to the finally block once something lands in blocked_on.
// Declared before the run so the catch below can test it.
class Blocked extends Error {}
// Not a failure: the req already has an application on file. It unwinds the run
// like Blocked does, but leaves blocked_on empty so the exit code stays 0.
class AlreadyApplied extends Error {}

// These two are used from inside the run below, so they must be initialised
// before it — a `const` further down the file is still in its temporal dead
// zone when top-level await reaches it (that is the "Cannot access 'norm'
// before initialization" from the 2026-08-09 run).
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// Whitespace- and punctuation-free comparison key, for matching a step name
// against the nav item it came from when the two were read different ways.
const squeeze = (s) => norm(s).replace(/[^a-z0-9]/g, '');

const SAVE_CONTINUE = [
  'a:has-text("Save & continue")', 'button:has-text("Save & continue")',
  'a:has-text("Save and continue")', 'button:has-text("Save and continue")',
  'button:has-text("Next")', 'a:has-text("Next")',
  'button:has-text("Continue")', 'a:has-text("Continue")',
];

let browser;
let exitCode = 0;
try {
  // The shared browser is persistent and sometimes busy — a heavy SPA tab has
  // made /json/version take 5s, and a 20s connect then timed out and killed an
  // otherwise healthy run (2026-08-09). Give it room and one retry.
  for (let tries = 1; ; tries++) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 60000 });
      break;
    } catch (e) {
      if (tries >= 3) throw e;
      log(`CDP connect attempt ${tries} failed, retrying: ${String(e.message || e).split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context over CDP');

  // Reuse a tab already on amazon.jobs rather than leaking another one, and
  // match on the registrable domain: signing in moves the tab to
  // account.amazon.jobs, and that is exactly when there is work worth keeping.
  const reg = (h) => h.split('.').slice(-2).join('.');
  let page = ctx.pages().find((p) => {
    try { return reg(new URL(p.url()).host) === 'amazon.jobs'; } catch { return false; }
  });
  if (!page) page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  // Only navigate when the tab is not already inside THIS job's wizard —
  // re-entering /apply on a part-filled application is safe, but throwing away
  // a sign-in round trip is not.
  if (!page.url().includes(`/jobs/${jobId}/apply`)) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await dismissBanner(page);

  // A consent tab left over from an earlier attempt carries that attempt's
  // redirect_uri, so approving it would land the run on the wrong job. Close
  // them before starting; the SSO click opens a fresh one.
  for (const p of ctx.pages()) {
    if (/amazon\.com\/ap\//.test(p.url()) && p !== page) await p.close().catch(() => {});
  }

  page = await ensureSignedIn(ctx, page);
  if (state.blocked_on.length) throw new Blocked();
  page.setDefaultTimeout(20000);

  // amazon.jobs answers "you already applied to this req" by redirecting the
  // apply URL to /summary?result=duplicate (or ?result=application). There is
  // no wizard on that page, so the nav wait below timed out and the run reported
  // "the wizard may have changed shape" — four postings in the 2026-08-11 run,
  // each of which then sat in pipeline.csv as unapplied and got re-queued to
  // rediscover the same thing. The redirect is unambiguous: read it, record it,
  // and stop. This is Amazon's own statement about an application that exists,
  // not an inference from page text.
  // Called TWICE, and that is the point. The redirect is a client-side
  // navigation that lands after sign-in resolves, so reading the URL once here
  // saw the pre-redirect /apply and classified nothing — the run then blamed the
  // form ("the wizard may have changed shape") for all five limit-reached
  // postings on 2026-08-12. Classify before the wait for the fast case, and
  // again when the wait fails, which is where the redirect has actually landed.
  const classifyLanding = () => {
    let result = null;
    try { result = new URL(page.url()).searchParams.get('result'); } catch { return false; }
    if (!result) return false;
    // An application already on file. Amazon's own statement, not an inference.
    if (result === 'duplicate' || result === 'application') {
      state.already_applied = true;
      state.already_applied_evidence = page.url();
      log(`amazon.jobs reports an application already on file for this req (result=${result}) — nothing to fill`);
      throw new AlreadyApplied();
    }
    // The account cap on open applications. Not a posting problem and not a
    // wizard change: re-running never clears it, so the queue should say so.
    if (result.startsWith('application_limit_reach')) {
      state.blocked_on.push('amazon.jobs application limit reached for this account —'
        + ' no further applications accepted until open ones are closed out'
        + ` (${page.url()})`);
      return true;
    }
    return false;
  };

  if (classifyLanding()) throw new Blocked();

  await page.waitForSelector('li.form-list-item a.form-link.nav-link', { timeout: 30000 })
    .catch(() => {
      if (classifyLanding()) return;
      state.blocked_on.push(`the My progress nav never rendered at ${page.url()} — the wizard may have changed shape`);
    });
  if (state.blocked_on.length) throw new Blocked();

  state.nav_states.push({ at: 'arrival', steps: await navSteps(page) });
  log('arrival nav:', JSON.stringify(state.nav_states[0].steps));

  // The wizard reveals its steps progressively — on arrival the nav listed nine
  // of the twelve, with Work Eligibility, Job-specific questions and Review not
  // yet present (observed 2026-08-09). So the flow cannot be a fixed sequence of
  // calls: it re-reads the nav every pass and handles whatever is unfinished.
  await walkWizard(page);
  if (state.blocked_on.length) throw new Blocked();

  state.ready_to_submit = state.resume_uploaded_this_run;

  if (!allowSubmit) {
    state.left_for_human.push('submit withheld (--no-submit or generic resume) — form is filled and waiting on a manual Submit');
  } else if (!state.ready_to_submit) {
    state.blocked_on.push('tailored resume was not confirmed on the page this run — refusing to submit with a carried-over one');
  } else {
    // A step can report success and still not be saved — Work Eligibility did
    // exactly that on 2026-08-09, and Submit bounced silently back to the top
    // of the wizard. The nav is the only truth: every step but Review must
    // carry `finished` before Submit is worth clicking.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const unfinished = (await navSteps(page))
        .filter((s) => s.state !== 'finished' && !isReview(s.text));
      if (!unfinished.length) break;
      log(`not submitting yet — unfinished: ${unfinished.map((s) => s.text).join(', ')}`);
      if (attempt === 2) {
        state.blocked_on.push(`refusing to submit: ${unfinished.map((s) => s.text).join(', ')} never reached "finished" — the step saved without its answers`);
        break;
      }
      await walkWizard(page);
      if (state.blocked_on.length) break;
    }
    if (!state.blocked_on.length) await submit(page);
  }
} catch (err) {
  if (!(err instanceof Blocked) && !(err instanceof AlreadyApplied)) {
    state.blocked_on.push(`unexpected failure: ${String(err && err.message || err).slice(0, 300)}`);
  }
} finally {
  exitCode = state.blocked_on.length ? 2 : 0;
  writeStatus();
  await appendCacheRun();
  // An application Amazon already holds is applied, whether or not this run is
  // what put it there. Leaving the row FALSE is what re-queued these postings.
  if (state.submitted || state.already_applied) markApplied();
  await closeOrKeepTab();
  try { await browser?.close(); } catch { /* already detached */ }
}

console.log(JSON.stringify(state, null, 2));
process.exit(exitCode);

// =========================================================================
// steps
// =========================================================================

async function dismissBanner(page) {
  for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept All Cookies")', 'button[data-testid="cookie-accept-all"]']) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 1200 })) {
        await el.click({ timeout: 4000 }).catch(() => el.click({ force: true, timeout: 4000 }));
        await page.waitForTimeout(1000);
        return;
      }
    } catch { /* not this portal's banner */ }
  }
}

// The passport.amazon.jobs email+password form is NOT the way in: its password
// is not on file and typing there produced the ambiguous
// "username/password doesn't match our records" twice on 2026-08-09. The only
// supported path is Login with Amazon against the retail session this browser
// profile already holds, which is two clicks and no credential.
// Returns the page the wizard is actually on, which is NOT necessarily the page
// passed in: "Login with Amazon" opens the consent screen in a NEW TAB, and the
// clicked tab sits on passport.amazon.jobs forever. Both runs on 2026-08-09
// blocked with "no Login with Amazon control" for exactly that reason — the
// consent tab was open the whole time, just not the one being watched. So each
// iteration re-scans the context instead of trusting one page handle.
async function ensureSignedIn(ctx, startPage) {
  let page = startPage;
  const CONSENT = [
    'input[name="acknowledgementApproved"]',
    '#consent-approve-button',
    'input[name="consentApproved"]',
    'input[type="submit"][aria-labelledby*="allow"]',
    'button:has-text("Allow")',
  ].join(', ');
  const live = () => ctx.pages().filter((p) => !p.isClosed());
  const find = (re) => live().find((p) => { try { return re.test(p.url()); } catch { return false; } });

  for (let attempt = 0; attempt < 10; attempt++) {
    // Already through: the wizard is open somewhere.
    const wizard = find(/amazon\.jobs\/.*\/applicant\/jobs\//);
    if (wizard) return wizard;

    // The OAuth consent tab, wherever it is, is the work.
    const consentTab = find(/amazon\.com\/ap\//);
    if (consentTab) {
      page = consentTab;
      await page.bringToFront().catch(() => {});
      const approve = page.locator(CONSENT).first();
      if (await approve.count()) {
        // The approve control is an <input type=submit> named
        // acknowledgementApproved with value "agree button" — no text, no id,
        // so :has-text("Allow") never matches it (read off the live page).
        log('approving the Login with Amazon consent screen');
        await approve.click({ timeout: 15000 }).catch(() => approve.click({ force: true, timeout: 15000 }));
        await page.waitForURL((u) => !/amazon\.com\/ap\//.test(u.href), { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
        continue;
      }
      if (await page.locator('input[type="password"], input[name="password"]').count()) {
        state.blocked_on.push(`Amazon asked to re-authenticate at ${page.url().slice(0, 90)} — the retail session expired. Sign in manually in the job browser (VNC :5900), then re-run.`);
        return page;
      }
      await page.waitForTimeout(2000);
      continue;
    }

    // Not signed in yet: passport is the gate. Its email+password form is NOT
    // the way in (portal_rules.json) — only the SSO link is.
    const passport = find(/passport\.amazon\.jobs/) || page;
    if (/passport\.amazon\.jobs/.test(passport.url())) {
      page = passport;
      const sso = page.locator('a:has-text("Login with Amazon"), button:has-text("Login with Amazon")').first();
      if (!(await sso.count())) {
        if (attempt < 8) { await page.waitForTimeout(2000); continue; }
        state.blocked_on.push('on passport.amazon.jobs but no "Login with Amazon" control — sign in manually in the job browser (VNC :5900), then re-run');
        return page;
      }
      log('signing in via Login with Amazon (opens a second tab)');
      await sso.click().catch(() => {});
      // Give the popup a moment to exist; the next iteration finds it by scan.
      await page.waitForTimeout(3000);
      continue;
    }

    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  state.blocked_on.push(`could not reach the applicant wizard; stuck at ${page.url().slice(0, 120)}`);
  return page;
}

// The wizard is a single-URL SPA, so the My progress list is the only progress
// signal there is. State lives on the <li>, the label on the <a>.
async function navSteps(page) {
  return page.$$eval('li.form-list-item', (els) => els.map((li) => {
    const a = li.querySelector('a.form-link.nav-link');
    const state = (li.className.match(/\b(finished|active|next-form)\b/) || [])[1] || 'not-started';
    return { text: (a?.textContent || '').replace(/\s+/g, ' ').trim(), state };
  }).filter((s) => s.text));
}

async function clickNav(page, name) {
  const links = page.locator('li.form-list-item a.form-link.nav-link');
  const n = await links.count();
  const want = squeeze(name);
  for (let i = 0; i < n; i++) {
    // Compare with every space and punctuation stripped. navSteps() reads
    // textContent and gets "SMS NotificationsOptional"; innerText here renders
    // the same node as "SMS Notifications Optional". That one space meant the
    // step name never matched its own nav item, clickNav returned false, and
    // the handler gave up silently — the wizard then looked "stuck" with no
    // reason given (2026-08-09).
    const t = squeeze(await links.nth(i).innerText().catch(() => ''));
    if (t === want || t.startsWith(want) || want.startsWith(t)) {
      // href is javascript:void(0) — the step can only be reached by clicking.
      await links.nth(i).click({ timeout: 15000 }).catch(() => links.nth(i).click({ force: true }));
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

// Every step panel keeps its own copy of the navigation controls in the DOM —
// eleven "Save & continue" nodes on the Contact information step, all 0x0
// except the active panel's. `.first()` therefore locks onto a hidden one and
// clicks nothing at all, which is exactly how the 2026-08-09 runs "clicked"
// Save & continue three times without the step ever advancing. Enumerate and
// take the first VISIBLE match instead.
async function clickFirst(page, selectors, { timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    for (const sel of selectors) {
      const all = page.locator(sel);
      const n = Math.min(await all.count().catch(() => 0), 20);
      for (let i = 0; i < n; i++) {
        const el = all.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 10000 }).catch(() => el.click({ force: true, timeout: 10000 }));
        await page.waitForTimeout(1500);
        return sel;
      }
    }
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

// Visible validation text is the one honest signal that a step needs an answer
// this script does not have.
async function validationErrors(page) {
  return page.$$eval(
    '.invalid-feedback, .error-message, [role="alert"], .a-alert-content',
    (els) => els
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 300),
  ).catch(() => []);
}

// A function declaration, not a const: everything below the run block is
// reached by top-level await before its own line executes, so a const here is
// in its temporal dead zone. Same trap as `norm` one run earlier.
function isReview(t) { return norm(t).startsWith('review'); }

// The wizard hands out its steps a few at a time, so the only correct control
// flow is: read the nav, handle whatever is unfinished, read it again. A fixed
// call sequence blocked on 2026-08-09 looking for a Work Eligibility item the
// page had not revealed yet.
async function walkWizard(page) {
  let stuck = 0;
  for (let pass = 0; pass < 25; pass++) {
    const steps = await navSteps(page);
    state.nav_states.push({ at: `pass-${pass}`, steps });
    const pending = steps.filter((s) => s.state !== 'finished' && !isReview(s.text));
    if (!pending.length) break;

    // Work the active step when there is one; the wizard unlocks in order.
    const step = pending.find((s) => s.state === 'active') || pending[0];
    const before = JSON.stringify(steps);
    await handleStep(page, step);
    if (state.blocked_on.length) return;

    const after = JSON.stringify(await navSteps(page));
    if (before === after) {
      if (++stuck >= 2) {
        state.blocked_on.push(`"${step.text}" would not advance — the nav is unchanged after two attempts`);
        return;
      }
      await page.waitForTimeout(1500);
    } else {
      stuck = 0;
    }
  }

  // portal_rules.json: Amazon never offers the resume in the Continue flow, so
  // My progress -> Resume is the only way in, and reaching Review is too late.
  if (!state.resume_uploaded_this_run) await uploadResume(page);
}

async function handleStep(page, step) {
  const t = norm(step.text);

  if (t.startsWith('sms notifications')) {
    // Optional step: skip it, never enable SMS. Two things about this panel,
    // both found on 2026-08-09: the Skip control is an <a class="btn"> ~800px
    // down the page (not a <button>, and below the fold), and clicking it opens
    // a confirmation modal — "Are you sure you want to skip and continue?" with
    // a "Yes, skip section" button. Without that second click the step never
    // advances and nothing on the page says why.
    if (!(await clickNav(page, step.text))) {
      state.blocked_on.push(`could not open "${step.text}" in My progress`);
      return;
    }
    const hit = await clickFirst(page, [
      'a:has-text("Skip & continue")', 'button:has-text("Skip & continue")', 'button:has-text("Skip")',
    ]);
    if (!hit) {
      state.blocked_on.push('no "Skip & continue" control on the SMS Notifications step');
      return;
    }
    const confirmed = await clickFirst(page, [
      'button:has-text("Yes, skip section")', 'button:has-text("Yes, skip")', 'button:has-text("Yes")',
    ], { timeout: 8000 });
    state.steps_completed.push(step.text);
    state.filled.push(`SMS Notifications: skipped, left disabled${confirmed ? '' : ' (no confirmation modal appeared)'}`);
    return;
  }

  // Identity verification asks for a photo of a government ID and a live
  // selfie taken through a third-party portal, behind an "I consent to
  // identity verification" checkbox. A script must not tick that consent for
  // the candidate, and could not complete the capture anyway. Hand it over.
  if (t.startsWith('identity verification')) {
    state.left_for_human.push(
      'Identity verification: needs you in person — tick "I consent to identity verification", click '
      + '"Begin identity verification", then upload a photo of your government ID and take the selfie '
      + '(camera required). Re-run this slug afterwards and it will carry on to Review & submit.',
    );
    state.blocked_on.push('Identity verification requires a government ID photo and a live selfie — a human step, by design');
    return;
  }

  if (t.startsWith('contact information')) {
    await contactInformation(page, step.text);
    return;
  }

  if (t.startsWith('work eligibility')) {
    await workEligibility(page, step.text);
    // The resume upload belongs immediately after these questions, before any
    // further Continue. Getting that order wrong is the known failure.
    if (!state.blocked_on.length && !state.resume_uploaded_this_run) await uploadResume(page);
    return;
  }

  if (/job.specific/.test(t)) {
    await jobSpecificQuestions(page);
    return;
  }

  // Everything else is carried over from a previous application and only needs
  // its Save & continue. If it needs more, say which field, and stop rather
  // than guessing.
  if (!(await clickNav(page, step.text))) {
    state.blocked_on.push(`could not open "${step.text}" in My progress`);
    return;
  }
  await acceptAcknowledgements(page, step.text);

  const empty = await emptyRequiredFields(page);
  if (empty.length) {
    state.blocked_on.push(`"${step.text}" has required field(s) this script has no rule for: ${empty.map((f) => f.label || f.name).join(', ').slice(0, 300)}`);
    return;
  }

  await clickFirst(page, SAVE_CONTINUE);
  const errs = await validationErrors(page);
  if (errs.length) {
    state.blocked_on.push(`"${step.text}" needs an answer this script has no rule for: ${errs.slice(0, 4).join(' | ')}`);
    return;
  }
  state.steps_completed.push(step.text);
}

// Amazon pre-fills most of Contact information from the account, but the LEGAL
// first and last name come back empty on a new application even when the
// preferred names are populated — that is what stalled the 2026-08-09 run with
// no visible error: an empty required field and a nav item that simply refuses
// to leave "active". Every value here comes from profile.json, and a field that
// already holds something is never overwritten.
async function contactInformation(page, navText) {
  if (!(await clickNav(page, navText))) {
    state.blocked_on.push('could not open "Contact information" in My progress');
    return;
  }
  const a = profile.address || {};
  const map = [
    ['input[name="applicant[first_name]"]', profile.first_name, 'legal first name'],
    ['input[name="applicant[last_name]"]', profile.last_name, 'legal last name'],
    ['input[name="applicant[email_addresses][0][address]"]', profile.email, 'email'],
    ['input[type="tel"]', profile.phone, 'phone'],
    ['input[name="applicant[addresses][0][street]"]', a.street, 'street'],
    ['input[name="applicant[addresses][0][city]"]', a.city, 'city'],
    ['input[name="applicant[addresses][0][zip_code]"]', a.zip, 'zip'],
  ];

  for (const [sel, value, what] of map) {
    if (!value) continue;
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    if (String(await el.inputValue().catch(() => '')).trim()) continue; // already carried over
    await el.fill(String(value), { timeout: 10000 }).catch(() => {});
    if (String(await el.inputValue().catch(() => '')).trim()) state.filled.push(`Contact information: ${what}`);
  }

  const empty = await emptyRequiredFields(page);
  if (empty.length) {
    state.blocked_on.push(`Contact information still has empty required field(s): ${empty.map((f) => f.label || f.name).join(', ').slice(0, 300)}`);
    return;
  }

  await clickFirst(page, SAVE_CONTINUE);
  const errs = await validationErrors(page);
  if (errs.length) {
    state.blocked_on.push(`Contact information: ${errs.slice(0, 4).join(' | ')}`);
    return;
  }
  state.steps_completed.push(navText);
}

// A required text/select left empty is the failure mode that produces no error
// text at all: the step just refuses to advance. Naming the field beats looping.
async function emptyRequiredFields(page) {
  return page.$$eval('input:not([type=hidden]), select, textarea', (els) => els
    .filter((e) => e.offsetParent
      && (e.required || e.getAttribute('aria-required') === 'true')
      && !['radio', 'checkbox', 'file'].includes(e.type)
      && !String(e.value || '').trim())
    .map((e) => {
      const l = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
      const label = (l ? l.textContent : '') || e.getAttribute('aria-label') || e.placeholder || '';
      return { name: e.name || e.id || e.type, label: label.replace(/\s+/g, ' ').trim().slice(0, 60) };
    })).catch(() => []);
}

async function workEligibility(page, navText = 'Work Eligibility') {
  if (!(await clickNav(page, navText))) {
    state.blocked_on.push('no "Work Eligibility" item in My progress');
    return;
  }
  for (const plan of radioPlan) {
    if (!plan.value) {
      state.blocked_on.push(`profile.json ${plan.from} is not a value this script maps to a ${plan.name} option — answer it manually`);
      continue;
    }
    const r = await setRadio(page, plan.name, plan.value);
    if (r.ok) {
      if (r.why !== 'already set') state.filled.push(`Work Eligibility: ${plan.name} -> ${plan.value}`);
    } else if (r.why === 'field not on page') {
      // Amazon carries most of this step over; a missing radio means it was
      // already answered on a previous application, which is fine.
      log(`${plan.name} not present (carried over)`);
    } else {
      state.blocked_on.push(`could not set ${plan.name}=${plan.value} on Work Eligibility (${r.why})`);
    }
  }
  if (state.blocked_on.length) return;

  await clickFirst(page, SAVE_CONTINUE);
  const errs = await validationErrors(page);
  if (errs.length) {
    state.blocked_on.push(`Work Eligibility still shows: ${errs.slice(0, 4).join(' | ')}`);
    return;
  }
  state.steps_completed.push('Work Eligibility');
}

// These are custom-styled radios: the sibling <label> swallows a real click
// even with force, so the click is dispatched on the raw input. Re-locate by
// CSS after every DOM mutation; refs captured earlier go stale.
async function setRadio(page, name, value) {
  const sel = `input[name="${name}"][value="${value}"]`;
  const el = page.locator(sel).first();
  if (!(await el.count())) return { ok: false, why: 'field not on page' };
  if (await el.isChecked().catch(() => false)) return { ok: true, why: 'already set' };
  const r = await clickControl(page, el);
  return r.ok ? r : { ok: false, why: r.why };
}

// Clicking the LABEL is the only reliable way to set these controls, and the
// order matters. dispatchEvent('click') on the raw input flips the DOM property
// — isChecked() then returns true — but the page's own state never registers
// it, so the value is absent from the saved payload. That is what silently
// dropped REQUIRE_SPONSORSHIP on 2026-08-09: the run reported the radio set,
// the step saved without it, and Submit bounced back with no error shown.
// A real click on the <label> is what a human does and what the app sees.
async function clickControl(page, input) {
  const id = await input.getAttribute('id').catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id}"]`).first();
    if (await label.count()) {
      await label.click({ timeout: 8000 }).catch(() => label.click({ force: true, timeout: 8000 }).catch(() => {}));
      await page.waitForTimeout(400);
      if (await input.isChecked().catch(() => false)) return { ok: true, why: 'label click' };
    }
  }
  // A wrapping <label> is the other common shape.
  const wrap = input.locator('xpath=ancestor::label[1]');
  if (await wrap.count()) {
    await wrap.first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    if (await input.isChecked().catch(() => false)) return { ok: true, why: 'wrapping label click' };
  }
  await input.check({ force: true, timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  if (await input.isChecked().catch(() => false)) return { ok: true, why: 'forced check' };
  return { ok: false, why: 'still unchecked after label click and forced check' };
}

// =========================================================================
// Job-specific questions — the one step a model is allowed to touch
// =========================================================================
//
// Everything else in this wizard is the same on every posting, so it is hard
// selectors and profile.json values. This step is not: the questions are
// written per requisition and their answers depend on the JD. So the split is
//
//   scrape the fields    -> deterministic (DOM, no model)
//   choose the answers   -> ONE text-only claude call, no browser, no tools
//   fill the answers     -> deterministic (DOM, no model)
//
// The model never sees the page and never clicks anything. It gets a field
// list and the candidate's own files, and returns JSON. Answers are cached to
// answers/{slug}.jobq.json so a re-run of the same posting costs nothing.

// The section is fully dynamic: it may hold one question or ten, it may be
// absent from the wizard entirely, and answering can REVEAL more questions
// (profile.json notes "Are you located in US?" only appearing once the others
// were answered). So this is a loop — scrape, answer what is new, fill, save,
// scrape again — not a single pass.
async function jobSpecificQuestions(page) {
  const steps = await navSteps(page);
  const step = steps.find((s) => /job.specific/i.test(s.text));
  if (!step) return; // section absent on this requisition: nothing to answer
  if (step.state === 'finished' && !refillQuestions) {
    log('job-specific questions already finished — leaving them alone');
    return;
  }
  if (!(await clickNav(page, step.text))) {
    state.blocked_on.push(`could not open "${step.text}" in My progress`);
    return;
  }

  // Answers are remembered by QUESTION TEXT, not by field key or option id:
  // the keys are positional (q1, q2 …) on a form whose controls carry no name
  // and no id, so only the wording is stable across renders and re-runs.
  const memory = loadQuestionMemory();
  let dirty = false;

  for (let round = 0; round < 5; round++) {
    const fields = await scrapeQuestions(page);
    if (!fields.length) {
      await clickFirst(page, SAVE_CONTINUE);
      break;
    }
    log(`job-specific questions, round ${round + 1}: ${fields.length} field(s)`);

    const unknown = fields.filter((f) => !memory[f.question]);
    if (unknown.length) {
      if (noLlm) {
        state.blocked_on.push(`${unknown.length} unanswered job-specific question(s) and --no-llm was passed: ${unknown.map((f) => f.question.slice(0, 60)).join(' | ').slice(0, 300)}`);
        return;
      }
      const plan = await askModel(unknown, await scrapeSectionHtml(page));
      if (!plan) return; // askModel filled blocked_on
      for (const f of unknown) {
        const a = plan.answers[f.key];
        if (a !== undefined && a !== null && a !== '') memory[f.question] = a;
      }
      dirty = true;
    }

    // A required question with no answer means the model would not invent one.
    const missing = fields.filter((f) => f.required && memory[f.question] === undefined);
    if (missing.length) {
      if (dirty) saveQuestionMemory(memory);
      state.blocked_on.push(`no truthful answer available for required question(s): ${missing.map((f) => `"${f.question.slice(0, 90)}"`).join(' | ').slice(0, 400)}`);
      return;
    }

    for (const f of fields) {
      const answer = memory[f.question];
      if (answer === undefined || answer === null || answer === '') continue;
      const ok = await fillQuestion(page, f, answer);
      const shown = String(Array.isArray(answer) ? answer.join(', ') : answer).slice(0, 60);
      if (ok) {
        state.filled.push(`${step.text}: ${f.question.slice(0, 60)} -> ${shown}`);
      } else if (f.required) {
        state.blocked_on.push(`could not set required "${f.question.slice(0, 80)}" (${f.kind}) to ${shown}`);
      } else {
        // Optional and unreachable — the AI-preference consent radios render
        // 0x0 with a 0x0 label on some postings. Leaving Amazon's own default
        // in place is correct; refusing to submit over it is not.
        state.left_for_human.push(`optional question left at its default (control not interactable): ${f.question.slice(0, 80)}`);
      }
    }
    if (dirty) { saveQuestionMemory(memory); dirty = false; }
    if (state.blocked_on.length) return;

    await clickFirst(page, SAVE_CONTINUE);
    const errs = await validationErrors(page);
    const after = (await navSteps(page)).find((s) => /job.specific/i.test(s.text));
    if (!errs.length && (!after || after.state === 'finished')) {
      state.steps_completed.push(step.text);
      return;
    }
    // Still here: either validation complained or answering revealed more
    // questions. Both are handled by going round again on a fresh scrape.
    if (round === 4) {
      state.blocked_on.push(`"${step.text}" would not clear after five rounds${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
    }
  }
}

function loadQuestionMemory() {
  if (refillQuestions || !fileHasBytes(jobqPath)) return {};
  try {
    const prev = JSON.parse(fs.readFileSync(jobqPath, 'utf8'));
    return prev.by_question || {};
  } catch { return {}; }
}

function saveQuestionMemory(memory) {
  fs.writeFileSync(jobqPath, `${JSON.stringify({
    slug, job_id: jobId, date: TODAY, by_question: memory,
  }, null, 2)}\n`);
}

// Pure DOM read. Groups radios/checkboxes by name, pulls each question's text
// from the nearest legend or label, and records the option VALUES so the model
// can only ever pick something the form actually accepts.
// Tags every control in the visible question section with a data-jobq marker
// and returns the section's own HTML alongside the parsed field list. The model
// reads the real markup — so a control this parser mis-reads is still visible
// to it — while filling stays keyed to the markers, which are unambiguous.
async function scrapeSectionHtml(page) {
  return page.evaluate(() => {
    const vis = (el) => !!(el.offsetParent || el.getClientRects().length || ['radio', 'checkbox'].includes(el.type));
    const boxes = [...document.querySelectorAll('.question, .form-group')].filter(vis)
      .filter((b) => b.querySelector('input:not([type=hidden]), select, textarea'));
    if (!boxes.length) return '';

    // Innermost containers only, so a wrapper does not duplicate its children.
    const inner = boxes.filter((b) => !boxes.some((o) => o !== b && b.contains(o)));
    const strip = (html) => html
      .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, '')
      .replace(/\s(class|style|data-reactid|jsaction)="[^"]*"/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ');
    return inner.map((b) => strip(b.outerHTML)).join('\n\n').slice(0, 24000);
  });
}

async function scrapeQuestions(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Radios and checkboxes are routinely 0x0 with opacity:0 (custom-styled
    // controls), so element size alone cannot decide visibility — but treating
    // every radio as visible by definition pulled the AI-preference control in
    // from a DIFFERENT, hidden step panel, and the run then blocked because it
    // could not be clicked (2026-08-09). The honest test is whether anything in
    // the control's own box chain is actually laid out.
    const isVisible = (el) => {
      const boxed = (n) => !!(n && n.getBoundingClientRect && n.getBoundingClientRect().width > 0);
      if (boxed(el)) return true;
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (boxed(l)) return true;
      }
      let e = el.parentElement;
      for (let i = 0; i < 4 && e; i++, e = e.parentElement) if (boxed(e)) return true;
      return false;
    };

    // Amazon's screening questions have NO name and NO id — three required
    // selects on 2026-08-09 were keyed by nothing at all, so a name-keyed
    // scraper simply did not see them and the step came back "1 field" while
    // the page reported three required errors. Identity here is a computed
    // selector, which every element has.
    const cssPath = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let e = el;
      while (e && e.nodeType === 1 && parts.length < 8) {
        if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
        let part = e.tagName.toLowerCase();
        const sibs = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(e) + 1})`;
        parts.unshift(part);
        e = e.parentElement;
      }
      return parts.join(' > ');
    };

    // The question text sits in a .question wrapper as its first line; the
    // control's own label only ever repeats the option strings.
    const questionFor = (el) => {
      const box = el.closest('.question') || el.closest('.form-group') || el.closest('fieldset');
      if (box) {
        const first = (box.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s.length > 3)[0];
        if (first) return first.slice(0, 300);
      }
      const aria = clean(el.getAttribute('aria-label'));
      if (aria) return aria;
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      return clean(el.name) || '(unlabelled field)';
    };

    const optionLabel = (input) => {
      if (input.id) {
        const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      const wrap = input.closest('label');
      return clean(wrap ? wrap.textContent : '') || clean(input.value);
    };

    const out = [];
    const seenGroup = new Set();
    let marker = 0;

    // A marker attribute on the live element is the fill handle: it survives a
    // re-render of the parser's assumptions and is what the model is asked to
    // key its answers by, since these controls carry no name and no id.
    const mark = (el) => {
      if (!el.getAttribute('data-jobq')) el.setAttribute('data-jobq', `jq${++marker}`);
      return `[data-jobq="${el.getAttribute('data-jobq')}"]`;
    };

    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.type || '').toLowerCase();
      if (el.disabled) continue;
      if (['hidden', 'submit', 'button', 'file', 'image', 'reset'].includes(type)) continue;
      if (!isVisible(el)) continue;
      // The wizard-wide fields this script already owns.
      if (['REQUIRE_SPONSORSHIP', 'GEF_EXT_USA_GOVERNMENT_EMPLOYEE'].includes(el.name)) continue;

      const required = !!(el.required || el.getAttribute('aria-required') === 'true');

      if (type === 'radio' || type === 'checkbox') {
        const groupKey = el.name || cssPath(el.closest('.question') || el.parentElement || el);
        if (seenGroup.has(groupKey)) continue;
        seenGroup.add(groupKey);
        const group = el.name
          ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)]
          : [el];
        out.push({
          key: mark(el).match(/jq\d+/)[0],
          kind: type,
          question: questionFor(el),
          required: required || group.some((g) => g.required),
          selector: mark(el),
          // Options are identified by LABEL, never by value: this form ships
          // radio groups whose options ALL have value="on" (consent-yes and
          // consent-no), so a value is not an answer.
          options: group.map((g) => ({ label: optionLabel(g), selector: mark(g) })),
        });
        continue;
      }

      if (el.tagName === 'SELECT') {
        out.push({
          key: mark(el).match(/jq\d+/)[0],
          kind: 'select',
          question: questionFor(el),
          required,
          selector: mark(el),
          options: [...el.options].filter((o) => o.value !== '')
            .map((o) => ({ label: clean(o.textContent), value: o.value })),
        });
        continue;
      }

      out.push({
        key: mark(el).match(/jq\d+/)[0],
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
        question: questionFor(el),
        required,
        selector: mark(el),
        options: [],
        maxlength: el.maxLength > 0 ? el.maxLength : undefined,
      });
    }
    return out;
  });
}

// One headless call. Text in, JSON out, no tools and no browser — the entire
// reason this file exists is that the model does not need to see the page.
async function askModel(fields, sectionHtml = '') {
  const read = (p, cap = 8000) => { try { return fs.readFileSync(p, 'utf8').slice(0, cap); } catch { return ''; } };
  const dataDir = path.join(BASE, 'data');
  const background = ['about_me.txt', 'work_experience.txt', 'technical_skills.txt', 'education.txt',
    'strengths.txt', 'career_goals.txt', 'current_projects.txt', 'suitability_swe.txt', 'suitability_ml.txt']
    .map((f) => { const t = read(path.join(dataDir, f), 4500); return t ? `--- data/${f} ---\n${t}` : ''; })
    .filter(Boolean).join('\n\n');

  // profile.json is the source of truth for structured answers, minus anything
  // that is a credential. Credentials never enter a prompt.
  const safeProfile = JSON.parse(JSON.stringify(profile));
  for (const k of Object.keys(safeProfile)) if (/password|secret|token/i.test(k)) delete safeProfile[k];

  const prompt = `You are answering the "Job-specific questions" step of an Amazon job application for Saketh Metta. You are given the section's real HTML as rendered, a parsed list of its controls, and the candidate's own files. Return JSON only.

RULES
- Answer ONLY from the sources below. Never invent an experience, a metric, an employer or a project.
- profile.json is authoritative for structured facts (salary, dates, authorization, contact).
- Sponsorship: always Yes. F-1 OPT, EAD holder, will require H1B sponsorship in the future. Never say sponsorship is not required.
- Experience questions mean PROFESSIONAL, non-internship experience unless the question says otherwise. Do not count coursework, personal projects or research as professional employment.
- Salary: give the profile.json value. Do not negotiate or elaborate.
- For a radio/checkbox/select control you MUST return one of that control's option LABELS, copied verbatim (an array of labels for checkbox). Option labels, not values: this form ships radio options that all share value="on".
- Free text: natural, direct voice, no em dashes, 100-180 words unless the question asks otherwise. Respect maxlength when given.
- If a question cannot be answered truthfully from these sources, set its answer to null and list it in "unanswerable". Do NOT guess. A wrong answer is worse than a blocked run.
- Key every answer by the control's "key" (jq1, jq2 …), which is also its data-jobq attribute in the HTML.

SECTION HTML (as rendered on the page)
${sectionHtml || '(not captured)'}

PARSED CONTROLS
${JSON.stringify(fields, null, 2)}

PROFILE (profile.json)
${JSON.stringify(safeProfile, null, 2)}

JOB DESCRIPTION (jd/${slug}.txt)
${read(jdPath, 12000)}

CANDIDATE BACKGROUND
${background}

OUTPUT
Reply with the JSON as your message text. Do not call any tool, do not run any command, do not validate it with python — just write it.
A single JSON object, nothing else:
{"answers": {"<key>": <option label | array of option labels | free text | null>, ...},
 "unanswerable": [{"key": "<key>", "why": "<one line>"}]}`;

  const model = process.env.AMAZON_Q_MODEL || 'claude-sonnet-5';
  const qLog = path.join(BASE, 'logs', `${slug}-jobq.log`);
  fs.mkdirSync(path.dirname(qLog), { recursive: true });

  // Routed through claude_retry.sh rather than calling claude directly: it is
  // the single place that knows the OmniRoute base URL and token ("auto/best-coding"
  // is an OmniRoute alias and 404s against api.anthropic.com), and it handles
  // 429/quota backoff. Duplicating either here would mean two sources of truth
  // for a credential.
  //
  // Run from an empty cwd with MCP disabled. Claude Code otherwise loads
  // career-ops's CLAUDE.md/AGENTS.md and the playwright MCP tool definitions
  // into a prompt that needs neither: measured 2026-08-09, that context alone
  // was $0.34 a call versus $0.20 without it. The question prompt is
  // self-contained by design.
  const sandbox = fs.mkdtempSync('/tmp/amazon-jobq-');
  // --allowedTools "" is not enough on its own: the model still reached for
  // Bash (to pipe its own JSON through python -m json.tool) and burned the
  // single turn, so a complete answer came back as error_max_turns. Name the
  // tools as disallowed AND leave a little turn headroom.
  const script = 'source "$1" >/dev/null 2>&1 || exit 3; '
    + 'run_claude "$2" -p "$3" --model "$4" --output-format json '
    + '--allowedTools "" --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" '
    + '--max-turns 4 --strict-mcp-config --mcp-config \'{"mcpServers":{}}\'';

  log(`asking the model to answer ${fields.length} job-specific question(s) (model=${model}, no tools, no browser)`);
  try {
    execFileSync('bash', ['-c', script, 'jobq', path.join(BASE, 'claude_retry.sh'), qLog, prompt, model], {
      cwd: sandbox,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 900000,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  } catch (e) {
    state.blocked_on.push(`the job-specific question call failed (see ${path.basename(qLog)}): ${String(e.message || e).slice(0, 160)}`);
    return null;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  // run_claude appends to the log; the newest "type":"result" line is the
  // envelope. Reading the tail rather than stdout is what makes the retry and
  // resume paths transparent here.
  let text;
  try {
    const lines = fs.readFileSync(qLog, 'utf8').split('\n').filter((l) => l.includes('"type":"result"'));
    if (!lines.length) throw new Error('no result line in the log');
    const env = JSON.parse(lines[lines.length - 1]);
    if (env.is_error) throw new Error(String(env.result || 'model returned is_error').slice(0, 160));
    text = String(env.result || '');
    state.model_cost_usd = env.total_cost_usd;
  } catch (e) {
    state.blocked_on.push(`could not read the model result from ${path.basename(qLog)}: ${String(e.message || e).slice(0, 200)}`);
    return null;
  }

  const json = text.match(/\{[\s\S]*\}/);
  let plan;
  try {
    plan = JSON.parse(json ? json[0] : text);
  } catch {
    state.blocked_on.push(`the model did not return JSON: ${text.slice(0, 200)}`);
    return null;
  }
  plan.answers = plan.answers || {};
  plan.unanswerable = plan.unanswerable || [];

  // The form, not the model, decides what is a legal answer.
  for (const f of fields) {
    const v = plan.answers[f.key];
    if (v === undefined || v === null) continue;
    if (f.options.length) {
      const legal = f.options.map((o) => norm(o.label));
      const picked = Array.isArray(v) ? v : [v];
      const bad = picked.filter((x) => !legal.includes(norm(x)));
      if (bad.length) {
        state.blocked_on.push(`model answered "${f.question.slice(0, 80)}" with ${JSON.stringify(bad)}, which is not one of that control's option labels`);
        return null;
      }
    } else if (f.maxlength && String(v).length > f.maxlength) {
      plan.answers[f.key] = String(v).slice(0, f.maxlength);
    }
  }
  for (const u of plan.unanswerable) state.left_for_human.push(`job-specific question unanswered: ${u.key || u.name} — ${u.why}`);
  return plan;
}

// Answers arrive as option ids (o1, o2, …) for anything with choices, and as
// plain text otherwise. Everything is located by the selector the scraper
// computed, so a field with no name and no id fills like any other.
async function fillQuestion(page, f, value) {
  const pick = (want) => f.options.find((o) => o.label === want)
    || f.options.find((o) => norm(o.label) === norm(want))
    || f.options.find((o) => norm(o.label).startsWith(norm(want)));
  try {
    if (f.kind === 'radio' || f.kind === 'checkbox') {
      const wanted = (Array.isArray(value) ? value : [value]).map(String);
      for (const label of wanted) {
        const opt = pick(label);
        if (!opt) return false;
        const box = page.locator(opt.selector).first();
        if (await box.isChecked().catch(() => false)) continue;
        // Same label-first rule as setRadio: a synthetic click on the input
        // sets the DOM property without the app ever seeing the change.
        if (!(await clickControl(page, box)).ok) return false;
      }
      return true;
    }

    if (f.kind === 'select') {
      const opt = pick(String(value));
      if (!opt) return false;
      // The native <select> lives inside a custom .drop-down-menu-select
      // widget, so Playwright's selectOption finds it unactionable and times
      // out. Set the value directly and fire the events the app listens for,
      // then confirm it stuck.
      await page.selectOption(f.selector, opt.value, { timeout: 5000 }).catch(async () => {
        await page.evaluate(({ sel, v }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { sel: f.selector, v: opt.value });
      });
      const got = await page.locator(f.selector).inputValue().catch(() => '');
      return got === opt.value;
    }

    await page.fill(f.selector, String(value), { timeout: 10000 }).catch(async () => {
      await page.evaluate(({ sel, v }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { sel: f.selector, v: String(value) });
    });
    return String(await page.locator(f.selector).inputValue().catch(() => '')).length > 0;
  } catch {
    return false;
  }
}

// Amazon reuses whatever resume the last application had and never offers a
// resume step in the Continue flow. My progress -> Resume is the only way in,
// and the step reads "finished" on arrival even when the attached PDF is stale.
async function uploadResume(page) {
  if (!(await clickNav(page, 'Resume'))) {
    state.blocked_on.push('no "Resume" item in My progress — cannot replace the carried-over resume');
    return;
  }

  let input = page.locator('#document-replace-input');
  if (!(await input.count())) {
    await clickFirst(page, ['button:has-text("Replace Resume")', 'a:has-text("Replace Resume")', 'button:has-text("Replace resume")', 'button:has-text("Upload")']);
    input = page.locator('#document-replace-input');
  }

  if (await input.count()) {
    await input.first().setInputFiles(resume);
  } else {
    // 2026-08-09 UI variant: Replace opens an inline chooser panel (Use
    // LinkedIn / Browse device / OneDrive / …), not a bare file input.
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 20000 }),
        clickFirst(page, ['a:has-text("Browse device")', 'button:has-text("Browse device")', 'a:has-text("Browse")']),
      ]);
      await chooser.setFiles(resume);
    } catch {
      state.blocked_on.push('found neither #document-replace-input nor a "Browse device" file chooser on the Resume step');
      return;
    }
  }

  // The submit precondition is the filename on the page, not the click.
  const ok = await page.waitForFunction(
    (name) => document.body.innerText.includes(name) || document.body.innerText.includes('Uploaded: Just now'),
    resumeName,
    { timeout: 45000 },
  ).then(() => true).catch(() => false);

  if (!ok) {
    state.blocked_on.push(`uploaded ${resumeName} but the page never confirmed it — treating as a stale resume, not submitting`);
    return;
  }

  const shown = await page.locator(`text=${resumeName}`).count().catch(() => 0);
  state.resume_uploaded_this_run = true;
  state.filled.push(`Resume: replaced carried-over PDF with ${resumeName}${shown ? '' : ' (confirmed by upload banner, filename not rendered)'}`);
  state.steps_completed.push('Resume');
  await clickFirst(page, SAVE_CONTINUE);
}

// Only REQUIRED checkboxes, and only the certify-this-is-true kind the
// candidate's standing submit authorization already covers. Optional boxes
// (marketing, talent-pool consent) are left exactly as Amazon set them.
async function acceptAcknowledgements(page, stepText) {
  if (!/acknowledg|certif|agreement/i.test(stepText)) return;
  const boxes = page.locator('input[type="checkbox"][required], input[type="checkbox"][aria-required="true"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (await box.isChecked().catch(() => true)) continue;
    const id = await box.getAttribute('id').catch(() => null);
    if (id) await page.locator(`label[for="${id}"]`).first().click({ force: true, timeout: 6000 }).catch(() => {});
    if (!(await box.isChecked().catch(() => false))) await box.check({ force: true, timeout: 6000 }).catch(() => {});
    if (await box.isChecked().catch(() => false)) state.filled.push(`${stepText}: checked the required acknowledgement`);
  }
}

// The review page is a recap of steps this script just filled. Reading it buys
// nothing, so it is not read — scroll, click, verify the redirect.
async function submit(page) {
  if (!(await clickNav(page, 'Review & submit'))) {
    state.blocked_on.push('no "Review & submit" item in My progress');
    return;
  }
  const hit = await clickFirst(page, [
    'button:has-text("Submit application")',
    'a:has-text("Submit application")',
    'button:has-text("Submit")',
  ], { timeout: 8000 });
  if (!hit) {
    state.blocked_on.push('no Submit control on Review & submit');
    return;
  }

  const ok = await page.waitForFunction(
    () => location.href.includes('result=success') || /thank you for your application/i.test(document.title),
    null,
    { timeout: 60000 },
  ).then(() => true).catch(() => false);

  // Amazon can route the Submit click itself into its identity-verification
  // portal (idverify.amazon, a Persona inquiry) rather than submitting — even
  // when the Identity verification nav item already reads "finished". That is
  // the government-ID-plus-selfie flow again, so it is a human step, not a
  // failure to retry.
  if (!ok && /idverify\.amazon|withpersona\.com/.test(page.url())) {
    state.left_for_human.push(
      'Submit was routed into Amazon\'s identity verification portal. Finish the ID photo and selfie in the open '
      + 'tab (it returns to the application with id_verification_complete=true), then re-run this slug to submit.',
    );
    state.blocked_on.push('Submit requires identity verification at idverify.amazon — a human step, by design');
    return;
  }

  if (!ok) {
    const errs = await validationErrors(page);
    state.blocked_on.push(`clicked Submit but never saw the success page${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ` (still at ${page.url()})`}`);
    return;
  }
  state.submitted = true;
  state.steps_completed.push('Review & submit');
  state.submitted_evidence = `Redirected to ${page.url()}, page title '${await page.title().catch(() => '')}'`;
  log('submitted:', state.submitted_evidence);
}

// =========================================================================
// bookkeeping
// =========================================================================

function writeStatus() {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(state, null, 2)}\n`);
}

// cache/{ats}.json is where a run records what it DISCOVERED. This driver
// discovers nothing new by design, so it only appends the run record — never
// rewrites the file, which is how a seeded auth block got destroyed once.
async function appendCacheRun() {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cache.runs_wizard = cache.runs_wizard || [];
    cache.runs_wizard.push({
      date: TODAY,
      job_id: jobId,
      driver: 'amazon_apply.mjs (no model)',
      result: state.submitted ? 'submitted'
        : state.already_applied ? 'already_applied'
          : state.blocked_on.length ? 'blocked' : 'filled_not_submitted',
      note: [state.filled.join('; '), state.blocked_on.join('; ')].filter(Boolean).join(' || ').slice(0, 600),
      nav_on_arrival: (state.nav_states[0]?.steps || []).map((s) => `${s.text}=${s.state}`).join(', '),
    });
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    state.cache_updated = true;
    writeStatus();
  } catch (e) {
    log('cache append skipped:', String(e.message || e));
  }
}

function markApplied() {
  try {
    execFileSync('python3', [path.join(BASE, 'mark_applied.py'), url], { cwd: ROOT, stdio: 'inherit' });
  } catch { log('mark_applied.py did not match a pipeline.csv row'); }
}

// A tab a human still has to finish stays open — closing it throws away the
// session they are about to pick up.
async function closeOrKeepTab() {
  const keep = keepTab || state.blocked_on.length || state.left_for_human.length;
  if (keep) {
    log(`leaving the tab open on amazon.jobs — ${state.blocked_on[0] || state.left_for_human[0] || 'requested'}`);
    return;
  }
  try {
    execFileSync(path.join(BASE, 'close_tabs.sh'), [url], { cwd: BASE, stdio: 'ignore' });
  } catch { /* cleanup never fails a run that already succeeded */ }
}
