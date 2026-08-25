// ats_apply_common.mjs — the parts of amazon_apply.mjs that are not about
// amazon.jobs, factored out so greenhouse_apply.mjs / lever_apply.mjs /
// ashby_apply.mjs are each just their portal's shape.
//
// Same contract as amazon_apply.mjs, and deliberately so:
//   - stage 3 only. It never fetches a JD and never tailors a resume; a missing
//     artefact means an earlier stage failed and the chain stops.
//   - no model, ever. Every value comes from plans/{slug}.json, which make_plan.py
//     built from profile.json and data/*.txt. A field this script has no planned
//     value for goes to blocked_on — it is never improvised.
//   - a value is only "filled" once it has been read back off the page. The MCP
//     filler reported success on an empty form; readback is why that cannot
//     happen here.
//   - submit is gated on: tailored resume uploaded THIS run, every required
//     field verified non-empty, and no visible validation error.
//
// Writes answers/{slug}.drive.json in the shape drive_application.sh emits, so
// everything downstream is unchanged.
//
// Exit: 0 done (submitted, or filled with --no-submit) · 1 error · 2 blocked.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = path.resolve(BASE, '..');
export const TODAY = new Date().toISOString().slice(0, 10);

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const lc = (s) => norm(s).toLowerCase();

// ---------------------------------------------------------------- arguments
export function parseArgs(argv, usage) {
  const opts = {
    slug: '',
    resumeArg: '',
    endpoint: process.env.CDP_ENDPOINT || 'http://localhost:9226',
    // Filling and submitting are separate stages, and the default is fill.
    // A driver cannot submit unless it is asked to in so many words; the
    // approval step lives in ats_submit.mjs, where a human sees the form first.
    allowSubmit: false,
    dryRun: false,
    keepTab: false,
    force: false,
    // The post-fill review pass (ats_review.mjs) is ON by default: a form that
    // is full is not the same as a form that is right, and one model call is
    // cheaper than a wrong application. --no-review is the escape hatch.
    review: process.env.ATS_REVIEW !== '0',
    deadlineMs: Number(process.env.ATS_RUN_TIMEOUT_MS || 900000),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') opts.resumeArg = argv[++i];
    else if (a === '--endpoint') opts.endpoint = argv[++i];
    else if (a === '--no-submit') opts.allowSubmit = false;   // now the default; kept so old callers still parse
    else if (a === '--submit') opts.allowSubmit = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--keep-tab') opts.keepTab = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-review') opts.review = false;
    else if (a === '--review') opts.review = true;
    else if (a === '--timeout') opts.deadlineMs = Number(argv[++i]) * 1000;
    else if (a === 'swe' || a === 'ml' || a === 'robotics') { /* role: stage 2 owns it */ }
    else if (a.startsWith('-')) die(`unknown flag: ${a}`);
    else if (!opts.slug) opts.slug = a;
  }
  if (!opts.slug) die(usage);
  if (opts.slug !== path.basename(opts.slug)) die(`bad slug: ${opts.slug}`);
  return opts;
}

export function die(msg) {
  console.error(`ATS_ERR: ${msg}`);
  process.exit(1);
}

export function fileHasBytes(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

// ------------------------------------------------------------ slug -> posting
// resolve_slug.py is the single lookup all three stages share, so no stage can
// disagree about which posting a slug means.
export function resolveSlug(slug) {
  try {
    return execFileSync('python3', [path.join(BASE, 'resolve_slug.py'), slug], {
      cwd: BASE, encoding: 'utf8',
    }).trim();
  } catch {
    die(`no pipeline.csv row whose slugify(company,title) == '${slug}'`);
    return '';
  }
}

// boards.greenhouse.io/embed/job_app?token=NNN carries no board slug, so neither
// greenhouse_jd.py nor the driver can address it — and 28 of the 51 Greenhouse
// postings in one week's scan arrive in exactly that shape, which used to be a
// hard stop and a manual re-scan each. The embed page links back to its own
// board and the token IS the job id, so the canonical URL is one fetch away.
// Verified against the board before it is returned: a guess that 404s is worse
// than the honest refusal this replaces.
// Returned when the embed URL itself 404s: the posting is gone, which is a
// different outcome from "this URL cannot be addressed" and deserves a
// different tally — a closed posting is normal, a resolve failure is a bug.
export const GH_EMBED_GONE = 'gh:posting-gone';

export async function resolveGreenhouseEmbed(url) {
  const m = /[?&]token=(\d+)/.exec(url || '');
  if (!/\/embed\/job_app/.test(url || '') || !m) return url;
  // Retry once. A single failed fetch here is indistinguishable from "this
  // posting has no board", and the batch records that as a permanent failure —
  // two live postings (Hudson River Trading, and a Twitch listing) were written
  // off that way in one minute, both of which resolve fine on a second attempt.
  // Greenhouse rate-limits after a few hundred requests, which a 100-posting run
  // reaches easily.
  const get = async (u, init = {}) => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(20000), ...init })
        .catch(() => null);
      if (res && res.status !== 429 && res.status < 500) return res;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    return null;
  };
  const res = await get(url);
  // A dead posting 404s here. Say so, rather than letting the caller report
  // "could not be resolved to a board" — the board is fine, the job is gone.
  if (res && res.status === 404) return GH_EMBED_GONE;
  const html = res && res.ok ? await res.text().catch(() => '') : '';
  // The board name is in the URL Greenhouse redirects to, as ?for=<board>:
  //   /embed/job_app?token=N  ->  job-boards…/embed/job_app?for=acme&token=N
  // That is authoritative and free. Grepping the HTML for a boards.greenhouse.io
  // path is the fallback, and on its own it missed every posting that redirects
  // this way — two of the first three Greenhouse postings in a 97-job run.
  const board = /[?&]for=([a-zA-Z0-9_-]+)/.exec(res?.url || '')?.[1]
    || [...html.matchAll(/(?:job-)?boards\.greenhouse\.io\/(?!embed)([a-zA-Z0-9_-]+)/g)]
      .map((x) => x[1]).find(Boolean);
  if (!board) return url;
  const canonical = `https://job-boards.greenhouse.io/${board}/jobs/${m[1]}`;
  const head = await get(canonical, { method: 'HEAD' });
  return head && head.ok ? canonical : url;
}

