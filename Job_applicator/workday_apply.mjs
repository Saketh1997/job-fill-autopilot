#!/usr/bin/env node
// workday_apply.mjs — stage 3 for *.myworkdayjobs.com. Deterministic fill from
// cache/workday.json, one batched model call for the tenant-specific questions
// that profile.json and the answer cache do not already cover. Same contract as
// ashby_apply.mjs and amazon_apply.mjs.
//
//   node workday_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]
//                                 [--endpoint http://localhost:9226] [--keep-tab]
//
// Workday specifics this encodes (all of it from cache/workday.json, which was
// captured live off hp.wd5 and confirmed on ciena.wd5 — read that file before
// changing anything here):
//   - the apply URL is always {job_url}/apply. Do not click the Apply anchor.
//   - the wizard is behind a per-TENANT account wall. hp.wd5 and nvidia.wd5 are
//     separate accounts, so credentials key by tenant in login.env, never by ATS.
//   - a "click_filter" overlay makes every ordinary click() time out while the
//     button reports visible+enabled, so every click here is force:true.
//   - [data-automation-id="beecatcher"] is a HONEYPOT. Never fill it. profile.json
//     has a `website` key and a name-based matcher will happily bind it here.
//   - listboxes must be opened and selected inside ONE script run; the menu
//     closes between CDP round-trips and a later query finds zero options.
//   - step COUNT varies by tenant (HP 6, Ciena 8), so the live Application
//     Progress list is the only trustworthy map.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  BASE, norm, lc, parseArgs, die, resolveSlug, preflight, newState, connect, tabFor,
  validationErrors, clickFirst, uploadFile, fillText, pickOption,
  auditRequired, missingRequired, reconcileBlocked, submitAndVerify, writeStatus,
  appendCacheRun, markApplied, closeOrKeepTab, alreadySubmitted, startWatchdog,
  captchaPresent,
} from './ats_apply_common.mjs';
import { answerRemaining, fillScraped } from './ats_questions.mjs';

const ATS = 'workday';
// The wizard renders inside a <form>, but tenants differ on whether it is the
// only one. Scope to the wizard panel first and fall back the same way ashby does.
const FORM = '[data-automation-id="applyFlowPage"], form, main';

const opts = parseArgs(process.argv.slice(2),
  'usage: workday_apply.mjs <slug> [--resume PATH] [--no-submit] [--dry-run]');
const { slug } = opts;
let { allowSubmit } = opts;

const posting = resolveSlug(slug);
const host = new URL(posting).host.toLowerCase();
if (!/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$/.test(host)) {
  die(`${host} is not a Workday tenant — wrong driver for this posting`);
}

// Per-tenant, not per-ATS: "gm" from gm.wd5.myworkdayjobs.com.
const tenant = host.split('.')[0];
const jobUrl = posting.split('?')[0].replace(/\/apply(\/[a-zA-Z]*)?\/?$/, '').replace(/\/$/, '');
const applyUrl = `${jobUrl}/apply`;

const pre = preflight({ slug, resumeArg: opts.resumeArg, ats: ATS });
if (!opts.force && alreadySubmitted(pre.statusPath)) {
  console.error(`WORKDAY: ${slug} was already submitted (answers/${slug}.drive.json) — not applying twice. --force overrides.`);
  process.exit(0);
}
if (pre.resumeKind === 'generic') allowSubmit = false;

const wd = readCache();
const state = newState({ slug, url: posting, ats: ATS });
state.apply_url = applyUrl;
state.tenant = tenant;
state.resume = pre.resume;
state.resume_kind = pre.resumeKind;
state.steps_completed = [];
state.account_created_this_run = false;
const log = (...m) => console.error('WORKDAY:', ...m);

if (opts.dryRun) {
  console.log(JSON.stringify({
    slug, url: posting, job_url: jobUrl, apply_url: applyUrl, host, tenant, ats: ATS,
    jd: pre.jdPath, schema: pre.schemaPath, plan: pre.planPath,
    resume: pre.resume, resume_kind: pre.resumeKind,
    account_on_file: !!credentialsFor(tenant),
    cached_steps: Object.keys(wd.steps || {}),
    note: 'Workday exposes no form schema; the wizard is account-walled and read live',
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

  const page = await tabFor(ctx, applyUrl);
  page.setDefaultTimeout(25000);
  if (!page.url().startsWith(applyUrl)) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await dismissOverlays(page);

  await chooseEntry(page);
  if (state.blocked_on.length) throw new Blocked();

  await ensureSignedIn(page);
  if (state.blocked_on.length) throw new Blocked();

  await walkWizard(page);
  if (state.blocked_on.length) throw new Blocked();

  await finish(page);
} catch (err) {
  if (!(err instanceof Blocked)) {
    state.blocked_on.push(`unexpected failure: ${String((err && err.message) || err).slice(0, 300)}`);
  }
} finally {
  exitCode = state.blocked_on.length ? 2 : 0;
  writeStatus(pre.statusPath, state);
  appendCacheRun(pre.cachePath, state, { apply_url: applyUrl, tenant });
  writeStatus(pre.statusPath, state);
  if (state.submitted) markApplied(posting);
  await closeOrKeepTab(posting, state, opts.keepTab, log);
  try { await browser?.close(); } catch { /* already detached */ }
}

console.log(JSON.stringify(state, null, 2));
process.exit(exitCode);

// =========================================================================

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BASE, 'cache', 'workday.json'), 'utf8'));
  } catch (e) {
    die(`cache/workday.json is required and would not parse: ${e.message}`);
    return {};
  }
}

