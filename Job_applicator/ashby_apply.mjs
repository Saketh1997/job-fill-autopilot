#!/usr/bin/env node
// ashby_apply.mjs — stage 3 for jobs.ashbyhq.com. Deterministic fill, one
// batched model call for whatever the form asks that profile.json and the
// answer cache do not already cover. Same contract as amazon_apply.mjs.
//
//   node ashby_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]
//                               [--endpoint http://localhost:9226] [--keep-tab]
//
// Ashby specifics this encodes:
//   - the posting API 401s for most orgs, so ashby_jd.py can only emit a
//     "(discover on page)" marker. Unlike Greenhouse and Lever, there is no
//     useful schema here: the form IS the schema, read off the DOM at run time.
//   - the application lives at {posting}/application, and on the posting page
//     itself the form is behind an Apply button.
//   - controls are React: system fields are named _systemfield_*, custom
//     questions carry a uuid, and every choice control is a custom combobox
//     whose options exist in the DOM only while it is open.
//   - the file input is present but visually hidden; setInputFiles works on it
//     directly, and Ashby renders the filename once it lands.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked.

import {
  parseArgs, die, resolveSlug, preflight, newState, connect, tabFor,
  dismissBanner, validationErrors, clickFirst, uploadFile,
  auditRequired, missingRequired, reconcileBlocked, submitAndVerify, writeStatus, appendCacheRun,
  markApplied, closeOrKeepTab, attachDocuments, alreadySubmitted, startWatchdog,
} from './ats_apply_common.mjs';
import { answerRemaining, fillScraped } from './ats_questions.mjs';
import { reviewFilled } from './ats_review.mjs';