// A slug whose last run already submitted must not be filled again: a second
// application to the same posting is the one mistake this pipeline can make that
// costs a recruiter's attention and cannot be undone.
export function alreadySubmitted(statusPath) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8')).submitted === true;
  } catch { return false; }
}

// A driver that hangs holds a browser tab and a batch slot forever. The watchdog
// is the graceful half of the timeout — it writes the same status file a normal
// run writes, so the ledger records "timed out" rather than nothing. The batch
// runner still wraps the process in a hard `timeout` for the case where the
// event loop itself is wedged.
export function startWatchdog(ms, state, statusPath, log) {
  if (!ms || ms <= 0) return null;
  const t = setTimeout(() => {
    state.blocked_on.push(`run exceeded its ${Math.round(ms / 1000)}s deadline — abandoned mid-form, the tab is left open`);
    state.timed_out = true;
    try { writeStatus(statusPath, state); } catch { /* nothing left to do */ }
    log?.('deadline exceeded; abandoning the run');
    process.exit(2);
  }, ms);
  t.unref?.();
  return t;
}

// --------------------------------------------------------------- preflight
// Loads everything a run needs and refuses to start without it. The resume rule
// is amazon_apply.mjs's: tailored is the expectation, generic is allowed but
// blocks submit, because an application that goes out with the generic PDF is
// worse than one that waits.
export function preflight({ slug, resumeArg, ats }) {
  const jdPath = path.join(BASE, 'jd', `${slug}.txt`);
  const schemaPath = path.join(BASE, 'schema', `${slug}.json`);
  const planPath = path.join(BASE, 'plans', `${slug}.json`);
  const blockedPath = path.join(BASE, 'plans', `${slug}.blocked.json`);

  if (!fileHasBytes(jdPath)) die(`no JD at ${jdPath} — run stage 1: ./get_jd.sh ${slug}`);
  if (!fileHasBytes(schemaPath)) die(`no schema at ${schemaPath} — run ${ats}_jd.py first`);
  if (!fileHasBytes(planPath)) die(`no plan at ${planPath} — run make_plan.py ${slug} first`);

  const profile = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const planBlocked = fileHasBytes(blockedPath)
    ? JSON.parse(fs.readFileSync(blockedPath, 'utf8')) : [];

  let resume = resumeArg || path.join(BASE, 'resumes', `${slug}.pdf`);
  let resumeKind = 'tailored';
  if (!fileHasBytes(resume)) {
    resume = profile.resume_path;
    resumeKind = 'generic';
    console.error(`WARN: no resumes/${slug}.pdf — run stage 2 (./tailor_resume.sh ${slug}).`);
    console.error('      Falling back to the generic resume; SUBMIT IS BLOCKED for this run.');
  }
  if (!fileHasBytes(resume)) die(`no resume at ${resume}`);
  resume = path.resolve(resume);

  return {
    jdPath, schemaPath, planPath, profile, schema, plan, planBlocked,
    resume, resumeKind,
    statusPath: path.join(BASE, 'answers', `${slug}.drive.json`),
    cachePath: path.join(BASE, 'cache', `${ats}.json`),
  };
}

export function newState({ slug, url, ats }) {
  return {
    slug,
    url,
    ats,
    driver: `${ats}_apply.mjs (no model)`,
    filled: [],
    verified: [],
    left_for_human: [],
    blocked_on: [],
    notes: [],
    cache_updated: false,
    submitted: false,
    submitted_evidence: '',
    ready_to_submit: false,
    resume_uploaded_this_run: false,
  };
}

