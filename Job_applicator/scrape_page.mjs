#!/usr/bin/env node
// scrape_page.mjs — dump a fully rendered page through the shared browser.
//
// Fetching a URL with curl or a browser node gives you the server response.
// For LinkedIn that is the logged-out guest page; for an ATS it is a shell
// with no form in it. This connects to the browser that already holds your
// session and takes the DOM after JS has run.
//
//   node scrape_page.mjs <url> [options]
//
//   --fields          form field inventory (main frame + every content frame)
//   --candidates      apply-link candidates, scored, per frame
//   --jd              extract the job description (writes ./jd/<slug>_jd.txt)
//   --jd-out PATH     explicit JD output path, keyed on the pipeline slug
//   --text            also write innerText alongside the HTML
//   --frames          also dump child frame HTML to disk
//   --expand          click "see more" style buttons before dumping
//   --expand-selects  open react-select dropdowns to capture their options
//                     (requires --fields; this CLICKS controls, see note below)
//   --all-frames      keep noise frames (chat widgets, trackers) too
//   --out DIR         where to write (default ./scrapes)
//   --wait MS         extra settle after networkidle (default 0)
//   --selector SEL    wait for this selector before dumping
//   --stdout          print main-frame HTML to stdout, report to stderr
//
// Env: CDP_ENDPOINT (default http://localhost:9222)
// Exit: 0 ok   3 error   4 came back logged out   5 bad usage

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const url = argv.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));

if (!url) {
  console.error('usage: scrape_page.mjs <url> [--fields] [--candidates] [--frames] [--text]');
  process.exit(5);
}

const CDP = process.env.CDP_ENDPOINT || 'http://localhost:9222';
const OUT = val('--out', './scrapes');
const JD_OUT = val('--jd-out', '');   // explicit JD path; key it on the pipeline slug
const EXTRA_WAIT = Number(val('--wait', 0));
const SELECTOR = val('--selector', '');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Frames that never contain an application. Skipped unless --all-frames.
const FRAME_NOISE = /hubspot|addtoany|doubleclick|googletagmanager|google-analytics|onetrust|cookielaw|intercom|drift|zendesk|sw_iframe|recaptcha|facebook\.com|clarity\.ms/i;

const slug = createHash('sha1').update(url).digest('hex').slice(0, 12);

// =========================================================== in-page routines
// These run inside a frame, so they cannot close over anything above.

// Job description. Landing pages carry it in one of three shapes, tried in
// order of cleanliness. This runs on the FIRST page scraped, because the JD
// lives there and is gone by the time you hop to the application form.
const JD_EXTRACT = () => {
  const clean = (s) => (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const out = { source: null, title: null, company: null, location: null, text: '' };

  // 1. ld+json JobPosting. The cleanest source when present. Schema.org is
  //    explicit, so no guessing which block is the description.
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const nodes = [].concat(JSON.parse(s.textContent));
      const jp = nodes.find((n) => n && (n['@type'] === 'JobPosting'
        || (Array.isArray(n['@type']) && n['@type'].includes('JobPosting'))));
      if (jp && jp.description) {
        out.source = 'ld+json';
        out.title = jp.title || null;
        out.company = jp.hiringOrganization?.name || null;
        out.location = jp.jobLocation?.address?.addressLocality
          || jp.jobLocation?.[0]?.address?.addressLocality || null;
        out.text = clean(jp.description);
        return out;
      }
    } catch { /* malformed block, try the next */ }
  }

  // 2. Platform payloads. Ashby, Greenhouse, and friends hydrate from an inline
  //    JSON blob. Pull the longest string on a description-ish key.
  const KEYS = /description|jobDescriptionHtml|content|job_post|descriptionHtml|descriptionPlain|jobDescription/i;
  let best = '';
  const walk = (o, depth) => {
    if (!o || depth > 8) return;
    if (typeof o === 'string') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && KEYS.test(k) && v.length > best.length && v.length > 200) best = v;
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  for (const tag of document.querySelectorAll('script')) {
    const t = tag.textContent || '';
    if (t.length < 200 || !KEYS.test(t)) continue;
    // Prefer a parsed global, but fall back to scraping JSON substrings out of
    // an assignment like  window.__X = {...}
    const m = t.match(/(\{[\s\S]*\})/);
    if (m) { try { walk(JSON.parse(m[1]), 0); } catch { /* not clean JSON */ } }
  }
  if (best) {
    out.source = 'inline-json';
    out.text = clean(best);
    out.title = document.title || null;
    return out;
  }

  // 3. Visible-text fallback. Take the largest content container. Crude, but on
  //    a plain HTML posting it captures the body, and downstream skill-gap work
  //    tolerates some nav noise better than it tolerates a missing JD.
  const containers = [...document.querySelectorAll(
    'article, main, [class*="description" i], [class*="job" i][class*="content" i], [class*="posting" i]')]
    .map((el) => ({ el, len: (el.innerText || '').length }))
    .sort((a, b) => b.len - a.len);
  if (containers[0] && containers[0].len > 200) {
    out.source = 'visible-text';
    out.text = clean(containers[0].el.innerText);
    out.title = document.title || null;
    return out;
  }

  // Last resort: whole body.
  out.source = 'body';
  out.text = clean(document.body?.innerText || '');
  out.title = document.title || null;
  return out;
};

