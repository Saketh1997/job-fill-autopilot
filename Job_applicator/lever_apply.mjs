#!/usr/bin/env node
// lever_apply.mjs — stage 3 for jobs.lever.co. Deterministic, no model, same
// contract as amazon_apply.mjs.
//
//   node lever_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]
//                               [--endpoint http://localhost:9226] [--keep-tab]
//
// Lever specifics this encodes:
//   - the form lives at {posting URL}/apply. The posting page itself has no
//     fields, so a run that lands there fills nothing and looks "complete".
//   - controls are keyed by `name`, and the names are exactly the keys
//     lever_jd.py emits: name, email, phone, org, urls[LinkedIn], urls[GitHub],
//     resume, comments.
//   - custom application questions are `cards[{uuid}][{field}]`. Lever's public
//     JSON exposes them inconsistently, which is why lever_jd.py marks them
//     source="page". This driver reads them off the DOM, and any custom
//     question without a planned answer BLOCKS the run rather than being
//     submitted blank or guessed at.
//   - the resume input is a real <input type=file name=resume>; Lever parses it
//     and autofills name/email/org a beat later, so it is uploaded FIRST.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked.

import {
  parseArgs, die, resolveSlug, preflight, newState, connect, tabFor,
  dismissBanner, validationErrors, fillText, uploadFile, pickOption, matchOption,
  auditRequired, missingRequired, reconcileBlocked, submitAndVerify, writeStatus, appendCacheRun,
  markApplied, closeOrKeepTab, attachDocuments, norm, alreadySubmitted, startWatchdog,
} from './ats_apply_common.mjs';
import { answerRemaining, fillScraped } from './ats_questions.mjs';
import { reviewFilled } from './ats_review.mjs';

