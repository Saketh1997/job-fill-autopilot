#!/usr/bin/env node
// readback.mjs — read a filled form back off the LIVE page, as text, for a
// reviewing model that never touches the browser.
//
//   node readback.mjs <slug> [--json] [--endpoint http://localhost:9226]
//
// WHY THIS EXISTS
//
// The split this file serves: agy (gemini-3.7-flash) drives the browser and
// fills the form; a stronger model reads what landed and decides whether it is
// right. That decision cannot be made from answers/{slug}.drive.json — that
// file records which fields the filler THINKS it set, by name, with no values
// and no questions. "filled: [q7, q12]" is not reviewable.
//
// It also cannot be made from the filler's own account of its work. A filler
// that answered "Immediately" to a graduation-date control will report the
// field as filled and verified, because it did set the control to the value it
// chose. The only trustworthy source is the page itself.
//
// So this connects to the tab holding the filled form, runs the same
// scrapeQuestions the review pass uses, and emits every control as
// {question, kind, required, value, chosen, options} plus whatever validation
// errors the form is currently showing. No model, no writes to the page.
//
// The reviewer reads the sheet, writes answers/{slug}.corrections.json, and
// agy_step.sh fix applies it. Nothing here submits anything.
//
// Exit: 0 read back · 1 error · 3 nothing reviewable (no open tab for this
//       posting, or the page yielded zero controls — see the guard below).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE, connect, validationErrors } from './ats_apply_common.mjs';
import { scrapeQuestions, resolveFromProfile } from './ats_questions.mjs';
import { samePosting, postingKey, hostOf } from './posting-identity.mjs';

const argv = process.argv.slice(2);
const opts = { slug: '', json: false, full: false, endpoint: process.env.CDP_ENDPOINT || 'http://localhost:9226' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a === '--full') opts.full = true;
  else if (a === '--endpoint') opts.endpoint = argv[++i];
  else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
  else opts.slug = a;
}
if (!opts.slug) { console.error('usage: readback.mjs <slug> [--brief default] [--full] [--json]'); process.exit(1); }