const FIELD_WALKER = () => {
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText.trim();
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim();
      if (t) return t;
    }
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || null;
  };
  const hint = (el) => {
    const d = el.getAttribute('aria-describedby');
    if (!d) return null;
    const t = d.split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' ').trim();
    return t || null;
  };

  return [...document.querySelectorAll('input, select, textarea')]
    .filter((el) => el.type !== 'hidden' && el.offsetParent !== null)
    .map((el) => ({
      name: el.name || el.id || null,
      id: el.id || null,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.getAttribute('role') || el.tagName.toLowerCase(),
      required: el.required || el.getAttribute('aria-required') === 'true',
      autocomplete: el.getAttribute('autocomplete') || null,
      label: labelFor(el),
      hint: hint(el),
      maxlength: el.getAttribute('maxlength') || null,
      accept: el.getAttribute('accept') || null,
      // Populated for native <select> only. react-select renders its list on
      // open, so [] on a combobox means unknown, not none. --expand-selects
      // fills these in from the node side by opening the control.
      options: [...(el.options || [])].map((o) => ({ value: o.value, text: o.text })),
    }));
};

// Apply-link candidates. Runs per frame; the caller tags each hit with which.
const CANDIDATES = () => {
  const SIGNAL = /apply|application|submit|candidate|interested|start|continue|career/i;

  const rows = [...document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]')]
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      href: el.getAttribute('href') || null,
      text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      aria: el.getAttribute('aria-label') || '',
      // Semantic BEM classes like job-apply__button are often the strongest
      // signal on a page whose link text is only "apply".
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 150),
      id: el.id || '',
      visible: !!(el.offsetParent || el.getBoundingClientRect().width),
    }))
    .filter((c) => c.visible
      && SIGNAL.test(`${c.text} ${c.aria} ${c.href || ''} ${c.cls} ${c.id}`));

  // Dedupe on href when there is one, else on text+aria. Deduping on href alone
  // collapses every button into the first, because buttons have no href.
  return rows.filter((c, i, a) => a.findIndex((x) =>
    (c.href ? x.href === c.href
            : (!x.href && x.text === c.text && x.aria === c.aria))
  ) === i);
};

const SCROLL_ALL = async () => {
  await new Promise((done) => {
    let y = 0;
    const step = setInterval(() => {
      window.scrollBy(0, 900); y += 900;
      if (y >= document.body.scrollHeight || y > 60000) { clearInterval(step); done(); }
    }, 120);
  });
  window.scrollTo(0, 0);
};

// ================================================================ node side

const absolute = (href, base) => {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
};

// Rank so tier 1 can take an unambiguous winner without calling a model.
const score = (c) => {
  const label = `${c.text} ${c.aria}`.trim();
  let s = 0;

  if (/^(apply|apply now|apply here|apply online|apply for this job|submit application|start application|continue application)$/i.test(label)) s += 60;
  else if (/\bapply\b/i.test(label)) s += 35;

  if (/apply/i.test(c.cls) || /apply/i.test(c.id)) s += 30;
  if (/\/apply|\/application|apply=|jobapply/i.test(c.href || '')) s += 25;
  if (c.tag === 'a' && c.href) s += 5;

  // Navigation and marketing that trips the signal regex on every careers site.
  if (/career advice|career resources|careers at|submit your resume|job alert|salary|sign up|create alert|browse|search jobs/i.test(label)) s -= 45;
  if (/\/career-advice|\/careers-at|\/submit-your-resume|\/alerts|\/salary/i.test(c.href || '')) s -= 35;
  if (/^(start|continue|interested|career)/i.test(label) && !/apply/i.test(label)) s -= 10;

  return s;
};

let browser, page;
const started = Date.now();

