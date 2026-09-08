#!/usr/bin/env node
// greenhouse_apply.mjs — stage 3 for job-boards.greenhouse.io. Deterministic,
// no model, same contract as amazon_apply.mjs.
//
//   node greenhouse_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]
//                                    [--endpoint http://localhost:9226] [--keep-tab]
//
// Why this exists rather than greenhouse_fill_mcp.py: that path drove the form
// through @playwright/mcp's accessibility snapshot, matching fields by their
// visible label. It reported "filled" on a form where nothing had been typed
// (2026-08-10 Verkada run) because a failed MCP tool call comes back as a
// result, not an exception, and nothing read the values back. This script talks
// to the DOM directly, keys fields by the id Greenhouse already gave them, and
// treats a value as filled ONLY after reading it back off the page.
//
// Greenhouse specifics this encodes so no run has to rediscover them:
//   - the form is inline on the job page (#application-form); there is no
//     separate apply URL, and the Apply button only scrolls to it.
//   - controls are keyed by `id`, NOT by `name` — every input's name is "".
//     schema/{slug}.json keys are those same ids, so the mapping is 1:1.
//   - the resume input is <input type=file id=resume class=visually-hidden>.
//     setInputFiles works on it directly; no file chooser, no Attach click.
//   - upload the resume FIRST. Greenhouse parses it and autofills name/email a
//     beat later, which would clobber anything written before the parse lands.
//   - selects are react-select: click .select__control, then pick from
//     [id^="react-select-{id}-option"]. After a pick the search input is empty
//     again and the answer lives in .select__single-value.
//   - the four EEOC self-ID selects are REQUIRED and are not in the API's
//     `questions` array — they come from `compliance[].questions`, which is why
//     greenhouse_jd.py reads both.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked.

import {
  parseArgs, die, resolveSlug, preflight, newState, connect, tabFor,
  dismissBanner, validationErrors, fillText, uploadFile, pickOption, clickFirst,
  auditRequired, missingRequired, reconcileBlocked, submitAndVerify, writeStatus, appendCacheRun,
  markApplied, closeOrKeepTab, attachDocuments, norm, lc,
  resolveGreenhouseEmbed, alreadySubmitted, startWatchdog,
} from './ats_apply_common.mjs';
import { answerRemaining, fillScraped } from './ats_questions.mjs';
import { reviewFilled } from './ats_review.mjs';