// Credentials are read but never logged, never written to answers/, cache/ or
// state — same no-echo rule as every other secret in this pipeline.
function credentialsFor(site) {
  try {
    const env = JSON.parse(fs.readFileSync(path.join(BASE, 'login.env'), 'utf8'));
    return (env.login || {})[site] || null;
  } catch { return null; }
}

// -------------------------------------------------------------- page basics

// Workday's click_filter overlay sits over the whole page: every button reports
// visible and enabled, and a plain click() times out after 15s with nothing on
// the page to explain it. force skips the actionability check that the overlay
// defeats. Pressing Enter in a text field does NOT submit, so this is the only
// way to advance.
async function wdClick(locator, { timeout = 15000 } = {}) {
  const el = locator.first();
  if (!(await el.count())) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  return el.click({ force: true, timeout })
    .then(() => true)
    .catch(() => false);
}

async function dismissOverlays(page) {
  // Ciena showed a SECOND cookie banner after the resume upload, not just on
  // first load, so this is called again after uploads rather than once.
  const hit = await clickFirst(page, [
    'button:has-text("Accept Cookies")', 'button:has-text("Accept All")',
    'button:has-text("Accept")', 'button:has-text("Decline")',
    '[data-automation-id="legalNoticeAcceptButton"]',
  ], { timeout: 4000 });
  if (hit) await page.waitForTimeout(600);
  return hit;
}

// The honeypot is labelled "This input is for robots only, do not enter if
// you're human." Filling it flags the session. Nothing in this driver writes to
// a field without passing through here first.
const HONEYPOT = '[data-automation-id="beecatcher"], input[name=website]';
async function isHoneypot(page, locator) {
  return locator.first().evaluate((el, sel) => el.matches(sel) || !!el.closest(sel), HONEYPOT)
    .catch(() => false);
}

async function fillAuto(page, autoId, value, { label = autoId } = {}) {
  if (value === null || value === undefined || value === '') return false;
  const el = page.locator(`[data-automation-id=${autoId}] input, input[data-automation-id=${autoId}]`).first();
  if (!(await el.count())) return false;
  if (await isHoneypot(page, el)) {
    state.notes.push(`refused to fill ${autoId}: it is the Workday honeypot`);
    return false;
  }
  const ok = await fillText(page, el, value);
  if (ok) { state.filled.push(`${label}=${value}`); state.verified.push(label); }
  else state.blocked_on.push(`could not set ${label} (${autoId})`);
  return ok;
}

// Open and select in the SAME call. The menu closes between CDP round-trips, so
// a two-step open-then-query always finds zero options.
async function pickAuto(page, autoId, wanted, { label = autoId, exact = null } = {}) {
  const control = page.locator(`[data-automation-id=${autoId}]`).first();
  if (!(await control.count())) return false;

  if (exact) {
    // Used where a loose regex is actively dangerous — veteranStatus, where
    // /not a (protected )?veteran/ matches "I IDENTIFY AS A VETERAN, JUST NOT A
    // PROTECTED VETERAN" first and falsely claims veteran status.
    const btn = control.locator('button[aria-haspopup=listbox]').first();
    if (await btn.count()) await wdClick(btn);
    const opt = page.getByRole('option', { name: exact, exact: true }).first();
    if (await opt.count()) {
      const ok = await wdClick(opt);
      if (ok) { state.filled.push(`${label}=${exact}`); state.verified.push(label); return true; }
    }
    await page.keyboard.press('Escape').catch(() => {});
    state.blocked_on.push(`no exact option "${exact}" for ${label} (${autoId})`);
    return false;
  }

  const res = await pickOption(page, control, wanted, { optionSel: '[role=option]' });
  if (res && res.ok) {
    state.filled.push(`${label}=${res.chosen}`);
    state.verified.push(label);
    return true;
  }
  state.blocked_on.push(
    `could not choose "${wanted}" for ${label} (${autoId})`
    + (res && res.options && res.options.length ? `; live options: ${res.options.slice(0, 8).join(' | ')}` : ''),
  );
  return false;
}