// Open each react-select-style control long enough to read its options, then
// close it. react-select renders its menu only on open, so a plain scrape sees
// options: []. This is the ONE place scraping mutates the page (it clicks), so
// it is gated behind --expand-selects and only runs with --fields. Every step
// is best-effort: a control we cannot open just keeps its empty options, and we
// always press Escape to leave the form as we found it.
//
// Caveat: virtualized selects (very long lists like Country) may only render
// the visible slice, so captured options can be partial for those. It is aimed
// at short choice lists (visa/relocation/policy dropdowns).
const expandSelects = async (frame, fieldArr) => {
  for (const f of fieldArr) {
    // Only attempt things that look like an unresolved dropdown: no options
    // captured natively, and a "Select..."-style hint or an explicit combobox
    // role. This deliberately skips plain text inputs (name, email, phone).
    const looksSelect = (!f.options || f.options.length === 0)
      && (/select/i.test(f.hint || '') || f.type === 'combobox' || f.type === 'listbox');
    if (!looksSelect) continue;

    const sel = f.id ? `[id="${f.id}"]` : (f.name ? `[name="${f.name}"]` : null);
    if (!sel) continue;                                   // null-name hidden inputs: skip
    const loc = frame.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;

    try {
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => null);
      if (tag === 'select' || tag === 'textarea') continue;  // native select already has options

      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});

      // react-select renders its menu (role=listbox / .select__option) only once
      // the control opens. The reliable openers, tried in order:
      //   1. focus the combobox input and press ArrowDown — react-select's own
      //      keyboard open, works even when the input intercepts a click.
      //   2. click the input directly.
      //   3. click the "Toggle flyout" chevron button in .select__indicators.
      // Options here are .select__option (this Greenhouse build uses emotion-
      // hashed classes but keeps the semantic select__ prefix) or role=option.
      const optLoc = frame.locator('.select__option, [role="option"]');
      const seen = async () => optLoc.first().waitFor({ state: 'visible', timeout: 1200 })
        .then(() => true).catch(() => false);

      await loc.focus().catch(() => {});
      await loc.press('ArrowDown').catch(() => {});
      let appeared = await seen();

      if (!appeared) {
        await loc.click({ timeout: 2000 }).catch(() => {});
        appeared = await seen();
      }

      if (!appeared) {
        // The chevron toggle sits in the same select shell as this input.
        const toggle = loc.locator(
          'xpath=ancestor::*[contains(@class,"select-shell") or contains(@class,"select__container")][1]'
          + '//button[contains(@aria-label,"flyout") or contains(@class,"select__indicator") or contains(@class,"icon-button")]'
        ).first();
        if (await toggle.count().catch(() => 0)) {
          await toggle.click({ timeout: 2000 }).catch(() => {});
          appeared = await seen();
        }
      }

      if (appeared) {
        // Read options scoped to the open menu if we can find it, else globally
        // (only one react-select menu is open at a time, so global is safe).
        const texts = await optLoc.allInnerTexts().catch(() => []);
        const opts = [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))]
          .map((t) => ({ value: t, text: t }));
        if (opts.length) f.options = opts;
      }
    } catch { /* leave options empty on any failure */ }
    finally {
      // Always close the menu so the next control (and the screenshot) is clean.
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
};