// ------------------------------------------------------------------- browser
export async function connect(endpoint, log) {
  // The shared browser is persistent and sometimes busy — /json/version has
  // taken 5s under a heavy SPA tab, and a short connect timeout then killed an
  // otherwise healthy run. Give it room and two retries.
  for (let tries = 1; ; tries++) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 60000 });
    } catch (e) {
      if (tries >= 3) throw e;
      log(`CDP connect attempt ${tries} failed, retrying: ${String(e.message || e).split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Reuse the tab already on THIS POSTING — a part-filled form or a signed-in
// session is worth keeping — and only that one.
//
// This used to match on the registrable domain, which meant every Greenhouse
// posting reused whatever Greenhouse tab happened to be open and navigated it
// away. With the drivers submitting immediately that was merely wasteful; now
// that a filled form waits in its tab for approval, it destroyed the previous
// application outright: the Neuralink form filled at 04:47 was gone by 04:52,
// navigated to AEG by the next posting in the same batch. Identity is the
// posting, not the board.
export async function tabFor(ctx, url) {
  const key = (u) => {
    try {
      const { host, pathname } = new URL(u);
      // {board}/jobs/{id}, {site}/{uuid}[/apply], {org}/{uuid}[/application]
      return `${host}${pathname.replace(/\/(apply|application)\/?$/, '').replace(/\/$/, '')}`.toLowerCase();
    } catch { return ''; }
  };
  const want = key(url);
  const found = want && ctx.pages().find((p) => {
    const got = key(p.url());
    return got && (got === want || got.startsWith(`${want}/`) || want.startsWith(`${got}/`));
  });
  return found || ctx.newPage();
}

// An un-dismissed cookie banner is an overlay that swallows clicks and makes
// every later step time out with a misleading error. Always first.
export async function dismissBanner(page) {
  const sels = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    '[data-testid="cookie-accept-all"]',
    '#hs-eu-confirmation-button',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 4000 }).catch(() => el.click({ force: true, timeout: 4000 }));
        await page.waitForTimeout(800);
        return sel;
      }
    } catch { /* not this portal's banner */ }
  }
  return null;
}

export async function clickFirst(page, selectors, { timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    for (const sel of selectors) {
      const all = page.locator(sel);
      const n = Math.min(await all.count().catch(() => 0), 20);
      for (let i = 0; i < n; i++) {
        const el = all.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 10000 }).catch(() => el.click({ force: true, timeout: 10000 }));
        await page.waitForTimeout(1200);
        return sel;
      }
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return null;
}

// Visible validation text is the one honest signal that the form wants
// something this script did not supply.
export async function validationErrors(page) {
  return page.$$eval(
    // CSS-module class names are hashed ("_errorMessage_1x2y3"), so an exact
    // .error token match misses them: Greenhouse rejected a Celonis submit with
    // "Cover Letter is required." sitting in one of those, nothing matched, and
    // the run reported the useless "clicked Submit but never saw a confirmation".
    '.invalid-feedback, .error-message, .error, [class*="error" i], [role="alert"],'
    + ' [aria-invalid="true"] ~ *, .field-error',
    (els) => els
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t && t.length < 300),
  ).then((v) => [...new Set(v)]).catch(() => []);
}

// ---------------------------------------------------------------- filling
// Every filler returns true only after reading the value back off the page.
// "I called type() and it did not throw" is not evidence, and treating it as
// evidence is exactly how a blank form got reported as filled.

export async function fillText(page, locator, value) {
  const el = locator.first();
  if (!(await el.count())) return false;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.fill('').catch(() => {});
  await el.fill(String(value), { timeout: 10000 }).catch(async () => {
    await el.click({ timeout: 5000 }).catch(() => {});
    await el.type(String(value), { delay: 15 }).catch(() => {});
  });
  await page.waitForTimeout(120);
  const got = await el.inputValue().catch(() => '');
  return sameValue(got, value);
}

// A control is allowed to reformat what it was given. intl-tel-input turns
// "5412507975" into "(541) 250-7975", and a strict string compare called that a
// failed fill and blocked the run on a field that was correctly filled. Digits
// are compared as digits; everything else still has to match exactly.
export function sameValue(got, want) {
  if (lc(got) === lc(want)) return true;
  const digits = (s) => String(s).replace(/\D+/g, '');
  const d = digits(want);
  return d.length >= 7 && digits(got) === d;
}

export async function uploadFile(page, input, filePath) {
  const el = input.first();
  if (await el.count()) {
    await el.setInputFiles(filePath, { timeout: 20000 });
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

// Read the options of the menu THIS control just opened, and nothing else.
//
// The naive `[role="option"]` sweep is unusable on a Greenhouse form: the phone
// widget (intl-tel-input) keeps its entire country list — 244 hidden
// role="option" nodes — permanently in the DOM. Scanning globally and capping
// the scan at 60 meant the first 60 matches were all hidden countries, the
// control's own two options were never reached, and every select on the form
// reported "matches none of the form's options []". Four required questions on
// Neuralink and the whole EEOC block on AEG blocked on exactly that.
//
// react-select tells us which listbox belongs to the control: the combobox
// input carries aria-controls. That is the authoritative scope. The broader
// selectors stay as ordered fallbacks for boards that do not set it, and each
// candidate is tried in turn until one yields a VISIBLE option — visibility is
// filtered in the page, before any cap, so a flood of hidden nodes can never
// crowd out the real menu again.
export async function openMenuOptions(page, el, optionSel) {
  const owned = await el.evaluate((n) => n.getAttribute('aria-controls') || n.getAttribute('aria-owns') || '')
    .catch(() => '');
  const esc = (s) => String(s).replace(/([^\w-])/g, '\\$1');
  const candidates = [
    ...(owned ? [`#${esc(owned)} [role="option"]`, `#${esc(owned)} .select__option`] : []),
    ...(optionSel ? String(optionSel).split(',').map((s) => s.trim()) : []),
    '.select__menu [role="option"]',
    '.select__option',
    '[role="listbox"] [role="option"]',
    '[role="option"]',
    'li[id*="option"]',
  ];
  for (const sel of candidates) {
    if (!sel) continue;
    const texts = await page.$$eval(sel, (els) => els
      .map((e, i) => [i, e])
      .filter(([, e]) => e.getBoundingClientRect().width > 0 && e.offsetParent !== null)
      .slice(0, 120)
      .map(([i, e]) => [i, e.textContent.replace(/\s+/g, ' ').trim()])
      .filter(([, t]) => t)).catch(() => []);
    if (texts.length) return { sel, texts };
  }
  return { sel: '[role="option"]', texts: [] };
}

// Make an async typeahead show its list when the planned value cannot.
//
// The probe loop in pickOption types the value we WANT. That works when the
// value is roughly right and fails silently when it is not: Lightning AI's
// "which office hub" control is a typeahead whose real options are "New York"
// and "San Francisco", the planner offered "Yes", every probe for "Yes" loaded
// nothing, and the run blocked with `matches none of the form's options []`.
// An empty list is the least actionable thing a blocked field can report — the
// real options had to be recovered by grepping the questions log by hand.
//
// So: type short generic seeds, union whatever the loader emits, and hand that
// back. This is a READ. It never selects anything and never widens what may be
// chosen — pickOption still requires matchOption to agree before it clicks, so
// discovery can make a block *legible* but can never turn it into a guess.
// What widget is this actually? Both probe loops below open with `fill('')`,
// and fill() THROWS on an element that is not editable — which breaks the loop
// on its first iteration and returns an empty option list. Two shapes reach
// here looking like a combobox and both fail that way:
//
//   - a native <select>, whose options are already sitting in the DOM
//   - a react-select whose #id element is a HIDDEN input, with the visible
//     combobox rendered as a sibling
//
// That is how Lightning AI's office-hub field survived two rounds of fixes and
// reported `options []` every time: nothing ever typed into it, so the async
// loader was never triggered and there was nothing to discover. Resolve the
// shape first, then type into something that can actually receive keystrokes.
export async function describeControl(page, el) {
  return el.evaluate((n) => {
    const vis = (e) => !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const tag = n.tagName.toLowerCase();
    const type = (n.getAttribute('type') || '').toLowerCase();

    if (tag === 'select') {
      return {
        kind: 'native-select',
        options: [...n.options].map((o) => clean(o.textContent)).filter(Boolean),
      };
    }

    // Greenhouse renders a multi-choice question as a <fieldset> of checkboxes
    // (or radios) and puts the QUESTION id on the fieldset. So #id resolves to
    // a fieldset: not typeable, no menu, no options to open. Lightning AI's
    // "which office hubs" is exactly this — five checkboxes (San Francisco,
    // New York City, Seattle, London, Remote only) — and every typing-based
    // probe returned [] because there was never anything to type into.
    const boxes = [...n.querySelectorAll('input[type="checkbox"], input[type="radio"]')].filter(vis);
    if (boxes.length >= 2 || (tag === 'fieldset' && boxes.length)) {
      const labelOf = (b) => {
        const byFor = b.id
          ? n.querySelector(`label[for="${b.id.replace(/"/g, '\\"')}"]`)
            || document.querySelector(`label[for="${b.id.replace(/"/g, '\\"')}"]`)
          : null;
        const l = byFor || b.closest('label') || b.parentElement?.querySelector('label');
        return clean(l?.textContent || b.getAttribute('value') || '');
      };
      return {
        kind: 'choice-group',
        multi: boxes[0].type === 'checkbox',
        options: boxes.map(labelOf),
        ids: boxes.map((b) => b.id || ''),
      };
    }

    if (tag === 'input' && type !== 'hidden' && vis(n)) return { kind: 'input', options: [] };

    // Hidden or opaque: find the visible combobox this control stands in for.
    let scope = n.parentElement;
    for (let i = 0; i < 5 && scope; i++) {
      const box = [...scope.querySelectorAll('input:not([type="hidden"]), [role="combobox"], [contenteditable="true"]')]
        .find(vis);
      if (box) {
        box.setAttribute('data-careerops-probe', '1');
        return { kind: 'proxy', options: [] };
      }
      scope = scope.parentElement;
    }
    return { kind: 'opaque', options: [] };
  }).catch(() => ({ kind: 'unknown', options: [] }));
}