// A required file input is only "already satisfied" when it IS the resume
// field. Greenhouse's Celonis posting also requires a Cover Letter, and
// exempting every file input let the run call the form complete, click Submit,
// and get back "Cover Letter is required." with nothing to explain it.
const isResumeField = (f) => /resume|cv\b/i.test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`);

const ATS = 'ashby';
const FORM = 'form, [class*="application"], main';

const opts = parseArgs(process.argv.slice(2),
  'usage: ashby_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]');
const { slug } = opts;
let { allowSubmit } = opts;

const posting = resolveSlug(slug);
const host = new URL(posting).host.toLowerCase();
if (!/(^|\.)ashbyhq\.com$/.test(host)) die(`${host} is not ashbyhq.com — wrong driver for this posting`);

const base = posting.split('?')[0].replace(/\/application\/?$/, '').replace(/\/$/, '');
// Some orgs publish the posting ONLY as an embed on their own careers site
// (greptile.com/careers -> iframe jobs.ashbyhq.com/<org>/<jid>/application?embed=js).
// Ashby 404s that posting without the embed param, so dropping the query with
// the rest of the string turned a live posting into "the posting may be closed".
// Carry `embed` (and nothing else) across onto the apply URL.
const embed = new URL(posting).searchParams.get('embed');
const applyUrl = `${base}/application${embed ? `?embed=${encodeURIComponent(embed)}` : ''}`;
const org = (new URL(posting).pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase();

const pre = preflight({ slug, resumeArg: opts.resumeArg, ats: ATS });
if (!opts.force && alreadySubmitted(pre.statusPath)) {
  console.error(`ASHBY: ${slug} was already submitted (answers/${slug}.drive.json) — not applying twice. --force overrides.`);
  process.exit(0);
}
if (pre.resumeKind === 'generic') allowSubmit = false;

const state = newState({ slug, url: posting, ats: ATS });
state.apply_url = applyUrl;
state.resume = pre.resume;
state.resume_kind = pre.resumeKind;
const log = (...m) => console.error('ASHBY:', ...m);

if (opts.dryRun) {
  console.log(JSON.stringify({
    slug, url: posting, apply_url: applyUrl, host, ats: ATS, org,
    jd: pre.jdPath, schema: pre.schemaPath, plan: pre.planPath,
    resume: pre.resume, resume_kind: pre.resumeKind,
    planned_fields: Object.keys(pre.plan),
    note: 'Ashby exposes no form schema over its public API — every field is read off the page at run time',
    submit_allowed: allowSubmit,
  }, null, 2));
  process.exit(0);
}

class Blocked extends Error {}

let browser;
let exitCode = 0;
startWatchdog(opts.deadlineMs, state, pre.statusPath, log);
try {
  browser = await connect(opts.endpoint, log);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context over CDP');

  const page = await tabFor(ctx, posting);
  page.setDefaultTimeout(20000);
  if (!page.url().startsWith(applyUrl)) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await dismissBanner(page);

  // On some orgs /application still renders the posting with the form behind
  // an Apply button.
  if (!(await page.locator('input[type="file"]').count())) {
    await clickFirst(page, [
      'button:has-text("Apply for this Job")', 'a:has-text("Apply for this Job")',
      'button:has-text("Apply")', 'a:has-text("Apply")',
    ], { timeout: 6000 });
    await page.waitForTimeout(1500);
  }

  await page.waitForSelector('input[type="file"], input[name*="_systemfield"]', { timeout: 30000 })
    .catch(() => {
      state.blocked_on.push(`no application form at ${page.url()} — the posting may be closed`);
    });
  if (state.blocked_on.length) throw new Blocked();

  await fillForm(page);
  // Required files that are not the resume (transcript, cover letter).
  await attachDocuments(page, FORM, pre.profile, state, log, pre.schema, slug);
  await review(page);
  await finish(page);
} catch (err) {
  if (!(err instanceof Blocked)) {
    state.blocked_on.push(`unexpected failure: ${String((err && err.message) || err).slice(0, 300)}`);
  }
} finally {
  exitCode = state.blocked_on.length ? 2 : 0;
  writeStatus(pre.statusPath, state);
  appendCacheRun(pre.cachePath, state, { apply_url: applyUrl, org });
  writeStatus(pre.statusPath, state);
  if (state.submitted) markApplied(posting);
  await closeOrKeepTab(posting, state, opts.keepTab, log);
  try { await browser?.close(); } catch { /* already detached */ }
}

console.log(JSON.stringify(state, null, 2));
process.exit(exitCode);

// =========================================================================

async function fillForm(page) {
  // Resume first — Ashby parses it and fills name/email from it, which would
  // overwrite anything written before the parse lands.
  const fileInput = page.locator('input[type="file"]').first();
  if (await uploadFile(page, fileInput, pre.resume)) {
    await page.waitForTimeout(3000);
    // Ashby does not print the filename anywhere the page text can be read
    // from, so the input itself is the evidence: its value comes back as
    // C:\fakepath\{name} and its files list holds the real entry. Checking the
    // body text called a landed upload a failure.
    const wanted = pre.resume.split('/').pop();
    const shown = await page.locator('input[type="file"]').first()
      .evaluate((el, w) => (el.files?.[0]?.name || (el.value || '').split(/[\\/]/).pop() || '')
        === w ? w : '', wanted)
      .catch(() => '');
    if (shown) {
      state.resume_uploaded_this_run = true;
      state.filled.push(`resume=${shown}`);
      state.verified.push('resume');
      log('resume attached:', shown);
    } else {
      state.blocked_on.push('resume input accepted the file but the page never showed the filename');
    }
  } else {
    state.blocked_on.push('no file input on the Ashby application form');
  }

  // Everything else. There is no schema to work from here, so the whole form
  // goes through the shared pass: profile.json for structured facts, then
  // cache/ashby-answers.json, then ONE model call for what is left.
  await answerRemaining({
    page,
    // Ashby renders no <form> element; scope to the application container.
    formSel: (await page.locator('form').count()) ? 'form' : 'body',
    ats: ATS,
    company: org,
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
  });
}

// Read the filled form back and correct what is wrong before the audit decides
// the form is complete. The audit can only see empty vs non-empty; this is the
// only step that looks at whether the answers are right. It matters most here:
// Ashby's API gives no schema at all, so every answer on this form came from
// the page plus a model rather than from a declared field list.
async function review(page) {
  if (!opts.review) { log('review pass skipped (--no-review)'); return; }
  await reviewFilled({
    page,
    formSel: (await page.locator('form').count()) ? 'form' : 'body',
    ats: ATS,
    company: org,
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
  });
}

async function finish(page) {
  const formSel = (await page.locator('form').count()) ? 'form' : 'body';
  const fields = await auditRequired(page, formSel);
  reconcileBlocked(state, fields);
  const missing = missingRequired(fields)
    .filter((f) => f.type !== 'file' || !isResumeField(f) || !state.resume_uploaded_this_run);
  for (const f of missing) {
    state.blocked_on.push(`required field ${f.label || f.name} (${f.name}) is still empty`);
  }

  const errs = await validationErrors(page);
  if (errs.length) state.blocked_on.push(`form shows validation errors: ${errs.slice(0, 4).join(' | ')}`);

  state.ready_to_submit = !state.blocked_on.length && state.resume_uploaded_this_run;

  if (!allowSubmit) {
    state.awaiting_submit = state.ready_to_submit;
    state.left_for_human.push(
      pre.resumeKind === 'generic'
        ? 'submit withheld: generic resume, not the tailored one'
        : state.ready_to_submit
          ? `filled and clean — review the open tab, then: node ats_submit.mjs ${slug}`
          : 'filled but not clean — see blocked_on; the tab is left open',
    );
    return;
  }
  if (!state.ready_to_submit) return;

  await submitAndVerify(page, {
    selectors: [
      'button:has-text("Submit Application")',
      'button:has-text("Submit application")',
      'button[type="submit"]',
    ],
    successRe: 'thanks? (you )?for applying|thank you|application (has been )?(submitted|received)|we.{0,3}ve received|successfully submitted|submitted successfully|application complete',
    state,
    log,
  });
}