// A required file input is only "already satisfied" when it IS the resume
// field. Greenhouse's Celonis posting also requires a Cover Letter, and
// exempting every file input let the run call the form complete, click Submit,
// and get back "Cover Letter is required." with nothing to explain it.
const isResumeField = (f) => /resume|cv\b/i.test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`);

const ATS = 'greenhouse';
const FORM = '#application-form';

const opts = parseArgs(process.argv.slice(2),
  'usage: greenhouse_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]');
const { slug } = opts;
let { allowSubmit } = opts;

const rawUrl = resolveSlug(slug);
const host = new URL(rawUrl).host.toLowerCase();
if (!/greenhouse\.io$/.test(host)) {
  die(`${host} is not greenhouse.io — wrong driver for this posting`);
}
// The embed form (boards.greenhouse.io/embed/job_app?token=…) carries no board
// slug, so neither the schema fetcher nor this driver can address it directly.
// It is recoverable rather than fatal: the embed page names its own board and
// the token is the job id. Only a URL that fails to resolve stops the run.
const url = await resolveGreenhouseEmbed(rawUrl);
if (/\/embed\/job_app/.test(url)) {
  die('embed job_app URL and its board could not be resolved — re-scan this posting for its job-boards.greenhouse.io URL');
}

const pre = preflight({ slug, resumeArg: opts.resumeArg, ats: ATS });
if (!opts.force && alreadySubmitted(pre.statusPath)) {
  console.error(`GREENHOUSE: ${slug} was already submitted (answers/${slug}.drive.json) — not applying twice. --force overrides.`);
  process.exit(0);
}
if (pre.resumeKind === 'generic') allowSubmit = false;

const state = newState({ slug, url, ats: ATS });
// data/pipeline.csv still holds the embed URL this run resolved away from, and
// mark_applied.py matches on that exact string. Without it a submitted
// application never gets flagged applied, and the next scan offers it again.
state.source_url = rawUrl;
state.resume = pre.resume;
state.resume_kind = pre.resumeKind;
const log = (...m) => console.error('GREENHOUSE:', ...m);

if (opts.dryRun) {
  console.log(JSON.stringify({
    slug, url, raw_url: rawUrl, host, ats: ATS, form: FORM,
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

  const page = await tabFor(ctx, url);
  page.setDefaultTimeout(20000);
  if (!page.url().startsWith(url.split('?')[0])) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await dismissBanner(page);

  await page.waitForSelector(FORM, { timeout: 30000 }).catch(() => {
    state.blocked_on.push(`no ${FORM} at ${page.url()} — the posting may be closed or the board redesigned`);
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
  appendCacheRun(pre.cachePath, state, { form: FORM });
  writeStatus(pre.statusPath, state);
  if (state.submitted) markApplied(url);
  await closeOrKeepTab(url, state, opts.keepTab, log);
  try { await browser?.close(); } catch { /* already detached */ }
}

console.log(JSON.stringify(state, null, 2));
process.exit(exitCode);

// =========================================================================

async function fillForm(page) {
  // 1. Resume first — Greenhouse's parser autofills name/email a beat after the
  //    upload lands, and anything written before that gets overwritten.
  // Greenhouse REPLACES the file input with an attached-file row once an upload
  // lands, so `#resume` is gone afterwards and el.files is not the evidence —
  // the filename rendered on the page is. That also means a re-run of this same
  // slug arrives at a form that already carries the right PDF: the submit
  // precondition is "the tailored file is attached", and the page saying so is
  // exactly that proof.
  const wanted = pre.resume.split('/').pop();
  const onPage = () => page.locator(FORM).innerText()
    .then((t) => (t.includes(wanted) ? wanted : '')).catch(() => '');

  const fileInput = page.locator(`${FORM} input[type="file"]#resume`);
  const already = await onPage();
  if (already) {
    state.resume_uploaded_this_run = true;
    state.filled.push(`resume=${already} (already attached)`);
    state.verified.push('resume');
    log('resume already attached from an earlier pass:', already);
  } else if (await uploadFile(page, fileInput, pre.resume)) {
    await page.waitForTimeout(2500);
    let attached = await onPage();

    // Setting files on the hidden input skips the click that Greenhouse's own
    // uploader hangs its handler on, and on some boards that handler then dies
    // with "Cannot read properties of undefined (reading 'uploadFile')" — the
    // file sits on the input, the page shows an error, and nothing is ever
    // uploaded. Redo it the way a person would: click Attach, answer the file
    // chooser. Verified by the filename appearing, same as before.
    if (!attached) {
      log('inline upload did not register; retrying through the Attach file chooser');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForSelector(FORM, { timeout: 20000 }).catch(() => {});
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          clickFirst(page, [
            `${FORM} [aria-labelledby*="resume"] button:has-text("Attach")`,
            `${FORM} button:has-text("Attach")`,
          ], { timeout: 8000 }),
        ]);
        await chooser.setFiles(pre.resume);
        await page.waitForTimeout(3000);
        attached = await onPage();
      } catch (e) {
        log('file chooser path failed:', String(e.message || e).split('\n')[0]);
      }
    }

    if (attached) {
      state.resume_uploaded_this_run = true;
      state.filled.push(`resume=${attached}`);
      state.verified.push('resume');
      log('resume attached:', attached);
    } else {
      state.blocked_on.push(
        'the resume never attached — the board accepted the file but never showed it '
        + '(Greenhouse upload handler error); attach it by hand before submitting',
      );
    }
  } else {
    state.blocked_on.push('no #resume file input on the form');
  }

  // 2. Phone country. Greenhouse renders it as a required react-select that
  //    starts empty on some boards; profile.json's address.country is the
  //    source, never a default typed in here.
  //    It is filled BEFORE the phone number on purpose: picking a country makes
  //    intl-tel-input re-render the phone input, which discards a number
  //    written first (the "control vanished before it could be filled: Phone"
  //    from the 2026-08-10 run).
  const country = pre.profile.address?.country || pre.profile.country;
  if (country && await hasControl(page, 'country')) {
    await fillSelect(page, 'country', country, 'Country');
  }

  // 3. Everything the plan has a value for, keyed by schema id.
  for (const field of pre.schema) {
    const { key, kind, label, required } = field;
    if (key === 'resume' || key === 'resume_text') continue;
    const value = pre.plan[key];
    if (value === undefined || value === null || value === '') continue;
    if (!(await hasControl(page, key))) {
      // The API listed it, the rendered form does not have it. Race is the
      // usual case: it only appears once Hispanic/Latino is answered.
      state.deferred = state.deferred || [];
      state.deferred.push(key);
      continue;
    }
    if (kind === 'SELECT' || kind === 'MULTISELECT') await fillSelect(page, key, value, label);
    else await fillInput(page, key, value, label, required);
  }

  // 4. Fields that only render after an earlier answer (Race after
  //    Hispanic/Latino). One more pass, no recursion.
  for (const key of state.deferred || []) {
    const value = pre.plan[key];
    if (!value || !(await hasControl(page, key))) continue;
    const field = pre.schema.find((f) => f.key === key) || {};
    if (field.kind === 'SELECT' || field.kind === 'MULTISELECT') {
      await fillSelect(page, key, value, field.label || key);
    } else {
      await fillInput(page, key, value, field.label || key, field.required);
    }
    state.deferred = state.deferred.filter((k) => k !== key);
  }

  // 5. Settle pass. Greenhouse re-renders parts of the form as it goes — the
  //    resume parser rewrites name/email, and intl-tel-input rebuilds the phone
  //    input when the country changes — so a field verified earlier can be
  //    empty by now. Re-fill once, then trust the audit.
  //    It also covers the first-attempt failures: the phone input is rebuilt by
  //    intl-tel-input the instant the country changes, so the first fill of it
  //    lands in a node that no longer exists.
  for (const field of pre.schema) {
    const { key, kind, label, required } = field;
    if (kind === 'FILE' || kind === 'TEXTAREA') continue;
    if (kind === 'SELECT' || kind === 'MULTISELECT') continue;
    const value = pre.plan[key];
    if (value === undefined || value === null || value === '') continue;
    const el = page.locator(`${FORM} #${cssId(key)}`);
    if (!(await el.count())) continue;
    if (norm(await el.first().inputValue().catch(() => ''))) continue;
    log(`re-filling ${key}: the form is not holding it`);
    state.blocked_on = state.blocked_on.filter((b) => !b.includes(`(${key})`));
    await fillInput(page, key, value, label, required);
  }

  // 6. Anything still unanswered: scraped off the DOM, served from
  //    cache/greenhouse-answers.json where possible, and otherwise sent to ONE
  //    model call with every remaining question in a single message.
  await answerRemaining({
    page,
    formSel: FORM,
    ats: ATS,
    company: companySlug(),
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
    skip: state.verified.slice(),
  });
}