export async function discoverOptions(page, el, optionSel, { seeds, budgetMs = 14000 } = {}) {
  const probes = seeds || ['a', 'e', 'i', 'o', 'n', 's', 'r', 'm'];
  const found = new Set();
  const started = Date.now();
  for (const p of probes) {
    if (Date.now() - started > budgetMs || found.size >= 60) break;
    if (!(await el.fill('').then(() => true).catch(() => false))) break;
    await el.type(p, { delay: 30 }).catch(() => {});
    await page.waitForTimeout(900);
    const { texts } = await openMenuOptions(page, el, optionSel);
    for (const [, t] of texts) found.add(t);
  }
  await el.fill('').catch(() => {});
  return [...found];
}

// A react-select / headless combobox: open it, read the options the page itself
// offers, click the one that matches. The option text always comes from the
// page — this never invents a choice the form does not have.
export async function pickOption(page, control, wanted, { optionSel } = {}) {
  const el = control.first();
  if (!(await el.count())) return null;
  await el.scrollIntoViewIfNeeded().catch(() => {});

  // A native <select> needs no menu, no typing and no discovery: its options
  // are in the DOM already, and selectOption is the reliable way to set it.
  const desc = await describeControl(page, el);
  if (desc.kind === 'native-select') {
    const chosen = matchOption(wanted, desc.options);
    if (chosen === null) return { ok: false, options: desc.options, kind: desc.kind };
    const done = await el.selectOption({ label: chosen })
      .then(() => true).catch(() => false);
    return done
      ? { ok: true, chosen, options: desc.options, kind: desc.kind }
      : { ok: false, options: desc.options, kind: desc.kind };
  }

  // A checkbox/radio group: the options ARE the DOM, so there is nothing to
  // open and nothing to type. Tick the one that matches and read the checked
  // state back — that readback is the proof, not a rendered value string.
  if (desc.kind === 'choice-group') {
    const avail = desc.options.filter(Boolean);
    // A checkbox group accepts several answers, so a value may name more than
    // one. Split on ; or | only — NOT comma, because option labels contain
    // commas of their own ("New York, NY") and splitting on those would turn
    // one real option into two matches of nothing. Radio groups stay single.
    const wants = desc.multi
      ? String(wanted).split(/\s*[;|]\s*/).map((s) => s.trim()).filter(Boolean)
      : [String(wanted)];

    const chosen = [];
    for (const w of wants) {
      const m = matchOption(w, avail);
      if (m !== null && !chosen.includes(m)) chosen.push(m);
    }
    if (!chosen.length) return { ok: false, options: desc.options, kind: desc.kind };

    const ticked = [];
    for (const c of chosen) {
      const id = desc.ids[desc.options.indexOf(c)];
      if (!id) continue;
      // Attribute selector, not #id: Greenhouse ids contain [] which would
      // have to be escaped in a CSS id selector.
      const box = page.locator(`input[id="${id.replace(/"/g, '\\"')}"]`).first();
      if (!(await box.isChecked().catch(() => false))) {
        await box.check({ timeout: 8000 })
          .catch(async () => { await box.click({ force: true, timeout: 8000 }).catch(() => {}); });
        await page.waitForTimeout(200);
      }
      if (await box.isChecked().catch(() => false)) ticked.push(c);
    }
    // Every requested option had to land. A partial tick is a wrong answer to
    // a question about where the candidate can actually work, not a near miss.
    return ticked.length === chosen.length
      ? { ok: true, chosen: ticked.join('; '), options: desc.options, kind: desc.kind }
      : { ok: false, options: desc.options, kind: desc.kind };
  }

  // Everything below types. When #id is hidden, describeControl tagged the
  // visible combobox standing in for it — type into that, not the hidden node.
  const typeEl = desc.kind === 'proxy'
    ? page.locator('[data-careerops-probe="1"]').first()
    : el;

  await el.click({ timeout: 8000 }).catch(() => el.click({ force: true, timeout: 8000 }));
  await page.waitForTimeout(600);

  let { sel, texts } = await openMenuOptions(page, el, optionSel);
  let hit = matchOption(wanted, texts.map(([, t]) => t));

  // Typeahead controls (Greenhouse School / Location / relocation dropdowns)
  // only load options in response to keystrokes — fill() is ignored and a cold
  // click often shows an empty menu. Try progressively shorter probes starting
  // from the full value down to 1 character; short probes (1-3 chars) are what
  // actually trigger the loader on most typeaheads.
  if (hit === null && wanted) {
    const w = String(wanted);
    const firstWord = w.split(/\s+/)[0];
    const probes = [w.slice(0, 40)];
    if (firstWord !== w.slice(0, 40)) probes.push(firstWord);
    for (let len = Math.min(3, firstWord.length - 1); len >= 1; len--) {
      probes.push(firstWord.slice(0, len));
    }
    for (const probe of [...new Set(probes)]) {
      // Real keystrokes: react-select's async option loader ignores fill().
      if (!(await typeEl.fill('').then(() => true).catch(() => false))) break;
      await typeEl.type(probe, { delay: 35 }).catch(() => {});
      await page.waitForTimeout(1200);
      ({ sel, texts } = await openMenuOptions(page, el, optionSel));
      hit = matchOption(wanted, texts.map(([, t]) => t));
      if (hit !== null) break;
    }
  }

  // Still no match and the menu never showed anything: the planned value was
  // wrong FOR THIS CONTROL, so probing with it could not have loaded the list.
  // Enumerate what the control actually offers before giving up.
  if (hit === null && !texts.length) {
    const discovered = await discoverOptions(page, typeEl, optionSel);
    if (discovered.length) {
      const want = matchOption(wanted, discovered);
      if (want !== null) {
        // Type the option's OWN text, which is guaranteed to surface it, then
        // fall through to the normal click path.
        await typeEl.fill('').catch(() => {});
        await typeEl.type(String(want).slice(0, 40), { delay: 30 }).catch(() => {});
        await page.waitForTimeout(1100);
        ({ sel, texts } = await openMenuOptions(page, el, optionSel));
        hit = matchOption(want, texts.map(([, t]) => t));
      } else {
        // No honest match. Report the REAL options so the block is actionable
        // and a human (or profile.json) can supply a value that maps onto one.
        texts = discovered.map((t, i) => [i, t]);
      }
    }
  }

  const opts = page.locator(sel);
  if (hit === null) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, options: texts.map(([, t]) => t) };
  }
  const idx = texts.find(([, t]) => t === hit)[0];
  await opts.nth(idx).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  // Close the menu even on success. A react-select menu left open is a
  // full-width overlay, and it silently swallowed the clicks for every control
  // after it — five EEOC selects came back "matches none of the form's options
  // []" purely because the country menu above them was still open.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return { ok: true, chosen: hit, options: texts.map(([, t]) => t) };
}