// Workday's multiselect shows NOTHING on typing alone: click, type, press Enter
// (or the promptSearchButton), and only then do [role=option] rows appear. An
// unfiltered open shows category rows ("All", "Partial List (First 500
// Entries)"), never leaves — so always search rather than drill down.
async function pickMultiselect(page, autoId, wanted, { label = autoId } = {}) {
  const box = page.locator(`[data-automation-id=${autoId}] input[data-automation-id="searchBox"]`).first();
  if (!(await box.count())) return false;
  await box.scrollIntoViewIfNeeded().catch(() => {});
  await wdClick(box);
  await box.fill(String(wanted)).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);

  const options = page.locator('[role=option]');
  const n = await options.count().catch(() => 0);
  if (!n) {
    state.blocked_on.push(`multiselect ${label} (${autoId}) returned no options for "${wanted}"`);
    return false;
  }
  // Prefer an exact match, then the first option that contains the wanted text.
  // Field of Study on HP has no plain "Computer Science" — all 11 matches are
  // compound — so a contains-match is the rule, not a fallback.
  let chosen = null;
  for (let i = 0; i < n; i++) {
    const t = norm(await options.nth(i).textContent().catch(() => ''));
    if (!t) continue;
    if (lc(t) === lc(wanted)) { chosen = i; break; }
    if (chosen === null && lc(t).includes(lc(wanted))) chosen = i;
  }
  if (chosen === null) chosen = 0;
  const text = norm(await options.nth(chosen).textContent().catch(() => ''));
  const ok = await wdClick(options.nth(chosen));
  if (ok) {
    state.filled.push(`${label}=${text}`);
    state.verified.push(label);
    return true;
  }
  state.blocked_on.push(`could not select "${text}" in ${label} (${autoId})`);
  return false;
}

// ------------------------------------------------------------- account wall

async function ensureSignedIn(page) {
  // Already inside the wizard: nothing to do. A saved draft also lands here,
  // because Workday restores it on /apply.
  const password = page.locator('input[data-automation-id="password"], input[type=password]').first();
  if (await inWizard(page) && !(await password.count())) return;

  const creds = credentialsFor(tenant);
  const signInLink = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();

  if (!creds) {
    // Runbook step 4: sign up with login.default when the tenant has no account.
    await createAccount(page);
    return;
  }

  if (await signInLink.count()) await wdClick(signInLink);
  await page.waitForTimeout(1200);

  const email = page.locator('input[data-automation-id="email"], input[type=email]').first();
  if (!(await email.count()) || !(await password.count())) {
    if (await inWizard(page)) return;
    state.blocked_on.push(`no sign-in form at ${page.url().slice(0, 120)}`);
    return;
  }

  // Try a password ONCE. Workday locks the account after repeated failures, so
  // there is deliberately no retry loop here.
  await email.fill(creds.email).catch(() => {});
  await password.fill(creds.password).catch(() => {});
  await wdClick(page.locator('[data-automation-id="signInSubmitButton"], button[type=submit]').first());
  await page.waitForTimeout(3500);
  await dismissOverlays(page);

  const failure = wd?.mechanics?.signin_failure_text
    || 'You may have entered the wrong email address or password';
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
  if (body.includes(failure) || /account might be locked/i.test(body)) {
    state.blocked_on.push(
      `sign-in was rejected for the "${tenant}" tenant. Not retrying — Workday locks accounts after a few`
      + ' failures. Check the credentials in login.env by hand.',
    );
    return;
  }

  const cap = await captchaPresent(page);
  if (cap) {
    state.blocked_on.push(
      `CAPTCHA on the ${tenant} sign-in page (${cap.visible} visible widget(s)`
      + `${cap.coveringSubmit ? ', covering the submit button' : ''}) — solve it in the job browser`
      + ' over VNC :5900, then re-run this posting.');
    return;
  }

  if (!(await inWizard(page))) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await dismissOverlays(page);
  }
  if (!(await inWizard(page)) && !(await entryChoices(page)).length) {
    state.blocked_on.push(`signed in but did not reach the wizard; stuck at ${page.url().slice(0, 120)}`);
  }
}

