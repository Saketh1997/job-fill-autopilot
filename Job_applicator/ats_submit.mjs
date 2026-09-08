#!/usr/bin/env node
// ats_submit.mjs — stage 4. The ONLY thing in this pipeline that clicks Submit.
//
//   node ats_submit.mjs --list                  what is filled and waiting
//   node ats_submit.mjs <slug>                  review, ask, then submit
//   node ats_submit.mjs <slug> --yes            skip the prompt (still re-audits)
//   node ats_submit.mjs --all                   walk the queue, asking for each
//   node ats_submit.mjs <slug> --dry-run        review only, never click
//
// The fillers (greenhouse/lever/ashby_apply.mjs) now stop once the form is
// filled and leave the tab open. This script goes back to THAT tab — the one
// holding the filled form and its session — re-reads the form as it stands
// right now, shows what is on it, and clicks Submit only after approval.
//
// Why the split: a filled form is reviewable and a submitted one is not. It
// also makes human edits first-class. Anything corrected by hand in the open
// tab is picked up here, because the audit reads the live page rather than
// replaying what the filler thought it wrote.
//
// It refuses to submit when:
//   - the tab for that posting is gone (the filled form went with it)
//   - a required field is empty, or the form is showing a validation error
//   - the attached resume is the generic one, not the tailored PDF
//   - the slug was already submitted
// --force overrides the audit, never the "already submitted" check.
//
// Exit: 0 submitted (or reviewed under --dry-run) · 1 error · 2 declined/blocked.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  BASE, connect, validationErrors, auditRequired, missingRequired,
  submitAndVerify, writeStatus, appendCacheRun, markApplied, norm, resumeAttached,
} from './ats_apply_common.mjs';
import { samePosting } from './posting-identity.mjs';

// A required file input is only "already satisfied" when it IS the resume
// field. Greenhouse's Celonis posting also requires a Cover Letter, and
// exempting every file input let the run call the form complete, click Submit,
// and get back "Cover Letter is required." with nothing to explain it.
const isResumeField = (f) => /resume|cv\b/i.test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`);

const ATS = {
  greenhouse: {
    form: '#application-form',
    selectors: ['#application-form button[type="submit"]',
      'button:has-text("Submit application")', 'button:has-text("Submit Application")'],
    successRe: 'thank you|application (has been )?(submitted|received)|confirmation|we.{0,3}ve received',
  },
  lever: {
    form: 'form',
    selectors: ['button:has-text("Submit application")', 'button[type="submit"]', 'input[type="submit"]'],
    successRe: '/thanks|application submitted|thank you|application (has been )?(submitted|received)|we.{0,3}ve received',
  },
  ashby: {
    form: 'form',
    selectors: ['button:has-text("Submit Application")', 'button:has-text("Submit application")',
      'button[type="submit"]'],
    successRe: 'thanks? (you )?for applying|thank you|application (has been )?(submitted|received)|we.{0,3}ve received|successfully submitted|submitted successfully|application complete',
  },
};

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const opts = {
  slug: '', list: false, all: false, yes: false, force: false, dryRun: false,
  limit: 0, endpoint: process.env.CDP_ENDPOINT || 'http://localhost:9226',
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list') opts.list = true;
  else if (a === '--all') opts.all = true;
  else if (a === '--yes' || a === '-y') opts.yes = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--limit') opts.limit = Number(argv[++i]);
  else if (a === '--code') opts.code = argv[++i];
  else if (a === '--set') opts.set = (opts.set || []).concat(argv[++i]);
  else if (a === '--endpoint') opts.endpoint = argv[++i];
  else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
  else opts.slug = a;
}
if (!opts.slug && !opts.list && !opts.all) {
  console.error('usage: ats_submit.mjs <slug> [--yes] | --list | --all');
  process.exit(1);
}

// A CSS identifier may not begin with a digit, so a pure-numeric control id
// (Greenhouse demographic questions are all of this shape) has to have its
// first character written as a hex escape: 4 -> '\\34 '. Escaping only the
// non-word characters, as this did before 2026-08-29, produces '#4005246007'
// and throws SyntaxError out of locator.count().
const cssEscapeId = (id) => {
  const esc = String(id).replace(/([^\w-])/g, '\\$1');
  return /^[0-9]/.test(esc) ? `\\3${esc[0]} ${esc.slice(1)}` : esc;
};

const readJson = (p, f = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

// Greenhouse gates Submit behind a human check: it emails an 8-character code
// and renders eight single-character boxes (#security-input-0..7) that only
// appear AFTER the first Submit click. Without this the run reports "clicked
// Submit but never saw a confirmation" and looks like a driver bug, when the
// form is simply waiting on the candidate's inbox.
async function securityGate(page) {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[id^="security-input-"]')]
      .filter((e) => e.offsetParent !== null);
    if (boxes.length) return { kind: 'boxes', count: boxes.length };
    const one = [...document.querySelectorAll('input')].find((e) => {
      if (e.offsetParent === null) return false;
      const l = document.querySelector(`label[for="${CSS.escape(e.id || '_')}"]`);
      return /security code|verification code/i.test(l?.textContent || '');
    });
    return one ? { kind: 'single', id: one.id } : null;
  }).catch(() => null);
}

async function enterCode(page, code, log) {
  const gate = await securityGate(page);
  if (!gate) return false;
  const c = String(code).trim();
  if (gate.kind === 'boxes') {
    if (c.length !== gate.count) {
      log(`the code has ${c.length} characters but the form wants ${gate.count}`);
      return false;
    }
    for (let i = 0; i < gate.count; i++) {
      const box = page.locator(`#security-input-${i}`).first();
      await box.click({ timeout: 5000 }).catch(() => {});
      await box.fill(c[i]).catch(() => box.type(c[i], { delay: 30 }).catch(() => {}));
      await page.waitForTimeout(120);
    }
  } else {
    await page.locator(`#${gate.id}`).first().fill(c).catch(() => {});
  }
  await page.waitForTimeout(400);
  const got = await page.evaluate(() => [...document.querySelectorAll('input[id^="security-input-"]')]
    .map((e) => e.value).join('')).catch(() => '');
  log(`verification code entered (${got.length || c.length} chars)`);
  return true;
}
const statusPath = (slug) => path.join(BASE, 'answers', `${slug}.drive.json`);
const log = (...m) => console.error('SUBMIT:', ...m);