// Coerce a planned value onto one of the control's ACTUAL option strings.
// Exact, then prefix, then a single unambiguous substring. Ambiguity is not a
// match — it blocks, because picking one of two plausible self-ID answers is
// exactly the kind of guess this pipeline is not allowed to make.
export function matchOption(value, options) {
  const v = lc(value);
  if (!v) return null;
  const eq = options.find((o) => lc(o) === v);
  if (eq) return eq;
  const pre = options.find((o) => lc(o).startsWith(v) || v.startsWith(lc(o)));
  if (pre) return pre;
  const sub = options.filter((o) => lc(o).includes(v) || v.includes(lc(o)));
  if (sub.length === 1) return sub[0];
  return matchSelfId(value, options);
}

// The EEOC self-ID selects spell their answers out in full ("I am not a
// protected veteran"), while profile.json states the same fact plainly ("not a
// veteran"), and each board words its options differently. Neither equality nor
// substring bridges that, so those questions blocked on every US posting.
//
// Each rule maps a profile-value pattern to a pattern matched against the
// CONTROL'S OWN options: nothing is invented, and a rule that matches two
// options is treated as no match, because picking one of two plausible self-ID
// answers is exactly the guess this pipeline may not make.
const SELF_ID_RULES = [
  [/^(no|not|non)\b|not a (protected )?veteran/i, /not a protected veteran|i am not a/i],
  [/^yes\b.*veteran|identify as one or more/i, /identify as one or more/i],
  [/^(no|not)\b|no disabilit|not disabled/i, /do not have a disability|no, i do not/i],
  [/^yes\b.*disabilit|have (a )?disabilit/i, /yes, i have a disability/i],
  [/decline|prefer not|do ?n[o']?t (wish|want)/i, /decline|do ?n[o']?t (wish|want)|prefer not/i],
];