// Workday's own account form. Selectors are the tenant-independent
// data-automation-ids with text fallbacks, because signup was not in
// cache/workday.json (which captured the signed-in wizard only).
async function createAccount(page) {
  const defaults = credentialsFor('default');
  if (!defaults || !defaults.email || !defaults.password) {
    state.blocked_on.push('login.env has no usable "default" entry to sign up with');
    return false;
  }
  // profile.json's job_account_email is the address the candidate uses for
  // job portals; login.default is the fallback.
  const email = defaults.email;
  const password = defaults.password;

  let emailEl = page.locator('[data-automation-id="email"] input, input[data-automation-id="email"], input[type="email"]').first();
  let pwEl = page.locator('[data-automation-id="password"] input, input[data-automation-id="password"]').first();
  if (!(await emailEl.count()) || !(await pwEl.count())) {
    await clickFirst(page, [
      '[data-automation-id="createAccountLink"]',
      'button:has-text("Create Account")', 'a:has-text("Create Account")',
      'button:has-text("Sign Up")',
    ], { timeout: 8000 });
    await page.waitForTimeout(1500);
    await dismissOverlays(page);
    emailEl = page.locator('[data-automation-id="email"] input, input[data-automation-id="email"], input[type="email"]').first();
    pwEl = page.locator('[data-automation-id="password"] input, input[data-automation-id="password"]').first();
  }

  const verifyEl = page.locator('[data-automation-id="verifyPassword"] input, input[data-automation-id="verifyPassword"]').first();
  if (!(await emailEl.count()) || !(await pwEl.count())) {
    state.blocked_on.push(`no account-creation form at ${page.url().slice(0, 120)}`);
    return false;
  }

  // Every one of these used to be `.fill(...).catch(() => {})`. A fill that
  // never landed was indistinguishable from one that did, so the run walked on
  // and the audit reported the field as "left blank" with no idea why. Fill,
  // read back, escalate (plain -> force -> real typing), and say so if it never
  // takes: the click_filter overlay makes the plain path fail intermittently.
  const fillVerified = async (el, value, label) => {
    if (!(await el.count())) return false;
    for (const attempt of [0, 1, 2]) {
      if (attempt === 0) await el.fill(value).catch(() => {});
      else if (attempt === 1) await el.fill(value, { force: true }).catch(() => {});
      else {
        await el.click({ force: true }).catch(() => {});
        await el.pressSequentially(value, { delay: 30 }).catch(() => {});
      }
      if ((await el.inputValue().catch(() => '')) === value) return true;
    }
    state.blocked_on.push(`could not enter a value into "${label}" on the ${tenant} account form`);
    return false;
  };

  await fillVerified(emailEl, email, 'Email Address');
  await fillVerified(pwEl, password, 'New Password');
  if (await verifyEl.count()) await fillVerified(verifyEl, password, 'Verify New Password');

  // The beecatcher honeypot is never FILLED by this driver, but Chrome's
  // autofill does not know it is a trap: it put 23 characters into GM's on
  // 2026-08-22. Submitting with it populated marks the application as a bot,
  // so clear it immediately before the submit click rather than just avoiding it.
  const bee = page.locator('input[data-automation-id="beecatcher"]').first();
  if (await bee.count() && (await bee.inputValue().catch(() => ''))) {
    await bee.fill('', { force: true }).catch(() => {});
  }

  // Account terms-and-conditions box: the same standard consent the candidate
  // authorized on 2026-08-08. Not an AI-policy or "I certify" attestation.
  const terms = page.locator('[data-automation-id="createAccountCheckbox"] input[type="checkbox"], [data-automation-id="createAccountCheckbox"]').first();
  if (await terms.count() && !(await terms.isChecked().catch(() => true))) {
    await wdClick(terms);
  }

  await wdClick(page.locator('[data-automation-id="createAccountSubmitButton"], button[type="submit"]').first());
  await page.waitForTimeout(4000);
  await dismissOverlays(page);

  const cap = await captchaPresent(page);
  if (cap) {
    state.blocked_on.push(
      `CAPTCHA on the ${tenant} account-creation page (${cap.visible} visible widget(s)`
      + `${cap.coveringSubmit ? ', covering the submit button' : ''}) — solve it in the job browser`
      + ' over VNC :5900, then re-run this posting.');
    return false;
  }

  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
  if (/already (exists|in use)|account with this email/i.test(body)) {
    state.blocked_on.push(
      `${tenant} says an account already exists for this email but login.env has no entry for it.`
      + ' Add the credentials under "' + tenant + '" by hand rather than letting the run guess a password'
      + ' — Workday locks accounts after a few failed attempts.');
    return false;
  }

  // Record the account BEFORE the verification round-trip. If verification
  // fails the account still exists, and a lost password would mean a locked-out
  // tenant with no way back in.
  persistCredentials(tenant, email, password);
  state.account_created_this_run = true;
  state.notes.push(`created a new ${tenant} Workday account (recorded in login.env)`);

  if (!(await confirmEmail(page))) return false;

  if (!(await inWizard(page)) && !(await entryChoices(page)).length) {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await dismissOverlays(page);
  }
  return true;
}

// Workday tenants confirm either with a short code or with an activation LINK
// (cache/workday.json -> mechanics.email_verification). Try the code first,
// because it is the common shape, then the link.
async function confirmEmail(page) {
  const prompt = await page.evaluate(() => {
    const rx = /verify\s+(your\s+)?email|enter\s+the\s+code|confirm\s+your\s+email|activation/i;
    return rx.test(document.body?.innerText?.slice(0, 4000) || '');
  }).catch(() => false);

  const codeField = page.locator('input[autocomplete="one-time-code"], [data-automation-id="verificationCode"] input').first();
  if (prompt && await codeField.count()) {
    const code = readMail(['--from', 'workday', '--wait', '180']);
    if (!code) {
      state.blocked_on.push(`${tenant} asked for an emailed verification code and get_code.py found none`);
      return false;
    }
    // Never logged: same no-echo rule as every other secret.
    await codeField.fill(code).catch(() => {});
    await clickFirst(page, [
      'button:has-text("Verify")', 'button:has-text("Confirm")',
      'button:has-text("Continue")', 'button[type="submit"]',
    ], { timeout: 8000 });
    await page.waitForTimeout(3000);
    state.verified.push('email-verification-code');
    return true;
  }

  // No code field: the tenant may have mailed an activation link instead.
  const link = readMail(['--from', 'workday', '--wait', '180',
    '--link', `myworkdayjobs\\.com/.*(activate|verify)`]);
  if (link) {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await dismissOverlays(page);
    state.verified.push('email-activation-link');
    return true;
  }

  // Some tenants sign the account straight in with no confirmation step.
  if (await inWizard(page) || (await entryChoices(page)).length) return true;

  state.blocked_on.push(
    `created the ${tenant} account but could not confirm the email — no code field on the page and`
    + ' no activation link in the mailbox. Finish it by hand in the job browser (VNC :5900).');
  return false;
}