// Read the filled form back and correct what is wrong before the audit decides
// the form is complete. The audit can only see empty vs non-empty; this is the
// only step that looks at whether the answers are right.
async function review(page) {
  if (!opts.review) { log('review pass skipped (--no-review)'); return; }
  await reviewFilled({
    page,
    formSel: FORM,
    ats: ATS,
    company: companySlug(),
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
  });
}

// Cache scope for company-specific answers: the board token in the URL, which
// is the company, not the ATS.
function companySlug() {
  return (new URL(url).pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase();
}

async function hasControl(page, id) {
  return (await page.locator(`${FORM} #${cssId(id)}`).count()) > 0;
}

// Greenhouse ids are safe already, but a question id is server-generated and
// this is the one place a bad one would become a selector.
function cssId(id) {
  // A CSS identifier may not BEGIN with a digit, and Greenhouse demographic
  // question ids are pure numbers (e.g. 4005246007). Escaping only the
  // non-word characters leaves '#4005246007', which throws
  // "SyntaxError: '#4005246007' is not a valid selector" out of
  // locator.count() and aborts the whole fill — 29 required fields were left
  // empty on Energy Solutions this way on 2026-08-29. A leading digit has to
  // become its hex escape: 4 -> '\\34 ', which is the same form readback.mjs
  // already emits (#\\34 012867007).
  const esc = String(id).replace(/([^\w-])/g, '\\$1');
  return /^[0-9]/.test(esc) ? `\\3${esc[0]} ${esc.slice(1)}` : esc;
}

async function fillInput(page, id, value, label, required) {
  const ok = await fillText(page, page.locator(`${FORM} #${cssId(id)}`), value);
  if (ok) {
    state.filled.push(`${id}=${redact(label, value)}`);
    state.verified.push(id);
  } else if (required) {
    state.blocked_on.push(`could not fill required field ${label || id} (${id})`);
  } else {
    state.left_for_human.push(`optional field ${label || id} did not take the planned value`);
  }
}

// react-select: open the control, pick from the options THE PAGE offers, then
// read the choice back out of .select__single-value. A value that matches no
// option blocks with the option list attached, so the fix is one edit away.
async function fillSelect(page, id, value, label) {
  const container = `${FORM} .select__container:has(label[for="${id}"])`;
  // Click the react-select input itself rather than hunting for .select__control:
  // the control div is re-created on every open/close, and a stale handle to it
  // is what made the country select time out on the first Verkada run.
  const control = page.locator(`${FORM} #${cssId(id)}`);
  if (!(await control.count())) {
    state.blocked_on.push(`no select control for ${label || id} (${id})`);
    return;
  }
  // A control that already shows an answer is left alone. Re-opening a filled
  // react-select just to click the same option is pure risk: every open is
  // another overlay that can swallow the next field's click.
  const existing = norm(await page.locator(`${container} .select__single-value`).first()
    .innerText().catch(() => ''));
  if (existing) {
    state.filled.push(`${id}=${redact(label, existing)} (already set)`);
    state.verified.push(id);
    return;
  }

  // react-select renders its menu in a portal, which on this board is OUTSIDE
  // the field's own container — a container-scoped option selector found zero
  // options and blocked a field that was perfectly fillable. Match globally;
  // only one menu is ever open at a time.
  const res = await pickOption(page, control, value, {
    optionSel: `[id^="react-select-${id}-option"], [role="option"], .select__option`,
  });
  if (!res) {
    state.blocked_on.push(`no select control for ${label || id} (${id})`);
    return;
  }
  if (!res.ok) {
    state.blocked_on.push(
      `${label || id} (${id}): planned answer ${JSON.stringify(value)} matches none of the form's options `
      + `[${res.options.join(' | ')}] — set a value in profile.json that maps onto one of them`,
    );
    return;
  }
  // Checkbox/radio groups and native <select>s have no .select__single-value to
  // read — pickOption already verified them at the source (checked state, or
  // selectOption succeeding). Demanding the react-select readback here blocked
  // fields that were correctly filled.
  if (res.kind === 'choice-group' || res.kind === 'native-select') {
    state.filled.push(`${id}=${redact(label, res.chosen)}`);
    state.verified.push(id);
    return;
  }

  // The readback proves a choice landed, not that it renders identically: the
  // phone-country control picks "United States +1" and then displays "+1" next
  // to a flag image. Non-empty, and consistent with the option that was
  // clicked, is the honest bar.
  const shown = norm(await page.locator(`${container} .select__single-value`).first()
    .innerText().catch(() => ''));
  const consistent = shown && (lc(res.chosen).includes(lc(shown)) || lc(shown).includes(lc(res.chosen)));
  if (!consistent) {
    state.blocked_on.push(`${label || id}: clicked "${res.chosen}" but the control reads "${shown || '(empty)'}"`);
    return;
  }
  state.filled.push(`${id}=${redact(label, shown)}`);
  state.verified.push(id);
}

// EEO answers are filled and cached like any other field, but the Privacy rule
// keeps their values out of anything that gets pasted elsewhere. answers/*.json
// is gitignored; this run log is not necessarily.
function redact(label, value) {
  return /gender|race|ethnic|veteran|disab|hispanic|latino/i.test(label || '') ? '•••' : String(value);
}

async function finish(page) {
  // The audit is the authority on completeness, not the schema — the API omits
  // required fields (it omitted four EEOC selects on this very posting), so
  // "every planned field went in" is not the same as "the form is complete".
  const fields = await auditRequired(page, FORM);
  reconcileBlocked(state, fields);
  const missing = missingRequired(fields).filter((f) => f.type !== 'file' || !isResumeField(f) || !state.resume_uploaded_this_run);
  for (const f of missing) {
    const planned = pre.plan[f.name];
    state.blocked_on.push(
      `required field ${f.label || f.name} (${f.name}) is still empty`
      + (planned ? ' — the planned value did not stick' : ' — no planned value; add a rule to make_plan.py or an answer to profile.json'),
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
      `${FORM} button[type="submit"]`,
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
    ],
    successRe: 'thank you|application (has been )?(submitted|received)|confirmation|we.{0,3}ve received',
    state,
    log,
  });
}