export function matchSelfId(value, options) {
  for (const [valuePat, optionPat] of SELF_ID_RULES) {
    if (!valuePat.test(norm(value))) continue;
    const hits = options.filter((o) => optionPat.test(o));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// ------------------------------------------------------- required-field audit
// Portal-agnostic: read every visible control inside the form, decide which are
// required, and report the ones still empty. This is what ready_to_submit is
// computed from, rather than trusting the schema to have listed everything —
// on Greenhouse the API omitted four required EEOC selects, and on Ashby it
// returns no fields at all.
export async function auditRequired(page, formSel) {
  // formSel may be a LIST of selectors ("form, [class*=application], main").
  // Naively appending " input" to it produces `a, b, c input`, which scopes the
  // descendant to the last alternative only — on Ashby, which renders no <form>
  // element at all, that silently audited nothing and reported every required
  // field as empty.
  const scoped = (tag) => formSel.split(',').map((s) => `${s.trim()} ${tag}`).join(', ');
  return page.$$eval(`${scoped('input')}, ${scoped('select')}, ${scoped('textarea')}`, (els) => {
    const seen = [];
    for (const el of els) {
      if (el.type === 'hidden' || el.offsetParent === null) continue;
      const name = el.name || el.id || '';
      if (!name) continue;
      const labelEl = el.labels?.[0]
        || el.closest('label')
        || document.querySelector(`label[for="${CSS.escape(el.id || '')}"]`);
      const wrap = el.closest('[class*="field"], [class*="Field"], fieldset, .form-group');
      const labelText = (labelEl?.textContent || wrap?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const required = el.required
        || el.getAttribute('aria-required') === 'true'
        || /\*/.test(labelText.split(/\s{2,}/)[0] || '');
      let value = '';
      if (el.type === 'file') value = el.files?.length ? el.files[0].name : '';
      else if (el.type === 'checkbox' || el.type === 'radio') value = el.checked ? 'on' : '';
      else value = el.value || '';
      // react-select (Greenhouse, Ashby and most modern boards) clears its
      // search input after a pick and shows the answer in a sibling node. Read
      // that, or every combobox reads as empty and the run blocks on fields it
      // actually answered.
      // A MULTI select keeps each choice in its own .select__multi-value chip
      // and never renders a single-value node, so reading only the latter
      // reported an answered control as empty — "How did you hear about us?"
      // was filled with LinkedIn, audited as blank, and re-filled into a menu
      // that had already closed ("control vanished").
      if (!value) {
        const shell = el.closest('.select__container, [class*="select-shell"]');
        const shown = shell?.querySelectorAll(
          '.select__single-value, [class*="singleValue"], .select__multi-value, [class*="multiValue"]',
        );
        if (shown?.length) {
          value = [...shown].map((n) => n.textContent.replace(/\s+/g, ' ').trim())
            .filter(Boolean).join(', ');
        }
      }
      // Ashby's Yes/No pair keeps its answer as an _active_ class on a button
      // and leaves the proxy checkbox permanently unchecked, so without this
      // every answered Yes/No question audits as still empty.
      if (!value) {
        const active = el.closest('[class*="yesno"], [class*="_container_1svni"]')
          ?.querySelector('button[class*="_active"], button[class*="selected"]');
        if (active) value = active.textContent.replace(/\s+/g, ' ').trim();
      }
      seen.push({ name, type: el.type || el.tagName.toLowerCase(), required, value, label: labelText });
    }
    return seen;
  }).catch(() => []);
}

// The form as it stands is the authority, not the story of how it got there.
//
// React rebuilds a control after almost every answer, so a selector that was
// valid when a pass started points at nothing by the time the next pass reaches
// it — reported as "control vanished before it could be filled". On the AEG form
// that produced nine blocks for fields that were sitting there correctly
// answered: "Are you at least 18 years of age or older?" was in `filled` AND in
// `blocked_on` in the same run. A block that the final audit contradicts is
// noise, and noise that reads as a blocker stops a submittable application.
//
// Only attempt-shaped failures are reconciled. A field the audit still shows
// empty keeps its block, and so does anything that was never about a control.
export function reconcileBlocked(state, fields) {
  const answered = fields.filter((f) => norm(f.value))
    .map((f) => lc(f.label || f.name)).filter(Boolean);
  // Field NAME is the reliable key when the block carries one. A checkbox
  // group audits as one row per option, each labelled with the OPTION text
  // ("San Francisco"), never the question — so matching a block whose text is
  // the legend ("...which of our office hubs...") against those labels can
  // never succeed, and Lightning AI kept reporting a block for a field that
  // the question pass had already ticked.
  const answeredNames = new Set(fields.filter((f) => norm(f.value))
    .map((f) => lc(f.name)).filter(Boolean));
  if (!answered.length && !answeredNames.size) return;
  const before = state.blocked_on.length;
  state.blocked_on = state.blocked_on.filter((b) => {
    if (!/control vanished|did not take the answer|question left blank|matches none of the form's options/i.test(b)) return true;

    const nm = (b.match(/\(([^()]+)\)\s*:/) || [])[1];
    if (nm && answeredNames.has(lc(nm))) {
      state.reconciled = (state.reconciled || []).concat(nm.slice(0, 70));
      return false;
    }

    const q = (b.match(/"([^"]+)"/) || [])[1];
    if (!q) return true;
    const key = lc(q).replace(/\*+$/, '').trim();
    if (key.length < 8) return true;                    // too generic to match on
    const probe = key.slice(0, 40);
    const hit = answered.find((l) => l.includes(probe) || key.includes(l.slice(0, 40)));
    if (!hit) return true;
    state.reconciled = (state.reconciled || []).concat(q.slice(0, 70));
    return false;
  });
  if (state.blocked_on.length !== before) {
    state.reconciled_note = `${before - state.blocked_on.length} block(s) dropped: the audit shows those fields answered`;
  }
}

// A radio group is filled when ANY member is checked, so collapse by name
// before deciding what is missing.
export function missingRequired(fields) {
  const byName = new Map();
  for (const f of fields) {
    const cur = byName.get(f.name);
    if (!cur || (!cur.value && f.value)) byName.set(f.name, f);
  }
  return [...byName.values()].filter((f) => f.required && !f.value);
}

// A CAPTCHA is a human check, and the standing rule is to stop and record it
// rather than work around it. It also has to be DETECTED, or it looks like a
// driver bug: Palantir's Lever form renders an hCaptcha iframe directly over
// the Submit button, so the click lands on the iframe, no request is ever made,
// no validation error appears, and the run reports "clicked Submit but never
// saw a confirmation" — true, useless, and indistinguishable from a real defect.
export async function captchaPresent(page) {
  return page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe')]
      .filter((f) => /recaptcha|hcaptcha|turnstile|arkose|funcaptcha/i.test(f.src || ''));
    const visible = frames.filter((f) => f.getBoundingClientRect().width > 0);
    const btn = [...document.querySelectorAll('button, input[type="submit"]')]
      .find((b) => /submit/i.test(b.textContent || b.value || '') && b.offsetParent !== null);
    let covering = false;
    if (btn) {
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      covering = !!at && at !== btn && at.tagName === 'IFRAME';
    }
    if (!visible.length && !covering) return null;
    return { widgets: frames.length, visible: visible.length, coveringSubmit: covering };
  }).catch(() => null);
}

// ------------------------------------------------- email verification step
// Greenhouse (and increasingly the others) can interrupt a submit with "we
// emailed you a code". Before get_code.py existed this was invisible: the
// confirmation poll below just timed out and reported "clicked Submit but
// never saw a confirmation", so a form that was one field from done looked
// like a broken driver. Detect the interstitial, read the code out of Gmail,
// fill it, and let the poll carry on.
async function verificationPrompt(page) {
  return page.evaluate(() => {
    const rx = /verify\s+(your\s+)?email|enter\s+the\s+(\d[- ])?(digit\s+)?code|we\s+(just\s+)?(sent|emailed)\s+(you\s+)?a\s+(\d[- ])?(digit\s+)?code|confirm\s+your\s+email/i;
    const body = document.body ? document.body.innerText.slice(0, 4000) : '';
    if (!rx.test(body)) return null;
    // The input has to be empty and visible, or a page that merely mentions
    // verification in a footer would send the run looking for a code.
    const field = [...document.querySelectorAll('input')].find((i) => {
      if (i.offsetParent === null || i.value) return false;
      if (i.autocomplete === 'one-time-code') return true;
      const hay = `${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') || ''}`;
      return /code|otp|verif|pin/i.test(hay) && !/(promo|coupon|zip|postal|area|country)/i.test(hay);
    });
    if (!field) return null;
    if (!field.id && !field.name) field.setAttribute('data-otp-hook', '1');
    return { sel: field.id ? `#${CSS.escape(field.id)}`
      : field.name ? `input[name="${field.name}"]` : 'input[data-otp-hook="1"]' };
  }).catch(() => null);
}

async function fillVerificationCode(page, { state, log, sel, sender }) {
  let code;
  // Unscoped by default. A guessed --from needle that does not match the real
  // sender fails the posting outright, whereas get_code.py's own default is
  // already narrow: only mail from the last 10 minutes, and only a number the
  // mail explicitly labels as a code. Drivers can still pass `sender` when the
  // board's mail is known.
  const args = [path.join(BASE, 'get_code.py'), '--wait', '180'];
  if (sender) args.push('--from', sender);
  try {
    // --wait: the mail is in flight, and polling here beats failing the whole
    // posting over three seconds of SMTP.
    code = execFileSync('python3', args,
      { cwd: BASE, encoding: 'utf8', timeout: 220000 }).trim();
  } catch {
    state.blocked_on.push(
      'the form asked for an emailed verification code and get_code.py found none'
      + (sender ? ` for "${sender}"` : '')
      + ' — the mail has not arrived or is not labelled as a code;'
      + ' finish this one by hand in the open tab',
    );
    return false;
  }
  // Alphanumeric, not digits: Greenhouse mails things like "QD0A6WzG" and
  // "KzPobdun". A \d-only guard here would reject every real Greenhouse code.
  if (!/^[A-Za-z0-9]{4,10}$/.test(code)) {
    state.blocked_on.push('get_code.py returned something that is not a verification code');
    return false;
  }
  // The code itself is never logged: same no-echo rule as every other secret.
  log(`filled the emailed verification code (${code.length} chars)`);
  await page.fill(sel, code).catch(() => {});
  const ok = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && el.value.length > 0;
  }, sel).catch(() => false);
  if (!ok) { state.blocked_on.push('could not type the verification code into the field'); return false; }
  state.verified.push('email-verification-code');
  await clickFirst(page, [
    'button:has-text("Verify")', 'button:has-text("Confirm")', 'button:has-text("Continue")',
    'button:has-text("Submit")', 'button[type="submit"]',
  ], { timeout: 8000 });
  return true;
}