try {
  browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || await browser.newContext({ userAgent: UA });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  // Images and media only. Stylesheets stay: the field walker and the candidate
  // extractor both use layout to decide what is visible.
  await page.route('**/*', (r) => {
    const t = r.request().resourceType();
    return (t === 'image' || t === 'font' || t === 'media') ? r.abort() : r.continue();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  if (SELECTOR) await page.waitForSelector(SELECTOR, { timeout: 20000 }).catch(() => {});
  await page.evaluate(SCROLL_ALL).catch(() => {});
  if (EXTRA_WAIT) await page.waitForTimeout(EXTRA_WAIT);

  if (has('--expand')) {
    for (const p of [/see more/i, /show more/i, /read more/i, /view more/i, /show all/i]) {
      const b = page.getByRole('button', { name: p });
      const n = await b.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) await b.nth(i).click({ timeout: 2500 }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }

  mkdirSync(OUT, { recursive: true });

  const html = await page.content();
  const result = {
    requested: url,
    final_url: page.url(),
    title: await page.title().catch(() => null),
    guest: await page.locator('.sign-up-modal__outlet, .contextual-sign-in-modal, a[href*="/signup/cold-join"]')
      .count().then((n) => n > 0).catch(() => false),
    bytes: Buffer.byteLength(html),
    html_path: null,
    text_path: null,
    frames: [],
    fields: null,
    candidates: null,
    jd: null,
    best: null,
    best_kind: null,
    best_reason: null,
    frames_skipped: [],
  };

  // ---- main frame, always frame 0
  const allFields = [];
  const allCandidates = [];

  if (has('--fields')) {
    const f = await page.evaluate(FIELD_WALKER).catch(() => []);
    if (has('--expand-selects')) await expandSelects(page, f);
    f.forEach((x) => allFields.push({ ...x, frame: 0, frame_url: result.final_url }));
  }
  if (has('--candidates')) {
    const c = await page.evaluate(CANDIDATES).catch(() => []);
    c.forEach((x) => allCandidates.push({
      ...x, frame: 0, frame_url: result.final_url,
      abs: absolute(x.href, result.final_url),
    }));
  }

  // ---- child frames
  // page.frames() returns everything: about:blank stubs, service-worker shims,
  // chat and consent widgets. Keep a frame only if it actually has content we
  // care about, otherwise a HubSpot widget costs 77KB of disk per scrape.
  let idx = 0;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    idx += 1;
    const furl = f.url() || '';

    if (!furl || furl === 'about:blank') { result.frames_skipped.push({ idx, url: furl, why: 'blank' }); continue; }
    if (!has('--all-frames') && FRAME_NOISE.test(furl)) {
      result.frames_skipped.push({ idx, url: furl, why: 'noise' });
      continue;
    }

    const ffields = has('--fields') ? await f.evaluate(FIELD_WALKER).catch(() => []) : [];
    if (has('--fields') && has('--expand-selects') && ffields.length) await expandSelects(f, ffields);
    const fcands = has('--candidates') ? await f.evaluate(CANDIDATES).catch(() => []) : [];

    // An iframed ATS form is the whole reason to look at frames at all. A frame
    // with neither fields nor apply candidates is not one.
    if (!has('--all-frames') && ffields.length === 0 && fcands.length === 0) {
      result.frames_skipped.push({ idx, url: furl, why: 'empty' });
      continue;
    }

    ffields.forEach((x) => allFields.push({ ...x, frame: idx, frame_url: furl }));
    fcands.forEach((x) => allCandidates.push({
      ...x, frame: idx, frame_url: furl, abs: absolute(x.href, furl),
    }));

    const rec = { index: idx, url: furl, name: f.name() || null,
                  field_count: ffields.length, candidate_count: fcands.length, html_path: null };

    if (has('--frames')) {
      const fhtml = await f.content().catch(() => null);
      if (fhtml) {
        rec.html_path = join(OUT, `${slug}.frame${idx}.html`);
        rec.bytes = Buffer.byteLength(fhtml);
        writeFileSync(rec.html_path, fhtml);
      }
    }
    result.frames.push(rec);
  }

  if (has('--fields')) result.fields = allFields;

  // JD from the MAIN frame only, before any hop. The description lives on the
  // landing page; the application form you hop to does not carry it.
  if (has('--jd')) {
    const jd = await page.evaluate(JD_EXTRACT).catch(() => null);
    if (jd && jd.text && jd.text.length > 100) {
      result.jd = { source: jd.source, title: jd.title, company: jd.company,
                    location: jd.location, chars: jd.text.length, path: null };
      if (!has('--stdout')) {
        result.jd.path = JD_OUT || join('./jd', `${slug}_jd.txt`);
        mkdirSync(dirname(result.jd.path), { recursive: true });
        writeFileSync(result.jd.path, jd.text);
      }
    } else {
      result.jd = { source: jd?.source || 'none', chars: jd?.text?.length || 0, path: null,
                    note: 'no substantial JD found on this page' };
    }
  }

  if (has('--candidates')) {
    result.candidates = allCandidates
      .map((c) => ({ ...c, score: score(c) }))
      .sort((a, b) => b.score - a.score);

    // Tier 1: take an unambiguous winner and skip the model entirely.
    const [top, next] = result.candidates;
    if (top && top.score >= 55 && (!next || top.score - next.score >= 25)) {
      result.best = top;
      result.best_reason = next ? 'margin' : 'single_strong';
      // A control with no href cannot be navigated to. On a page that already
      // has form fields, a high-scoring button is the SUBMIT control, not a hop
      // target: clicking it submits the application. The hop loop must require
      // best_kind === 'navigate'.
      result.best_kind = top.abs ? 'navigate'
        : (allFields.length > 0 ? 'submit' : 'unknown');
    }
  }

  // ---- write artifacts
  if (has('--stdout')) {
    process.stdout.write(html);
  } else {
    result.html_path = join(OUT, `${slug}.html`);
    writeFileSync(result.html_path, html);
    if (has('--text')) {
      result.text_path = join(OUT, `${slug}.txt`);
      writeFileSync(result.text_path, await page.evaluate(() => document.body.innerText).catch(() => ''));
    }
  }

  result.elapsed_ms = Date.now() - started;
  await page.close().catch(() => {});

  const report = JSON.stringify(result, null, has('--stdout') ? 0 : 2);
  if (has('--stdout')) console.error(report);
  else process.stdout.write(report + '\n');
  process.exit(result.guest ? 4 : 0);
} catch (err) {
  await page?.close().catch(() => {});
  process.stdout.write(JSON.stringify({ requested: url, error: String(err?.message || err) }) + '\n');
  process.exit(3);
}
