#!/usr/bin/env node
// fill_form.mjs — fill an application form from map_fields output, verify, stop.
//
// This script NEVER submits. It fills, reads every value back, screenshots the
// result, and reports what it found. Submission is a separate, human-approved
// step. The stop-at-review rule is the only thing between a bad value and a
// real employer.
//
//   node fill_form.mjs --scrape scrapes/<x>.json --answers answers.json \
//                      [--resume path.pdf] [--shot review.png] [--dry-run]
//                      [--captcha]            attempt the proof-of-work widget
//                      [--keep-open]          leave the tab up for inspection
//
// Env: CDP_ENDPOINT (default http://localhost:9222)
// Exit: 0 filled and verified   2 mismatches or unfilled required   3 error

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SCRAPE = val('--scrape', '');
const ANSWERS = val('--answers', '');
const RESUME = val('--resume', '');
const SHOT = val('--shot', 'review.png');
const CDP = process.env.CDP_ENDPOINT || 'http://localhost:9222';

const die = (msg, code = 3) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(code);
};

if (!SCRAPE || !ANSWERS) die('usage: fill_form.mjs --scrape <scrape.json> --answers <answers.json>');

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { die(`cannot read ${p}: ${e.code || e.message}`); }
};

const scrape = readJson(SCRAPE);
const mapped = readJson(ANSWERS);
const fields = scrape.fields || [];
const answers = mapped.answers || {};
const scriptHandled = mapped.script_handled || [];
const targetUrl = mapped.url || scrape.final_url;

if (!targetUrl) die('no url in scrape or answers');

// Selector by id first, then name. Bracket form avoids escaping problems with
// ids that contain dashes, colons, or dots.
const selectorFor = (f) =>
  f.id ? `[id="${f.id}"]` : (f.name ? `[name="${f.name}"]` : null);

const preview = (v) => (String(v).length > 60 ? `${String(v).slice(0, 57)}...` : String(v));

let browser, page;