// ------------------------------------------------------------------- submit
export async function submitAndVerify(page, { selectors, successRe, state, log, timeout = 90000, sender = '' }) {
  const before = page.url();

  // hCaptcha's INVISIBLE widget paints a transparent full-viewport iframe over
  // the page while it scores the session, then hides it again. A click during
  // that window lands on the iframe instead of the button: no request is made,
  // no validation error appears, and the run reports "never saw a confirmation"
  // for a form that was perfectly submittable. That is what happened to the
  // Palantir application. Wait for the control to actually be the thing at its
  // own coordinates before clicking it.
  for (let i = 0; i < 15; i++) {
    const clear = await page.evaluate((sels) => {
      const btn = sels.map((s) => document.querySelector(s)).find((b) => b && b.offsetParent !== null)
        || [...document.querySelectorAll('button, input[type="submit"]')]
          .find((b) => /submit/i.test(b.textContent || b.value || '') && b.offsetParent !== null);
      if (!btn) return true;                       // clickFirst will report it missing
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !at || at === btn || btn.contains(at) || at.contains(btn);
    }, selectors.filter((s) => !s.includes(':has-text'))).catch(() => true);
    if (clear) break;
    if (i === 0) log('an overlay is sitting on the Submit control; waiting for it to clear');
    await page.waitForTimeout(2000).catch(() => {});
  }

  const hit = await clickFirst(page, selectors, { timeout: 10000 });
  if (!hit) {
    state.blocked_on.push('no Submit control found on the application form');
    return;
  }

  // Polled from node, NOT with page.waitForFunction. The confirmation almost
  // always arrives as a navigation, and a navigation destroys the execution
  // context waitForFunction is evaluating in — it rejects with "Execution
  // context was destroyed" and the run is recorded blocked. That is what
  // happened to the Lever AHEAD application on 2026-08-10: it was sitting on
  // /thanks, genuinely submitted, and the driver called it a failure, so
  // mark_applied never ran. Reporting a successful submit as a failure is the
  // worst way to be wrong here, because the next run applies again.
  const re = new RegExp(successRe, 'i');
  let deadline = Date.now() + timeout;
  let evidence = '';
  let codeTried = false;                 // once only: a retry loop here would
  while (Date.now() < deadline) {        // re-request codes until Gmail throttles
    await page.waitForTimeout(1000).catch(() => {});
    let url = '';
    try { url = page.url(); } catch { continue; }        // mid-navigation
    if (re.test(url)) { evidence = `URL ${url}`; break; }
    const body = await page.evaluate(
      () => (document.body ? document.body.innerText.slice(0, 4000) : ''),
    ).catch(() => '');                                    // context torn down: try again
    if (body && re.test(body)) { evidence = `confirmation text at ${url}`; break; }

    // Not a confirmation and not an error — check whether the board is asking
    // for an emailed code before writing the attempt off.
    if (!codeTried) {
      const prompt = await verificationPrompt(page);
      if (prompt) {
        codeTried = true;
        log('the board is asking for an emailed verification code');
        const filled = await fillVerificationCode(page, { state, log, sel: prompt.sel, sender });
        if (!filled) return;
        deadline = Date.now() + timeout;   // the clock restarts: the submit did
      }                                    // not really begin until now
    }
  }

  if (!evidence) {
    // The board renders its complaint a beat AFTER rejecting the submit, so
    // reading immediately returns nothing and the run reports the useless
    // "never saw a confirmation" with no reason attached. AEG's real answer —
    // "End date must be after start date." — was sitting on the page a second
    // later. Give it that second.
    await page.waitForTimeout(2000).catch(() => {});
    const cap = await captchaPresent(page);
    if (cap) state.captcha = cap;
    // Only a widget sitting ON the Submit control actually stops a submit —
    // that is Lever's hCaptcha, which reliably reports coveringSubmit. Ashby
    // renders a Cloudflare Turnstile that verifies without any interaction and
    // never covers the button, and blaming it turned "the confirmation text did
    // not match" into "solve the CAPTCHA", which sent the candidate to a
    // challenge that was not there (2026-08-11). A non-covering widget is
    // recorded and the real reason is reported below.
    if (cap?.coveringSubmit) {
      state.blocked_on.push(
        'a CAPTCHA is on this form and is sitting directly over the Submit button'
        + ' — solve it in the open tab, then re-run ats_submit.mjs (or use --wait-for-captcha)',
      );
      return;
    }
    const errs = await validationErrors(page);
    const url = (() => { try { return page.url(); } catch { return '(tab gone)'; } })();
    // A URL that moved off the form is weak evidence of a submit, and it is
    // recorded so a human can check rather than a second run re-applying blind.
    state.left_the_form = url !== before;
    state.blocked_on.push(
      `clicked Submit but never saw a confirmation${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`
      + ` (now at ${url}, was ${before})`
      + (url !== before ? ' — the page DID navigate; check by hand before re-running this slug' : ''),
    );
    return;
  }
  state.submitted = true;
  state.submitted_evidence = `${evidence}, title '${await page.title().catch(() => '')}'`;
  log('submitted:', state.submitted_evidence);
}