// A required file input is only "already satisfied" when it IS the resume
// field. Greenhouse's Celonis posting also requires a Cover Letter, and
// exempting every file input let the run call the form complete, click Submit,
// and get back "Cover Letter is required." with nothing to explain it.
const isResumeField = (f) => /resume|cv\b/i.test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`);

const ATS = 'lever';
const FORM = 'form[action*="/apply"], form.application-form, #application-form';

const opts = parseArgs(process.argv.slice(2),
  'usage: lever_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]');
const { slug } = opts;
let { allowSubmit } = opts;

const posting = resolveSlug(slug);
const host = new URL(posting).host.toLowerCase();
if (!/(^|\.)lever\.co$/.test(host)) die(`${host} is not lever.co — wrong driver for this posting`);

// jobs.lever.co/{site}/{uuid} -> .../apply, preserving nothing else. The
// ?source= query a scraper appended is not part of the application.
const base = posting.split('?')[0].replace(/\/apply\/?$/, '').replace(/\/$/, '');
const applyUrl = `${base}/apply`;

const pre = preflight({ slug, resumeArg: opts.resumeArg, ats: ATS });
if (!opts.force && alreadySubmitted(pre.statusPath)) {
  console.error(`LEVER: ${slug} was already submitted (answers/${slug}.drive.json) — not applying twice. --force overrides.`);
  process.exit(0);
}
if (pre.resumeKind === 'generic') allowSubmit = false;

const state = newState({ slug, url: posting, ats: ATS });
state.apply_url = applyUrl;
state.resume = pre.resume;
state.resume_kind = pre.resumeKind;
const log = (...m) => console.error('LEVER:', ...m);

if (opts.dryRun) {
  console.log(JSON.stringify({
    slug, url: posting, apply_url: applyUrl, host, ats: ATS,
    jd: pre.jdPath, schema: pre.schemaPath, plan: pre.planPath,
    resume: pre.resume, resume_kind: pre.resumeKind,
    planned_fields: Object.keys(pre.plan),
    plan_blocked: pre.planBlocked.map((b) => b.label),
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

  await page.waitForSelector('input[name="resume"], input[name="name"]', { timeout: 30000 })
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
  appendCacheRun(pre.cachePath, state, { apply_url: applyUrl });
  writeStatus(pre.statusPath, state);
  if (state.submitted) markApplied(posting);
  await closeOrKeepTab(posting, state, opts.keepTab, log);
  try { await browser?.close(); } catch { /* already detached */ }
}

console.log(JSON.stringify(state, null, 2));
process.exit(exitCode);

// =========================================================================

async function fillForm(page) {
  // 1. Resume first: Lever's parser rewrites name/email/org after it lands.
  const fileInput = page.locator('input[type="file"][name="resume"]');
  if (await uploadFile(page, fileInput, pre.resume)) {
    await page.waitForTimeout(3000);
    const attached = await page.$eval('input[type="file"][name="resume"]',
      (el) => (el.files?.[0]?.name || '')).catch(() => '');
    if (attached) {
      state.resume_uploaded_this_run = true;
      state.filled.push(`resume=${attached}`);
      state.verified.push('resume');
      log('resume attached:', attached);
    } else {
      state.blocked_on.push('resume input accepted the file but reported no attachment');
    }
  } else {
    state.blocked_on.push('no resume file input on the form');
  }

  // 2. Planned fields, keyed by the name attribute lever_jd.py already uses.
  for (const field of pre.schema) {
    const { key, kind, label, required, source } = field;
    if (key === 'resume' || source === 'page') continue;
    const value = pre.plan[key];
    if (value === undefined || value === null || value === '') continue;
    const control = page.locator(`[name="${cssAttr(key)}"]`);
    if (!(await control.count())) continue;
    if (kind === 'SELECT' || kind === 'MULTISELECT') await fillChoice(page, key, value, label);
    else await fillInput(page, key, value, label, required);
  }

  // 3. Custom questions Lever's JSON did not expose (cards[uuid][fieldN]) plus
  //    anything else still empty. Inventoried for the run log, then answered by
  //    the shared pass: profile.json, then cache/lever-answers.json, then ONE
  //    model call carrying every remaining question at once.
  await inventoryCustomQuestions(page);
  await answerRemaining({
    page,
    formSel: (await page.locator('form').count()) ? 'form' : 'body',
    ats: ATS,
    company: (new URL(posting).pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase(),
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
    // baseTemplate is Lever's own bookkeeping field, not a question.
    skip: state.verified.concat(state.custom_questions_meta || []),
  });
}

// Read the filled form back and correct what is wrong before the audit decides
// the form is complete. The audit can only see empty vs non-empty; this is the
// only step that looks at whether the answers are right.
async function review(page) {
  if (!opts.review) { log('review pass skipped (--no-review)'); return; }
  await reviewFilled({
    page,
    formSel: (await page.locator('form').count()) ? 'form' : 'body',
    ats: ATS,
    company: (new URL(posting).pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase(),
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
  });
}

function cssAttr(v) { return String(v).replace(/"/g, '\\"'); }

async function fillInput(page, name, value, label, required) {
  const ok = await fillText(page, page.locator(`[name="${cssAttr(name)}"]`), value);
  if (ok) {
    state.filled.push(`${name}=${value}`);
    state.verified.push(name);
  } else if (required) {
    state.blocked_on.push(`could not fill required field ${label || name} (${name})`);
  } else {
    state.left_for_human.push(`optional field ${label || name} did not take the planned value`);
  }
}

// Lever renders choices as native selects, radios or checkboxes depending on
// the question. Try the native paths first, fall back to the combobox opener.
async function fillChoice(page, name, value, label) {
  const sel = `[name="${cssAttr(name)}"]`;
  const tag = await page.locator(sel).first().evaluate((el) => el.tagName.toLowerCase()).catch(() => '');

  if (tag === 'select') {
    const options = await page.locator(`${sel} option`).allInnerTexts().catch(() => []);
    const hit = matchOption(value, options.map(norm).filter(Boolean));
    if (!hit) {
      state.blocked_on.push(`${label || name}: ${JSON.stringify(value)} matches none of [${options.join(' | ')}]`);
      return;
    }
    await page.selectOption(sel, { label: hit }).catch(() => {});
    const got = await page.locator(sel).inputValue().catch(() => '');
    if (!got) { state.blocked_on.push(`${label || name}: selected "${hit}" but the control is still empty`); return; }
    state.filled.push(`${name}=${hit}`);
    state.verified.push(name);
    return;
  }

  const radios = page.locator(`input[type="radio"]${sel}, input[type="checkbox"]${sel}`);
  const n = await radios.count().catch(() => 0);
  if (n) {
    const labels = [];
    for (let i = 0; i < n; i++) {
      labels.push(norm(await radios.nth(i).evaluate(
        (el) => el.labels?.[0]?.textContent || el.closest('label')?.textContent || el.value,
      ).catch(() => '')));
    }
    const hit = matchOption(value, labels.filter(Boolean));
    if (!hit) {
      state.blocked_on.push(`${label || name}: ${JSON.stringify(value)} matches none of [${labels.join(' | ')}]`);
      return;
    }
    const idx = labels.indexOf(hit);
    await radios.nth(idx).check({ timeout: 8000 }).catch(() => radios.nth(idx).click({ force: true }));
    if (!(await radios.nth(idx).isChecked().catch(() => false))) {
      state.blocked_on.push(`${label || name}: clicked "${hit}" but it did not stay checked`);
      return;
    }
    state.filled.push(`${name}=${hit}`);
    state.verified.push(name);
    return;
  }

  const res = await pickOption(page, page.locator(sel), value);
  if (!res || !res.ok) {
    state.blocked_on.push(
      `${label || name}: ${JSON.stringify(value)} matches none of the form's options`
      + (res ? ` [${res.options.join(' | ')}]` : ''),
    );
    return;
  }
  state.filled.push(`${name}=${res.chosen}`);
  state.verified.push(name);
}