const log = (...m) => console.error('READBACK:', ...m);
const readJson = (p, f = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

// The form root per ATS, so scrapeQuestions does not pick up the site's search
// box and newsletter signup as application questions. An unknown ATS gets the
// whole document, which is right for a wizard portal — those have no single
// stable form element.
const FORM_SEL = {
  greenhouse: '#application-form',
  lever: 'form',
  ashby: 'form',
};

const state = readJson(path.join(BASE, 'answers', `${opts.slug}.drive.json`), {}) || {};

// The URL comes from the filler's own status file when there is one, and from
// resolve_slug.py otherwise — the same lookup every other stage uses, so a
// readback can never disagree with the stage that filled the form.
let url = state.apply_url || state.url || '';
if (!url) {
  try {
    url = execFileSync('python3', [path.join(BASE, 'resolve_slug.py'), opts.slug], { encoding: 'utf8' }).trim();
  } catch { /* handled below */ }
}
if (!url) { log(`no URL for ${opts.slug} — no answers/${opts.slug}.drive.json and resolve_slug.py found nothing`); process.exit(1); }



let browser;
try {
  browser = await connect(opts.endpoint, log);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context over CDP');

  // The tab holding THIS posting's filled form, identified properly.
  //
  // Comparing the path with the query stripped is not enough: every embedded
  // Greenhouse form shares the path /embed/job_app and differs only in ?token,
  // so a path match would happily read back a DIFFERENT company's application
  // and report it as this one's — a worse failure than finding no tab at all.
  //
  // The host fallback stays, because a wizard portal walks through half a dozen
  // URLs and ends nowhere near the posting it started from. It is only allowed
  // when this posting has no strong id to match on, so it can never silently
  // pick up a sibling greenhouse/ashby/lever posting.
  const pages = ctx.pages();
  const host = hostOf(url);
  const strong = /^(greenhouse|ashby|lever):/.test(postingKey(url));
  const page = pages.find((p) => { try { return samePosting(p.url(), url); } catch { return false; } })
    || (strong ? null : pages.find((p) => hostOf(p.url()) === host));
  if (!page) {
    log(`no open tab on ${host} — the filled form is gone. Re-fill before reviewing:`);
    log(`  ./Job_applicator/agy_step.sh fill ${opts.slug}`);
    process.exit(3);
  }

  const ats = state.ats || '';
  // 'body', not 'form'. scrapeQuestions scopes to document.querySelector(sel),
  // so a bare 'form' selects the FIRST form on the page — which on a portal
  // that is not one of the three embedded boards is usually site chrome. On
  // amazon.jobs that is #logout-form, one input, and the whole application read
  // back as 0 controls while a filled wizard sat right there. An unknown ATS
  // gets the whole document, which is what the FORM_SEL comment always said.
  const formSel = FORM_SEL[ats] || 'body';
  // Anti-bot plumbing is not an application question. The reCAPTCHA response
  // field is a textarea holding a ~2KB opaque token, and the label scraper
  // reads whatever text sits above it — on Zip's form it came back as the
  // question "Legal Name" with a base64 blob for an answer. Left in, it costs
  // the reviewer two thousand characters to decide nothing.
  const NOISE = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)/;

  // Search every frame, not just the main one. An employer that embeds its ATS
  // (Databricks hosts the Greenhouse form in an iframe on its own careers page)
  // has NOTHING on the main frame, so a main-frame-only scrape reports a fully
  // filled application as "0 controls" and it cannot be reviewed at all.
  // scrape_page.mjs has always walked frames for this reason; this did not.
  //
  // The frame with the most controls wins: a page can carry an unrelated
  // consent or chat iframe, and those hold one or two inputs at most.
  const frames = page.frames();
  let questions = [];
  let usedFrame = 'main';
  for (const fr of frames) {
    let found = [];
    try { found = await scrapeQuestions(fr, formSel); } catch { continue; }
    found = found.filter((q) => !NOISE.test(String(q.selector || '').replace(/^#/, ''))
      && !NOISE.test(String(q.key || '')));
    if (found.length > questions.length) {
      questions = found;
      usedFrame = fr === page.mainFrame() ? 'main' : (fr.url() || 'child').slice(0, 90);
    }
  }
  if (usedFrame !== 'main') log(`form found in a child frame: ${usedFrame}`);
  // Errors and attachments are still read from the main frame; on an embedded
  // form they may live in the child frame instead, so an empty list here is
  // 'nothing seen', not proof of a clean form.
  const errors = await validationErrors(page);

  // Which comboboxes are only PRETENDING to hold a value.
  //
  // react-select keeps a committed choice in a sibling node (.select__single-value)
  // and keeps uncommitted typing in the input itself. scrapeQuestions collapses
  // both into one `value`, so a field where text was typed but never picked from
  // the dropdown reads back exactly like a filled one.
  //
  // Reltio, 2026-08-26: two required "Location*" controls both read back as
  // "Pennsylvania", the whole form looked complete, and the submit gate had no
  // reason to object. Greenhouse rejected the click with "Location* |
  // Pennsylvania | This field is required." Distinguishing the two costs one
  // evaluate and turns a wasted Submit into a correction.
  const uncommitted = new Set(await page.evaluate((sels) => {
    const out = [];
    for (const { key, selector } of sels) {
      let el = null;
      try { el = document.querySelector(selector); } catch { el = null; }
      if (!el) continue;
      const shell = el.closest('.select__container, .select__control, [class*="select-shell"], [class*="Select"]');
      // Only react-select splits a choice across two nodes. On a plain <input>
      // combobox -- Oracle Cloud Recruiting's date and EEO controls, for one --
      // the input's own value IS the form state, there is no chip or hidden
      // twin to find, and treating its absence as "never committed" flags every
      // correctly answered field as a BLOCKER. That cost a full fix/readback
      // cycle on Oracle 2026-08-27: agy set all five controls, verified each,
      // and the sheet still came back reporting the same five as uncommitted.
      if (!shell) continue;
      const chip = shell?.querySelector('.select__single-value, [class*="singleValue"], .select__multi-value, [class*="multiValue"]');
      // A committed react-select also parks the real value in a hidden input.
      const hidden = shell?.querySelector('input[type="hidden"]');
      const committed = !!(chip && chip.textContent.trim()) || !!(hidden && hidden.value);
      if (!committed && String(el.value || '').trim()) out.push(key);
    }
    return out;
  }, questions.filter((q) => q.kind === 'combobox').map((q) => ({ key: q.key, selector: q.selector }))).catch(() => []));

  // A file input's value is inaccessible from script, but its filename is
  // rendered next to it on every ATS here, so the reviewer can still see WHICH
  // resume is attached — the one check that decides whether a submit is honest.
  const attachments = await page.$$eval('input[type="file"]', (els) => els
    .filter((e) => e.offsetParent !== null || e.closest('[class*="file" i]'))
    .map((e) => {
      const entry = e.closest('[data-field-path], .field, .form-group, [class*="file" i]') || e.parentElement;
      const shown = (entry?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return { name: e.name || e.id || null, required: e.required, shown };
    })).catch(() => []);

  const sheet = {
    slug: opts.slug,
    url,
    page_url: page.url(),
    ats: ats || 'unknown',
    read_at: new Date().toISOString(),
    resume_kind: state.resume_kind || 'unknown',
    resume_path: state.resume || '',
    validation_errors: errors,
    attachments,
    questions,
  };

  const out = path.join(BASE, 'answers', `${opts.slug}.readback.json`);
  fs.writeFileSync(out, `${JSON.stringify(sheet, null, 2)}\n`);
  log(`${questions.length} control(s) read back -> ${out}`);

  if (opts.json) { console.log(JSON.stringify(sheet, null, 2)); process.exit(0); }

  // ------------------------------------------------------------------ triage
  //
  // The reviewing model is the expensive part of this loop, and a 40-field form
  // with full option lists is tens of thousands of tokens of which almost none
  // needs judgement. So the sheet is triaged HERE, deterministically, and only
  // the answers that actually need a decision are printed.
  //
  // The split is by who chose the answer:
  //   - resolveFromProfile returns a value and the form holds it  -> nobody
  //     chose anything, the filler copied a recorded fact. Counted, not shown.
  //   - resolveFromProfile returns a value and the form holds something else
  //     -> the filler overrode a recorded fact. Always shown.
  //   - resolveFromProfile returns nothing and the form holds something -> the
  //     filler improvised. This is the whole reason a reviewer exists. Shown.
  //   - required and empty, or named in a validation error -> blocks a submit.
  //     Shown first.
  //
  // --full prints everything, for when a review needs the whole form in view.
  const profile = readJson(path.join(BASE, 'profile.json'), {}) || {};

  const shown = (q) => (q.chosen?.length ? q.chosen.join(', ') : (q.value || ''));
  const cmp = (v) => String(v ?? '').toLowerCase().replace(/[\s ]+/g, ' ')
    .replace(/[.,;:!?'"()\[\]]/g, '').trim();

  // Long free text is the other half of the budget. The head and tail of an
  // answer are what reveal a fabrication or a wrong subject; the middle rarely
  // changes a verdict, and the full text is in the JSON if it does.
  const CAP = 600;
  const clip = (v) => {
    const t = String(v ?? '');
    if (t.length <= CAP) return t;
    return `${t.slice(0, CAP - 160)} […${t.length - CAP + 200} chars…] ${t.slice(-160)}`;
  };
  const OPTCAP = 12;
  const optList = (q) => {
    const all = (q.options || []).map((o) => o.label ?? o.text ?? o.value)
      .filter((x) => x != null && String(x).trim());
    if (!all.length) return '';
    const head = all.slice(0, OPTCAP).map((x) => JSON.stringify(String(x))).join(' | ');
    return all.length > OPTCAP ? `${head}  (+${all.length - OPTCAP} more)` : head;
  };

  const errBlob = cmp(errors.join(' '));
  const rows = questions.map((q) => {
    const have = shown(q);
    const want = (() => { try { return resolveFromProfile(q.question, profile, q.description || ''); } catch { return null; } })();
    const flagged = !!q.question && errBlob.includes(cmp(q.question).slice(0, 40)) && cmp(q.question).length > 8;
    const stuck = uncommitted.has(q.key);
    let cls;
    if ((q.required && !have) || flagged || stuck) cls = 'BLOCKER';
    else if (want != null && cmp(have) === cmp(want)) cls = 'AUTO-OK';
    else if (want != null) cls = 'MISMATCH';
    else if (have) cls = 'JUDGE';
    else cls = 'EMPTY-OPTIONAL';
    return { q, have, want, cls, stuck };
  });

  const count = (c) => rows.filter((r) => r.cls === c).length;
  const show = opts.full ? rows : rows.filter((r) => ['BLOCKER', 'MISMATCH', 'JUDGE'].includes(r.cls));

  console.log(`# readback — ${opts.slug}`);
  console.log(`page:   ${page.url()}`);
  console.log(`ats:    ${sheet.ats}    resume: ${sheet.resume_kind}    controls: ${rows.length}`);
  console.log(`triage: ${count('BLOCKER')} blocker · ${count('MISMATCH')} mismatch · ${count('JUDGE')} improvised`
    + ` · ${count('AUTO-OK')} match profile.json · ${count('EMPTY-OPTIONAL')} optional+empty`);
  console.log(`        (full sheet: answers/${opts.slug}.readback.json — rerun with --full to print it all)`);

  if (errors.length) {
    console.log(`\n!! form is showing ${errors.length} validation error(s):`);
    for (const e of errors.slice(0, 15)) console.log(`   - ${e}`);
  }
  if (attachments.length) {
    console.log('\n## attachments');
    for (const a of attachments) console.log(`- ${a.name || '(unnamed)'}${a.required ? ' *' : ''}: ${clip(a.shown) || '(nothing shown)'}`);
  }

  // Zero controls is NOT a clean form. Before 2026-08-29 it fell through to the
  // all-clear below, so a page the fill never reached — a closed posting, a
  // login or consent wall, a Workday /apply/autofillWithResume gate (which is
  // the resume-upload step, not the form) — was handed to the reviewer as
  // "nothing needs a decision". Six sheets in the 2026-08-26 backlog read that
  // way. An unread form and a perfect form must never render identically: the
  // whole point of the fill/review split is that a human or planner decides
  // whether the answers are right, and there is nothing here to decide on.
  if (!rows.length) {
    console.log('\n!! NOT REVIEWABLE — zero form controls were read on this page.');
    console.log('   This is not an all-clear. Nothing on this posting has been reviewed,');
    console.log('   and nothing about it should be submitted.');
    console.log('   Usual causes: the posting is closed, a login/consent wall is in front');
    console.log('   of the form, the URL is a resume-upload gate rather than the form');
    console.log('   itself, or the driver aborted before touching a single control.');
    console.log(`   Re-fill before reviewing:  ./Job_applicator/agy_step.sh fill ${opts.slug}`);
    console.error(`READBACK: NOT REVIEWABLE — 0 controls read on ${page.url()} — the form was never reached, so this is not an all-clear`);
    process.exit(3);
  }

  if (!show.length) {
    console.log('\nnothing needs a decision: every answered control matches profile.json and no required field is empty.');
    process.exit(0);
  }

  const order = { BLOCKER: 0, MISMATCH: 1, JUDGE: 2, 'AUTO-OK': 3, 'EMPTY-OPTIONAL': 4 };
  show.sort((a, b) => order[a.cls] - order[b.cls]);

  console.log('\n## needs a decision\n');
  for (const { q, have, want, cls, stuck } of show) {
    console.log(`[${q.key}] ${cls}${q.required ? ' *required*' : ''}  (${q.kind})`);
    console.log(`      Q: ${q.question}`);
    if (q.description) console.log(`      hint: ${clip(q.description)}`);
    console.log(`      form holds: ${have ? JSON.stringify(clip(have)) : '(EMPTY)'}`
      + (stuck ? '   <-- TYPED BUT NOT COMMITTED: the dropdown was never used, the form reads this as empty' : ''));
    if (want != null) console.log(`      profile.json says: ${JSON.stringify(clip(want))}`);
    const o = optList(q);
    if (o) console.log(`      options: ${o}`);
    console.log(`      selector: ${q.selector}`);
    console.log('');
  }
  process.exit(0);
} catch (e) {
  log(String(e?.message || e).split('\n')[0]);
  process.exit(1);
} finally {
  try { await browser?.close(); } catch { /* the shared browser outlives us */ }
}