try {
  browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || await browser.newContext();
  page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  // Frame lookup. A field carries the frame it was enumerated in; an iframed
  // ATS form is unreachable from page.fill().
  const frameFor = (f) => {
    if (!f.frame || f.frame === 0) return page;
    return page.frames().find((fr) => fr.url() === f.frame_url) || page;
  };

  const report = {
    url: targetUrl,
    dry_run: has('--dry-run'),
    filled: [],
    skipped: [],
    mismatches: [],
    captcha: null,
    submit: null,
    screenshot: null,
    ready_to_submit: false,
  };

  // ------------------------------------------------------------- text fields
  for (const f of fields) {
    if (!(f.name in answers)) continue;
    const value = answers[f.name];
    const sel = selectorFor(f);
    if (!sel) { report.skipped.push({ name: f.name, why: 'no selector' }); continue; }

    const frame = frameFor(f);
    const loc = frame.locator(sel).first();

    if (!(await loc.count())) { report.skipped.push({ name: f.name, why: 'not found' }); continue; }

    // Decide from the live element, not from the scrape. A react-select input
    // reports type="text" and only role="combobox" gives it away, so trusting
    // the recorded type would fill the search box and never pick an option.
    const kind = await loc.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      role: el.getAttribute('role'),
      readonly: el.readOnly || el.disabled,
    })).catch(() => null);

    if (!kind) { report.skipped.push({ name: f.name, why: 'not evaluable' }); continue; }
    if (kind.readonly) { report.skipped.push({ name: f.name, why: 'readonly or disabled' }); continue; }

    if (has('--dry-run')) {
      report.filled.push({ name: f.name, value: preview(value), kind: kind.role || kind.tag, planned: true });
      continue;
    }

    try {
      if (kind.tag === 'select') {
        // Native select. Try visible label first, then raw value.
        await loc.selectOption({ label: value })
          .catch(() => loc.selectOption(value));
      } else if (kind.role === 'combobox' || kind.role === 'listbox') {
        // react-select and friends: open, type, pick from the rendered list.
        // The option list does not exist in the DOM until the control is open,
        // which is why the scrape recorded options: [].
        await loc.click();
        await loc.fill(value).catch(async () => { await loc.type(value, { delay: 20 }); });
        await frame.waitForTimeout(500);
        const opt = frame.locator('[role="option"]', { hasText: value }).first();
        if (await opt.count()) await opt.click();
        else await loc.press('Enter');
      } else {
        await loc.fill(String(value));
      }
      report.filled.push({ name: f.name, value: preview(value), kind: kind.role || kind.tag });
    } catch (e) {
      report.skipped.push({ name: f.name, why: `fill failed: ${e.message.slice(0, 120)}` });
    }
  }

  // -------------------------------------------------- files and checkboxes
  for (const f of scriptHandled) {
    const sel = selectorFor(f);
    const frame = frameFor(f);
    if (!sel) { report.skipped.push({ name: f.name, why: 'no selector' }); continue; }
    const loc = frame.locator(sel).first();
    if (!(await loc.count())) { report.skipped.push({ name: f.name, why: 'not found' }); continue; }

    if (f.action === 'setInputFiles') {
      const path = RESUME || process.env.RESUME_PATH || '';
      if (!path || !existsSync(path)) {
        report.skipped.push({ name: f.name, why: `resume not found: ${path || '(none given)'}` });
        continue;
      }
      if (has('--dry-run')) { report.filled.push({ name: f.name, value: path, kind: 'file', planned: true }); continue; }
      await loc.setInputFiles(path).catch((e) => report.skipped.push({ name: f.name, why: e.message.slice(0, 120) }));
      report.filled.push({ name: f.name, value: path, kind: 'file' });
      continue;
    }

    if (f.action === 'checkbox') {
      // Consent boxes are never auto-checked, required or not. A required
      // consent is a decision for a human, not a default.
      if (f.consenty) { report.skipped.push({ name: f.name, why: 'consent, left for human', required: !!f.required }); continue; }
      if (!f.check) { report.skipped.push({ name: f.name, why: 'optional, left unchecked' }); continue; }
      if (has('--dry-run')) { report.filled.push({ name: f.name, value: 'checked', kind: 'checkbox', planned: true }); continue; }
      await loc.check().catch((e) => report.skipped.push({ name: f.name, why: e.message.slice(0, 120) }));
      report.filled.push({ name: f.name, value: 'checked', kind: 'checkbox' });
    }
  }

  // -------------------------------------------------------------- verify
  // A silent fill failure looks exactly like a success on a screenshot. Read
  // every value back out of the DOM and compare.
  if (!has('--dry-run')) {
    for (const f of fields) {
      if (!(f.name in answers)) continue;
      const sel = selectorFor(f);
      if (!sel) continue;
      const loc = frameFor(f).locator(sel).first();
      if (!(await loc.count())) continue;

      const actual = await loc.evaluate((el) => {
        if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
        if (el.type === 'file') return `files:${el.files?.length || 0}`;
        if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text ?? el.value;
        return el.value ?? '';
      }).catch(() => null);

      const want = String(answers[f.name]);
      const got = String(actual ?? '');
      // Comboboxes echo the selected label rather than the typed text, so a
      // containment check rather than equality.
      const ok = got === want || got.includes(want) || want.includes(got);
      if (!ok) report.mismatches.push({ name: f.name, wanted: preview(want), got: preview(got) });
    }

    for (const f of scriptHandled.filter((x) => x.action === 'setInputFiles')) {
      const loc = frameFor(f).locator(selectorFor(f)).first();
      if (!(await loc.count())) continue;
      const n = await loc.evaluate((el) => el.files?.length || 0).catch(() => 0);
      if (!n) report.mismatches.push({ name: f.name, wanted: 'a file', got: 'none attached' });
    }
  }

  // -------------------------------------------------------------- captcha
  const capt = page.locator('button.frc-button, .frc-captcha button, [class*="captcha"] button').first();
  if (await capt.count()) {
    report.captcha = { present: true, solved: false };
    if (has('--captcha') && !has('--dry-run')) {
      // FriendlyCaptcha is proof of work rather than a puzzle, so it completes
      // on its own once started. It still takes seconds.
      await capt.click().catch(() => {});
      const done = page.locator('.frc-success, [class*="frc"][class*="success"]').first();
      report.captcha.solved = await done.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    }
  }

  // --------------------------------------------------------------- submit
  // Located and reported, never clicked.
  const sub = page.locator('#jobApplyButton, button[type="submit"], [id*="apply" i][role="button"]').first();
  if (await sub.count()) {
    report.submit = {
      selector: await sub.evaluate((el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase())).catch(() => null),
      text: (await sub.innerText().catch(() => '')).trim().slice(0, 60),
      clicked: false,
    };
  }

  // ------------------------------------------------------------ screenshot
  if (!has('--dry-run')) {
    mkdirSync(dirname(SHOT) || '.', { recursive: true });
    await page.screenshot({ path: SHOT, fullPage: true }).catch(() => {});
    report.screenshot = SHOT;
  }

  const unfilledRequired = fields
    .filter((f) => f.required && f.name && f.type !== 'file' && f.type !== 'checkbox')
    .filter((f) => !report.filled.some((x) => x.name === f.name))
    .map((f) => f.name);
  report.unfilled_required = unfilledRequired;

  report.ready_to_submit =
    !has('--dry-run')
    && report.mismatches.length === 0
    && unfilledRequired.length === 0
    && (!report.captcha || report.captcha.solved);

  if (!has('--keep-open')) await page.close().catch(() => {});

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ready_to_submit ? 0 : 2);
} catch (err) {
  await page?.close().catch(() => {});
  die(String(err?.message || err));
}