// --------------------------------------------------------------- bookkeeping
export function writeStatus(statusPath, state) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(state, null, 2)}\n`);
}

// cache/{ats}.json records what a run DISCOVERED. These drivers discover
// nothing new by design, so they only append a run record — never rewrite the
// file, which is how a seeded auth block got destroyed once.
export function appendCacheRun(cachePath, state, extra = {}) {
  try {
    const cache = fileHasBytes(cachePath)
      ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
    cache.runs = cache.runs || [];
    cache.runs.push({
      date: TODAY,
      slug: state.slug,
      url: state.url,
      driver: state.driver,
      result: state.submitted ? 'submitted'
        : state.blocked_on.length ? 'blocked' : 'filled_not_submitted',
      note: [state.filled.join('; '), state.blocked_on.join('; ')]
        .filter(Boolean).join(' || ').slice(0, 600),
      ...extra,
    });
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    state.cache_updated = true;
  } catch (e) {
    console.error('cache append skipped:', String(e.message || e));
  }
}

export function markApplied(url) {
  try {
    execFileSync('python3', [path.join(BASE, 'mark_applied.py'), url], { cwd: ROOT, stdio: 'inherit' });
  } catch { console.error('mark_applied.py did not match a pipeline.csv row'); }
}

// A tab a human still has to finish stays open — closing it throws away the
// session they are about to pick up.
export async function closeOrKeepTab(url, state, keepTab, log) {
  if (keepTab || state.blocked_on.length || state.left_for_human.length) {
    log(`leaving the tab open — ${state.blocked_on[0] || state.left_for_human[0] || 'requested'}`);
    return;
  }
  try {
    execFileSync(path.join(BASE, 'close_tabs.sh'), [url], { cwd: BASE, stdio: 'ignore' });
  } catch { /* cleanup never fails a run that already succeeded */ }
}

// ---------------------------------------------------- extra document uploads
// A form may require a file that is not the resume: DRW asks for "a copy of
// your most recent transcript from your highest degree level", Celonis for a
// cover letter. The question pass never sees these — scrapeQuestions skips file
// inputs entirely — so before this existed the run filled everything else,
// called the form complete, clicked Submit and got back "This field is
// required." from the employer's server with nothing to explain it.
//
// profile.json.documents maps a kind to a path. Only files the candidate has
// actually provided are ever attached, and a required input with no matching
// document blocks the run rather than being left silently empty.
const DOC_KINDS = [
  ['transcript', /transcript|academic record|mark ?sheet/i],
  ['cover_letter', /cover letter|motivation letter/i],
  ['portfolio', /portfolio|work sample|writing sample/i],
];

export async function attachDocuments(page, formSel, profile, state, log, schema = [], slug = '') {
  const docs = profile.documents || {};
  // The DOM label of a file input is usually just "Attach" — the question it
  // belongs to is in the schema the ATS already published. DRW's transcript
  // input is id=question_67897448, and only the schema knows that means
  // "Please provide a copy of your most recent transcript...".
  const schemaLabel = new Map((Array.isArray(schema) ? schema : [])
    .map((f) => [String(f.key || ''), String(f.label || '')]).filter(([k]) => k));
  // formSel may be a LIST ("form, [class*=application], main"). Appending the
  // descendant naively produces `a, b, c input[type=file]`, which scopes it to
  // the LAST alternative and selects the bare `form` and every
  // [class*=application] wrapper as if each were a file input — the same trap
  // auditRequired() documents. On Ashby that reported "this form requires a
  // file for Name/Email/Phone" and blocked a posting whose only real file input
  // (the resume) was already attached.
  const scopedFiles = formSel.split(',')
    .map((sel) => `${sel.trim()} input[type="file"]`).join(', ');
  const inputs = page.locator(scopedFiles);
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i);
    const meta = await el.evaluate((node) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const byFor = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
      const box = node.closest('.question, [class*="field"], .form-group, fieldset, div');
      return {
        id: node.id || '', name: node.name || '',
        label: clean(byFor?.textContent) || clean(box?.innerText).slice(0, 160),
        required: !!(node.required || node.getAttribute('aria-required') === 'true'),
        has: !!(node.files && node.files.length),
      };
    }).catch(() => null);
    if (!meta) continue;

    const hay = `${meta.id} ${meta.name} ${meta.label} ${schemaLabel.get(meta.id) || ''}`;
    if (/resume|\bcv\b/i.test(hay)) continue;              // the resume has its own path
    const kind = DOC_KINDS.find(([, re]) => re.test(hay))?.[0];
    // A cover letter written for one employer must never be attached to
    // another's form, so a per-posting file wins over the generic one:
    //   documents/{slug}.{kind}.pdf   beats   profile.json documents.{kind}
    const perSlug = kind && slug
      ? path.join(BASE, 'documents', `${slug}.${kind}.pdf`) : '';
    const wanted = (perSlug && fileHasBytes(perSlug)) ? perSlug : (kind && docs[kind]);

    if (!wanted) {
      if (meta.required && !meta.has) {
        state.blocked_on.push(
          `this form requires a file for "${(schemaLabel.get(meta.id) || meta.label || meta.name || meta.id).slice(0, 70)}" `
          + `and profile.json has no ${kind || 'matching'} document — add one under "documents"`,
        );
      }
      continue;
    }
    if (!fileHasBytes(wanted)) {
      state.blocked_on.push(`profile.json documents.${kind} points at a missing file: ${wanted}`);
      continue;
    }
    if (await uploadFile(page, el, wanted)) {
      await page.waitForTimeout(1500);
      const landed = await el.evaluate((node) => (node.files?.[0]?.name
        || (node.value || '').split(/[\\/]/).pop() || '')).catch(() => '');
      const shown = landed || (await page.locator(formSel).innerText()
        .then((t) => (t.includes(wanted.split('/').pop()) ? wanted.split('/').pop() : ''))
        .catch(() => ''));
      if (shown) {
        state.filled.push(`${kind}=${shown}`);
        state.verified.push(`document:${kind}`);
        log(`attached ${kind}: ${shown}`);
      } else {
        state.blocked_on.push(`the ${kind} input accepted the file but the page never showed it`);
      }
    }
  }
}