// get_code.py reads Gmail over IMAP read-only. Its output is a secret: it is
// returned to the caller and never logged, cached or written to answers/.
function readMail(args) {
  try {
    return execFileSync('python3', [path.join(BASE, 'get_code.py'), ...args],
      { cwd: BASE, encoding: 'utf8', timeout: 220000 }).trim() || null;
  } catch { return null; }
}

// login.env is the credential store and is gitignored. Written atomically so an
// interrupted run cannot leave the file truncated with every other account in it.
function persistCredentials(site, email, password) {
  const file = path.join(BASE, 'login.env');
  let env = {};
  try { env = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  env.login = env.login || {};
  env.login[site] = {
    email,
    password,
    ats: ATS,
    portal: `${tenant}.myworkdayjobs.com`,
    created: new Date().toISOString().slice(0, 10),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function inWizard(page) {
  return page.locator('[data-automation-id="progressBar"], [data-automation-id="applyFlowPage"]')
    .first().count().then((n) => n > 0).catch(() => false);
}

async function entryChoices(page) {
  const ids = wd?.mechanics?.apply_choices || ['autofillWithResume', 'applyManually', 'useMyLastApplication'];
  const found = [];
  for (const id of ids) {
    if (await page.locator(`[data-automation-id=${id}]`).count().catch(() => 0)) found.push(id);
  }
  return found;
}

// ------------------------------------------------------------- entry choice

async function chooseEntry(page) {
  if (await inWizard(page)) {
    // A draft already exists. Autofill is no longer reachable mid-flight and
    // there is no switch — continue the draft, which is what /apply resumed.
    state.notes.push('resumed an existing Workday draft; the entry choice was not offered');
    return;
  }
  const available = await entryChoices(page);
  if (!available.length) {
    state.blocked_on.push(`no application entry choice and no wizard at ${page.url().slice(0, 120)} — the posting may be closed`);
    return;
  }
  // Cache order: useMyLastApplication, then autofillWithResume, then manual.
  // Autofill parses the TAILORED resume into My Information and My Experience,
  // which is most of the wizard; applyManually means typing every field.
  const order = ['autofillWithResume', 'useMyLastApplication', 'applyManually'];
  const choice = order.find((c) => available.includes(c)) || available[0];

  if (choice === 'autofillWithResume') {
    // The file input may only exist after the choice is clicked; try both orders.
    await wdClick(page.locator(`[data-automation-id=${choice}]`).first());
    await page.waitForTimeout(1500);
    await dismissOverlays(page);
    const input = page.locator('input[type=file]').first();
    if (await input.count()) {
      if (await uploadFile(page, input, pre.resume)) {
        state.resume_uploaded_this_run = true;
        state.filled.push(`resume=${path.basename(pre.resume)} (autofill)`);
        // Workday's own confirmation string.
        const confirm = wd?.mechanics?.resume?.confirm_text || 'Successfully Uploaded!';
        await page.getByText(confirm, { exact: false }).first()
          .waitFor({ timeout: 30000 })
          .then(() => state.verified.push('resume'))
          .catch(() => state.notes.push(`resume uploaded but "${confirm}" never appeared`));
      }
    }
  } else {
    await wdClick(page.locator(`[data-automation-id=${choice}]`).first());
  }
  state.notes.push(`entry choice: ${choice}`);
  await page.waitForTimeout(2500);
  await dismissOverlays(page);
  await advance(page);
}

// ------------------------------------------------------------------- wizard

// Step COUNT is not fixed — HP runs 6, Ciena 8 — so the live Application
// Progress list is read every pass instead of assuming a shape.
async function progressSteps(page) {
  return page.evaluate(() => {
    // No progress bar means no step list. Falling back to `document` here made
    // the `li` below match every list item on the page — nav, footer and all.
    const root = document.querySelector('[data-automation-id="progressBar"]');
    if (!root) return [];
    const items = [...root.querySelectorAll('[data-automation-id="progressBarStepIcon"], li, [role=listitem]')];
    const out = [];
    for (const li of items) {
      const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;
      const active = /active|current/i.test(li.className)
        || li.getAttribute('aria-current') === 'step'
        || /current step/i.test(li.getAttribute('aria-label') || '');
      const done = /complete|visited|finished/i.test(li.className);
      if (!out.some((s) => s.text === text)) out.push({ text, active, done });
    }
    return out;
  }).catch(() => []);
}

async function currentStepName(page) {
  const steps = await progressSteps(page);
  const active = steps.find((s) => s.active);
  if (active) return active.text;
  // Fall back to the page heading — some tenants do not mark the active item.
  return page.locator('h1, h2, [data-automation-id="pageHeader"]').first()
    .textContent().then(norm).catch(() => '');
}

async function advance(page) {
  const next = page.locator(wd?.nav?.next || '[data-automation-id="pageFooterNextButton"]').first();
  if (await next.count()) return wdClick(next);
  return clickFirst(page, [
    'button:has-text("Save and Continue")', 'button:has-text("Continue")',
    'button:has-text("Next")',
  ], { timeout: 8000 });
}

async function walkWizard(page) {
  const seen = new Map();
  for (let pass = 0; pass < 20; pass++) {
    await dismissOverlays(page);

    const cap = await captchaPresent(page);
    if (cap) {
      state.blocked_on.push(
        `CAPTCHA on the ${tenant} wizard (${cap.visible} visible widget(s)`
        + `${cap.coveringSubmit ? ', covering the submit button' : ''}) — solve it in the job browser`
        + ' over VNC :5900, then re-run this posting.');
      return;
    }

    const name = norm(await currentStepName(page));
    const key = lc(name);
    if (/review/.test(key)) { state.notes.push('reached the Review step'); return; }

    // Guard against a step that will not advance: the same step twice is a
    // retry, three times is stuck.
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 3) {
      const errs = await validationErrors(page);
      state.blocked_on.push(
        `"${name}" would not advance after ${n - 1} attempts`
        + (errs.length ? `; the page shows: ${errs.slice(0, 4).join(' | ')}` : ''),
      );
      return;
    }

    await handleStep(page, key, name);
    if (state.blocked_on.length) return;

    await advance(page);
    await page.waitForTimeout(2500);

    const errs = await validationErrors(page);
    if (errs.length && norm(await currentStepName(page)) === name) {
      // Leave it to the retry pass; only report if it never clears.
      state.notes.push(`"${name}" reported: ${errs.slice(0, 3).join(' | ')}`);
    }
  }
  state.blocked_on.push('the wizard did not reach Review within 20 passes');
}

async function handleStep(page, key, name) {
  if (/my information/.test(key)) return myInformation(page, name);
  if (/my experience/.test(key)) return myExperience(page, name);
  if (/voluntary disclosure/.test(key)) return voluntaryDisclosures(page, name);
  if (/self identify|self-identify|disability/.test(key)) return selfIdentify(page, name);
  // Application Questions (any "N of M" variant) and anything a tenant invents.
  return tenantQuestions(page, name);
}

// Steps 1-2 are ~90% identical across tenants; the tenant-specific parts are
// "How Did You Hear About Us", the Application Questions set and Field of Study.
async function myInformation(page, name) {
  const p = pre.profile;
  const src = wd?.steps?.['1-my-information']?.fields || [];
  const cached = (auto) => src.find((f) => f.auto === auto);

  // Previous-employee question: No for every employer unless profile says so.
  const prev = page.locator('[data-automation-id="formField-candidateIsPreviousWorker"]');
  if (await prev.count()) await pickAuto(page, 'formField-candidateIsPreviousWorker', 'No', { label: 'previously employed' });

  // How Did You Hear About Us — tenant-specific list, preference order from
  // profile: Campus drive -> Career fair -> LinkedIn, first that exists.
  const source = page.locator('[data-automation-id="formField-source"]');
  if (await source.count()) {
    // profile.json stores this as an object with a preference_order list, not
    // as a bare list — concat'ing the object itself yielded one useless entry.
    const hdy = p.how_did_you_hear_about_us;
    const prefs = Array.isArray(hdy) ? hdy
      : (hdy && Array.isArray(hdy.preference_order)) ? hdy.preference_order
        : ['Campus drive', 'Career fair', 'LinkedIn'];
    let done = false;
    for (const want of prefs) {
      const before = state.blocked_on.length;
      done = await pickAuto(page, 'formField-source', want, { label: 'how did you hear about us' });
      if (done) break;
      state.blocked_on.length = before;   // a miss here is not a failure; try the next preference
    }
    if (!done) state.blocked_on.push('none of the preferred "How Did You Hear About Us" options exist on this tenant');
  }

  // profile.json nests these under `address`, and carries the state twice:
  // "PA" and state_full "Pennsylvania". Workday's listbox lists full names.
  const addr = p.address || {};
  await fillAuto(page, 'formField-legalName--firstName', p.first_name || cached('formField-legalName--firstName')?.answer, { label: 'first name' });
  await fillAuto(page, 'formField-legalName--lastName', p.last_name || cached('formField-legalName--lastName')?.answer, { label: 'last name' });
  await fillAuto(page, 'formField-addressLine1', addr.street, { label: 'address' });
  // Chester Springs is absent from the gazetteers some portals search, but the
  // Workday address block is a plain text field, so the real town is correct
  // here — typeahead_city exists only for controls that reject it.
  await fillAuto(page, 'formField-city', addr.city, { label: 'city' });
  await fillAuto(page, 'formField-postalCode', addr.zip, { label: 'postal code' });

  if (await page.locator('[data-automation-id="formField-countryRegion"]').count()) {
    await pickAuto(page, 'formField-countryRegion', addr.state_full || addr.state, { label: 'state' });
  }
  // Phone device type: HP has no "Mobile", only "Pers Mobile"; Ciena has a plain
  // "Mobile". Try the tenant's own list rather than assuming either.
  if (await page.locator('[data-automation-id="formField-phoneType"]').count()) {
    const before = state.blocked_on.length;
    if (!(await pickAuto(page, 'formField-phoneType', 'Mobile', { label: 'phone type' }))) {
      state.blocked_on.length = before;
      await pickAuto(page, 'formField-phoneType', 'Pers Mobile', { label: 'phone type' });
    }
  }
  // Autofill can leave a punctuated number Workday's own validator rejects
  // ("Enter a valid format for Phone Number."), so this is re-set from profile
  // as plain digits even when it looks populated.
  await fillAuto(page, 'formField-phoneNumber', String(p.phone || '').replace(/\D+/g, ''), { label: 'phone' });

  state.steps_completed.push(name);
}

async function myExperience(page, name) {
  await deleteNonMastersEducation(page);

  // The Resume/CV upload inside this step ATTACHES the file but does not
  // back-fill anything — that only happens at the autofill entry point. Upload
  // here only when the entry step did not already do it.
  if (!state.resume_uploaded_this_run) {
    const sel = wd?.mechanics?.resume?.upload_selector || 'input[data-automation-id="file-upload-input-ref"]';
    const input = page.locator(sel).first();
    if (await input.count() && await uploadFile(page, input, pre.resume)) {
      state.resume_uploaded_this_run = true;
      state.filled.push(`resume=${path.basename(pre.resume)}`);
      const confirm = wd?.mechanics?.resume?.confirm_text || 'Successfully Uploaded!';
      await page.getByText(confirm, { exact: false }).first().waitFor({ timeout: 30000 })
        .then(() => state.verified.push('resume'))
        .catch(() => state.notes.push(`resume uploaded but "${confirm}" never appeared`));
      await dismissOverlays(page);
    }
  }

  // Websites section — LinkedIn/GitHub/portfolio. Never bind these by name
  // alone: the honeypot is also called "website".
  const p = pre.profile;
  const websites = page.locator('[data-automation-id="formField-websitePanelSet"] input, [data-automation-id="website"] input');
  const wn = await websites.count().catch(() => 0);
  const urls = [p.linkedin, p.github, p.website].filter(Boolean);
  for (let i = 0; i < Math.min(wn, urls.length); i++) {
    const el = websites.nth(i);
    if (await isHoneypot(page, el)) { state.notes.push('skipped the honeypot in the Websites section'); continue; }
    if (await fillText(page, el, urls[i])) state.filled.push(`website=${urls[i]}`);
  }

  // Anything else this step asks (Field of Study, Degree, Languages) goes
  // through the shared question pass, which reads the live DOM.
  await tenantQuestions(page, name, { push: false });
  state.steps_completed.push(name);
}

// Autofill parses BOTH degrees off the resume and creates two Education blocks.
// Only the MS should remain. On Ciena the second block arrived entirely EMPTY
// rather than as parsed B.Tech content, so this deletes whichever block is not
// the master's — by school name, never by position.
async function deleteNonMastersEducation(page) {
  // profile.json's `education` is a single object (the MS), not a list.
  const keepSchool = lc(pre.profile.education?.school || 'Oregon State University');
  for (let guard = 0; guard < 4; guard++) {
    const blocks = page.locator('[data-automation-id="educationSection"] [data-automation-id="panel"], [aria-label^="Education"]');
    const n = await blocks.count().catch(() => 0);
    if (n < 2) return;

    let removed = false;
    for (let i = 0; i < n; i++) {
      const text = lc(await blocks.nth(i).innerText().catch(() => ''));
      if (text.includes(keepSchool)) continue;
      const del = blocks.nth(i).locator('button:has-text("Delete")').first();
      if (await del.count()) {
        await wdClick(del);
        await page.waitForTimeout(1200);
        state.filled.push('deleted the non-master\'s Education block');
        removed = true;
        break;
      }
    }
    if (!removed) return;
  }
}

// Steps 4-6 are Workday/US-federal boilerplate, ~100% identical across tenants,
// and the exact option strings were confirmed byte-for-byte on both HP and
// Ciena. They are filled straight from the cache without inspecting the page.
async function voluntaryDisclosures(page, name) {
  const eeo = wd?.eeo?.exact_options || {};
  if (await page.locator('[data-automation-id="formField-gender"]').count()) {
    await pickAuto(page, 'formField-gender', eeo.gender || 'Male', { label: 'gender' });
  }
  if (await page.locator('[data-automation-id="formField-hispanicOrLatino"]').count()) {
    await pickAuto(page, 'formField-hispanicOrLatino', eeo.hispanicOrLatino || 'No', { label: 'hispanic or latino' });
  }
  if (await page.locator('[data-automation-id="formField-ethnicity"]').count()) {
    // Option text carries a country suffix — "Asian (United States of America)".
    await pickAuto(page, 'formField-ethnicity', eeo.ethnicity || 'Asian', { label: 'ethnicity' });
  }
  if (await page.locator('[data-automation-id="formField-veteranStatus"]').count()) {
    // EXACT match only. See the trap note in cache/workday.json.
    await pickAuto(page, 'formField-veteranStatus', null,
      { label: 'veteran status', exact: eeo.veteranStatus?.pick || 'I AM NOT A VETERAN' });
  }
  // Standard terms-and-conditions consent: authorized 2026-08-08. This does NOT
  // extend to AI-policy or "I certify" attestations, which stop for the human.
  const consent = page.locator('[data-automation-id="formField-acceptTermsAndAgreements"] input[type=checkbox]').first();
  if (await consent.count() && !(await consent.isChecked().catch(() => false))) {
    await wdClick(consent);
    if (await consent.isChecked().catch(() => false)) {
      state.filled.push('accepted the terms and conditions');
      state.verified.push('terms');
    } else {
      state.blocked_on.push('could not tick the terms-and-conditions consent box');
    }
  }
  state.steps_completed.push(name);
}

async function selfIdentify(page, name) {
  const p = pre.profile;
  await fillAuto(page, 'formField-name', `${p.first_name} ${p.last_name}`.trim(), { label: 'self-id signature' });

  // The date is usually pre-filled; set it only when empty.
  const date = page.locator('[data-automation-id="formField-dateSignedOn"] input').first();
  if (await date.count() && !norm(await date.inputValue().catch(() => ''))) {
    const d = new Date();
    const mmddyyyy = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    if (await fillText(page, date, mmddyyyy)) state.filled.push(`self-id date=${mmddyyyy}`);
  }

  // The disability checkboxes carry NO aria-label and no data-automation-id, and
  // their ids are per-render GUIDs — resolve through label[for=<input id>] and
  // match on the label's own text rather than trusting option order.
  const want = lc(wd?.steps?.['5-self-identify']?.controls
    ?.find((c) => c.auto === 'formField-disabilityStatus')?.answer
    || 'No, I do not have a disability');
  const picked = await page.evaluate((wanted) => {
    const boxes = [...document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input[type=checkbox], [data-automation-id="selfIdentifiedDisabilityData"] input[type=checkbox]')];
    for (const b of boxes) {
      const lab = b.labels?.[0] || document.querySelector(`label[for="${CSS.escape(b.id || '')}"]`);
      const t = (lab?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      // "No, I do not have a disability..." must not match on a bare "no".
      if (t.toLowerCase().startsWith(wanted.slice(0, 24))) {
        if (!b.checked) b.click();
        return t;
      }
    }
    return '';
  }, want).catch(() => '');
  if (picked) { state.filled.push(`disability status=${picked}`); state.verified.push('disability status'); }
  else state.notes.push('no disability self-identification control found on this step');

  state.steps_completed.push(name);
}

// Application Questions are tenant-specific: opaque GUID formField ids, labels
// that sit outside the labelled element, and dropdowns that appear conditionally
// (HP went 9 -> 10 after the first pass). This is exactly what the shared
// question pass is for — it reads the live DOM, answers from profile.json and
// cache/workday-answers.json first, and makes ONE model call for the rest.
async function tenantQuestions(page, name, { push = true } = {}) {
  await answerRemaining({
    page,
    formSel: FORM,
    ats: ATS,
    company: tenant,
    slug,
    jdPath: pre.jdPath,
    profile: pre.profile,
    state,
    log,
    fill: (p, f, v) => fillScraped(p, f, v, state),
  });
  if (push) state.steps_completed.push(name);
}

// -------------------------------------------------------------------- submit

async function finish(page) {
  // No model review pass here, unlike ashby_apply.mjs. Two reasons, and they
  // point the same way:
  //   - Workday is a WIZARD. By the time this runs the page is step 6, a
  //     read-only recap; the fields to check are on steps 1-5, which are gone
  //     from the DOM. A review pass here would read a summary and correct
  //     nothing.
  //   - cache/workday.json's step 6 rule is explicit: do NOT read, snapshot or
  //     summarize the review page — it is a recap of what the run just filled,
  //     so reading it buys nothing and costs a model call.
  // Each step is instead verified as it is filled: every fillAuto/pickAuto
  // reads its value back, and walkWizard refuses to advance past a step that
  // still shows validation errors.
  const fields = await auditRequired(page, FORM);
  reconcileBlocked(state, fields);
  for (const f of missingRequired(fields)) {
    state.blocked_on.push(`required field ${f.label || f.name} (${f.name}) is still empty`);
  }

  const errs = await validationErrors(page);
  if (errs.length) state.blocked_on.push(`form shows validation errors: ${errs.slice(0, 4).join(' | ')}`);

  state.ready_to_submit = !state.blocked_on.length && state.resume_uploaded_this_run;

  // CLAUDE.md hard rule: never submit on an account this run created and the
  // candidate has not verified. The wizard is filled and saved as a Workday
  // draft, so approving it later costs one ats_submit.mjs call, not a refill.
  if (state.account_created_this_run) {
    allowSubmit = false;
    state.left_for_human.push(
      `submit withheld: this run created the "${tenant}" account. Check it in the job browser`
      + ` (VNC :5900), then: node ats_submit.mjs ${slug}`,
    );
  }

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

  // The Review page is a read-only recap of steps already filled: scroll to the
  // bottom and submit. Reading or screenshotting it buys nothing.
  await submitAndVerify(page, {
    selectors: [
      '[data-automation-id="pageFooterNextButton"]:has-text("Submit")',
      'button:has-text("Submit")',
      '[data-automation-id="wd-CommandButton_uic_okButton"]',
    ],
    successRe: 'thank you for applying|application (has been )?(submitted|received)|we.{0,3}ve received your application|successfully submitted|your application was submitted',
    state,
    log,
  });
}