// Everything the fillers left filled and clean, newest first.
function pending() {
  const dir = path.join(BASE, 'answers');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.drive.json'))
    .map((f) => ({ file: path.join(dir, f), st: readJson(path.join(dir, f), {}) }))
    .filter(({ st }) => st && ATS[st.ats] && !st.submitted)
    .map(({ file, st }) => ({ ...st, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

// --------------------------------------------------------------------- --list
if (opts.list) {
  const rows = pending();
  if (!rows.length) { console.log('nothing filled and waiting.'); process.exit(0); }
  console.log(`${rows.length} filled application(s) waiting:\n`);
  for (const r of rows) {
    const mark = r.awaiting_submit ? 'READY  ' : 'BLOCKED';
    console.log(`${mark}  ${r.slug}`);
    console.log(`         ${r.apply_url || r.url}`);
    console.log(`         resume: ${r.resume_kind}  ·  fields verified: ${(r.verified || []).length}`
      + (r.blocked_on?.length ? `  ·  blocked: ${r.blocked_on.length}` : ''));
    if (r.blocked_on?.length) console.log(`         ↳ ${r.blocked_on[0].slice(0, 150)}`);
  }
  console.log('\nsubmit one with:  node ats_submit.mjs <slug>');
  process.exit(0);
}

// ---------------------------------------------------------------------- input
const rl = (!opts.yes && process.stdin.isTTY)
  ? readline.createInterface({ input: process.stdin, output: process.stderr })
  : null;
const ask = (q) => new Promise((res) => {
  if (!rl) return res(opts.yes ? 'y' : 'n');
  return rl.question(q, (a) => res(norm(a).toLowerCase()));
});

// ----------------------------------------------------------------- the review
let queue = opts.all ? pending().filter((r) => r.awaiting_submit || opts.force).map((r) => r.slug) : [opts.slug];
if (opts.limit) queue = queue.slice(0, opts.limit);

let browser;
const tally = { submitted: 0, declined: 0, blocked: 0 };
try {
  browser = await connect(opts.endpoint, log);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context over CDP');

  for (const slug of queue) {
    const sp = statusPath(slug);
    const state = readJson(sp);
    if (!state) { log(`${slug}: no answers/${slug}.drive.json — run the filler first`); tally.blocked++; continue; }
    if (state.submitted && !opts.force) { log(`${slug}: already submitted — skipping`); continue; }
    const cfg = ATS[state.ats];
    if (!cfg) { log(`${slug}: unknown ats ${state.ats}`); tally.blocked++; continue; }

    // The filled form lives in ONE tab. Reopening the URL would serve a blank
    // form and submit nothing, so a missing tab is a refusal, not a retry.
    // Identity, not path. Every embedded Greenhouse form lives at the same
    // /embed/job_app path and differs only in ?token, which this used to strip
    // before comparing — so the match could land on a DIFFERENT company's
    // filled form and submit it. It also missed the boards.greenhouse.io ->
    // job-boards.greenhouse.io redirect and reported a live tab as gone.
    const want = (state.apply_url || state.url);
    const page = ctx.pages().find((p) => {
      try { return samePosting(p.url(), want); } catch { return false; }
    });
    if (!page) {
      log(`${slug}: no open tab on ${want} — the filled form is gone. Re-run:`);
      log(`  node ${state.ats}_apply.mjs ${slug}`);
      tally.blocked++;
      continue;
    }
    await page.bringToFront().catch(() => {});

    // Re-audit the LIVE page. This is what makes human edits count: whatever is
    // on the form right now is what gets checked, not what the filler recorded.
    // Hand corrections, applied before the audit so the audit judges the form
    // as it will actually be submitted:  --set question_29547113003=Immediately
    for (const pair of (opts.set || [])) {
      const eq = pair.indexOf('=');
      const [k, v] = [pair.slice(0, eq), pair.slice(eq + 1)];
      const el = page.locator(`#${cssEscapeId(k)}, [name="${k.replace(/"/g, '\\"')}"]`).first();
      if (!(await el.count())) { log(`--set ${k}: no such control on the page`); continue; }
      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await el.selectOption({ label: v }).catch(async () => {
          await el.selectOption(v).catch(() => {});
        });
      } else {
        await el.fill('').catch(() => {});
        await el.fill(v).catch(() => {});
      }
      const got = await el.inputValue().catch(() => '');
      log(`--set ${k} = ${JSON.stringify(got)}${got === v ? '' : ' (DID NOT TAKE)'}`);
      state.filled = (state.filled || []).concat(`${k}=${v} (hand correction)`);
    }

    const formSel = (await page.locator(cfg.form).count()) ? cfg.form : 'body';
    const fields = await auditRequired(page, formSel);
    // What is actually attached to the form right now, read off the page. This
    // has to come before the required-field audit, because a required resume
    // input reads as "empty" from the DOM no matter what: once a file is
    // accepted the input still holds no value, and the filename lives in a chip
    // beside it. Exempting it on state.resume_uploaded_this_run alone meant any
    // filler that does not write that flag (the agy drive path writes a
    // different status schema entirely) had every one of its applications
    // refused for a resume that was demonstrably attached.
    const att = await resumeAttached(page);
    // The security-code boxes are the human check, not part of the application.
    const missing = missingRequired(fields)
      .filter((f) => f.type !== 'file' || !isResumeField(f)
        || !(att.attached || state.resume_uploaded_this_run))
      .filter((f) => !/^security-input-/.test(f.name || ''));
    const errs = await validationErrors(page);

    console.error('\n' + '─'.repeat(72));
    console.error(`${slug}`);
    console.error(`  ${state.ats}  ·  ${page.url()}`);
    console.error(`  resume:  ${att.attached ? att.filename : '(NONE ATTACHED)'}`
      + `${state.resume_kind ? ` (recorded: ${state.resume_kind})` : ''}`);
    console.error(`  filled:  ${(state.verified || []).length} field(s) verified this run`);
    if (state.from_cache?.length) console.error(`  cached:  ${state.from_cache.length} answer(s) reused`);
    if (state.model_cost_usd) console.error(`  model:   $${Number(state.model_cost_usd).toFixed(4)}`);
    for (const f of (state.left_for_human || [])) console.error(`  note:    ${f.slice(0, 160)}`);
    for (const f of missing) console.error(`  EMPTY:   required ${f.label || f.name}`);
    for (const e of errs.slice(0, 4)) console.error(`  ERROR:   ${e.slice(0, 160)}`);
    console.error('─'.repeat(72));

    // The live page decides. state.resume_uploaded_this_run is kept as a second
    // way to say yes, not as the only one — see resumeAttached().
    const clean = !missing.length && !errs.length
      && (att.attached || state.resume_uploaded_this_run);
    if (!att.attached && !state.resume_uploaded_this_run) {
      console.error('  EMPTY:   no resume is attached to this form');
    }
    if (!clean && !opts.force) {
      log(`${slug}: not clean — fix it in the open tab and re-run, or pass --force`);
      tally.blocked++;
      continue;
    }
    // The attached FILE is the evidence, not the status file. Every tailored
    // resume is named for its slug; anything else on the form is the generic
    // one under whatever name profile.json gives it.
    if (att.attached && !att.filename.startsWith(slug) && !opts.force) {
      log(`${slug}: the attached resume is "${att.filename}", not the tailored ${slug}.pdf — refusing`);
      tally.blocked++;
      continue;
    }
    if (state.resume_kind === 'generic' && !opts.force) {
      log(`${slug}: the generic resume is attached, not the tailored one — refusing`);
      tally.blocked++;
      continue;
    }
    if (opts.dryRun) { log(`${slug}: --dry-run, nothing clicked`); continue; }

    const a = await ask(`Submit ${slug}? [y/N/q] `);
    if (a === 'q') { log('stopping'); break; }
    if (a !== 'y' && a !== 'yes') { log(`${slug}: declined, tab left open`); tally.declined++; continue; }

    state.approved_at = new Date().toISOString();
    state.approved_via = opts.yes ? 'ats_submit.mjs --yes' : 'ats_submit.mjs (interactive)';
    state.blocked_on = [];

    // The gate may already be showing from an earlier Submit click.
    if (opts.code) await enterCode(page, opts.code, log);

    await submitAndVerify(page, {
      selectors: cfg.selectors, successRe: cfg.successRe, state, log,
    });

    // ...or it may appear only in response to this click. Either way the form is
    // waiting on the candidate's inbox, which is a different thing from a
    // failed submit and must not be reported as one.
    if (!state.submitted) {
      const gate = await securityGate(page);
      if (gate && opts.code) {
        await enterCode(page, opts.code, log);
        state.blocked_on = [];
        await submitAndVerify(page, {
          selectors: cfg.selectors, successRe: cfg.successRe, state, log,
        });
      } else if (gate) {
        state.blocked_on = [`${state.ats} emailed a verification code to complete this submit — `
          + `re-run with:  node ats_submit.mjs ${slug} --yes --code <code>`];
        state.awaiting_code = true;
      }
    }

    writeStatus(sp, state);
    appendCacheRun(path.join(BASE, 'cache', `${state.ats}.json`), state, { stage: 'ats_submit.mjs' });
    if (state.submitted) {
      // The URL as pipeline.csv knows it, which is not always the one driven.
      markApplied(state.source_url || state.url);
      tally.submitted++;
      log(`${slug}: submitted`);
      // The form is gone and the tab is now a confirmation page. Closing it is
      // what keeps a long queue of filled-and-waiting tabs from growing without
      // bound in the shared browser.
      await page.close().catch(() => {});
    } else {
      tally.blocked++;
      log(`${slug}: ${state.blocked_on[0] || 'submit did not confirm'}`);
    }
  }
} catch (e) {
  log(`error: ${String(e.message || e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  rl?.close();
  try { await browser?.close(); } catch { /* already detached */ }
}

log(`submitted ${tally.submitted}, declined ${tally.declined}, blocked ${tally.blocked}`);
if (!process.exitCode) process.exitCode = tally.submitted ? 0 : 2;