// What this posting asks beyond Lever's standard fields, for the run log. The
// answering itself is answerRemaining's job — this only records the inventory,
// and singles out baseTemplate, which is Lever's own bookkeeping input rather
// than a question anyone should be answering.
async function inventoryCustomQuestions(page) {
  const found = await page.$$eval('[name^="cards["]', (els) => {
    const seen = {};
    for (const el of els) {
      const card = el.closest('.application-question');
      const label = card?.querySelector('.application-label .text, .application-label');
      seen[el.name] = seen[el.name] || {
        name: el.name,
        type: el.type || el.tagName.toLowerCase(),
        required: !!el.required || el.getAttribute('aria-required') === 'true',
        label: (label?.textContent || '').replace(/\s+/g, ' ').replace(/✱/g, '').trim().slice(0, 140),
      };
    }
    return Object.values(seen);
  }).catch(() => []);

  state.custom_questions = found
    .filter((q) => !/\[baseTemplate\]$/.test(q.name))
    .map((q) => `${q.name}${q.required ? '*' : ''}: ${q.label}`);
  state.custom_questions_meta = found
    .filter((q) => /\[baseTemplate\]$/.test(q.name)).map((q) => q.name);
}

async function finish(page) {
  const formSel = (await page.locator(FORM).count()) ? FORM : 'form';
  const fields = await auditRequired(page, formSel);
  reconcileBlocked(state, fields);
  const missing = missingRequired(fields)
    .filter((f) => f.type !== 'file' || !isResumeField(f) || !state.resume_uploaded_this_run);
  for (const f of missing) {
    state.blocked_on.push(
      `required field ${f.label || f.name} (${f.name}) is still empty`
      + (pre.plan[f.name] ? ' — the planned value did not stick' : ' — no planned value'),
    );
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
      'button:has-text("Submit application")',
      'button[type="submit"]',
      'input[type="submit"]',
    ],
    // Lever confirms by navigating to {posting}/thanks and rendering
    // "Application submitted!". The URL is the reliable half: matching only on
    // prose called a genuinely submitted application a failure and skipped
    // mark_applied, which is the worst way to be wrong here — it invites a
    // duplicate application.
    successRe: '/thanks|application submitted|thank you|application (has been )?(submitted|received)|we.{0,3}ve received',
    state,
    log,
  });
}

