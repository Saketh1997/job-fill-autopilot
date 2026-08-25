#!/usr/bin/env node
// resolve_apply.mjs — get the external ATS URL off a LinkedIn job page.
//
// LinkedIn's current job view renders "Apply on company website" as an anchor
// whose href is a /safety/go/ redirector carrying the destination in its `url`
// query parameter. So this reads an attribute. It never clicks, never opens a
// popup, and never touches the employer's server.
//
// Class names on that page are obfuscated build hashes and change per deploy.
// aria-label and href shape are the stable parts, so those are what we match.
//
//   node resolve_apply.mjs <linkedin-job-url>
//   DUMP=1 node resolve_apply.mjs <url>      diagnostics, no resolution
//
// Env: CDP_ENDPOINT (attach to the shared logged-in browser)
//      LI_STATE     (fallback storage state, only when CDP_ENDPOINT is unset)
//      LI_NAV_TIMEOUT (ms, default 30000)
//
// Prints one JSON object. type is one of:
//   offsite | easy_apply | already_applied | closed | not_authenticated | unresolved
// Exit: 0 offsite   3 other terminal state   4 auth problem   5 bad usage

import { chromium } from 'playwright';

const STATE = process.env.LI_STATE || `${process.env.HOME}/.config/career-ops/li-state.json`;
const CDP = process.env.CDP_ENDPOINT || '';
const NAV_TIMEOUT = Number(process.env.LI_NAV_TIMEOUT || 30000);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const arg = process.argv[2];
if (!arg || !/^https?:\/\//.test(arg)) {
  console.error('usage: resolve_apply.mjs <linkedin-job-url>');
  process.exit(5);
}

const jobId = (arg.match(/[?&]currentJobId=(\d+)/) || [])[1]
  || (arg.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/) || [])[1]
  || null;

const report = (apply_url, type) =>
  console.log(JSON.stringify({ input: arg, apply_url: apply_url || null, type, job_id: jobId }));

// /safety/go/?url=<encoded>. searchParams.get already decodes once, so do NOT
// decodeURIComponent on top of it: a target containing a literal %20 would break.
const unwrap = (href) => {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    if (/(^|\.)linkedin\.com$/.test(u.hostname)) {
      return u.searchParams.get('url') || null;
    }
    return u.href;                       // already external
  } catch { return null; }
};

const isExternal = (u) => {
  try { return !/(^|\.)linkedin\.com$/.test(new URL(u).hostname); } catch { return false; }
};

let browser, page, owned = false;

const teardown = async () => {
  await page?.close().catch(() => {});
  if (owned) await browser?.close().catch(() => {});
};

const done = async (url, type, code) => {
  await teardown();
  report(url, type);
  process.exit(code);
};

try {
  if (CDP) {
    browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0] || await browser.newContext({ userAgent: UA });
    page = await ctx.newPage();
  } else {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ storageState: STATE, userAgent: UA });
    page = await ctx.newPage();
    owned = true;
  }
  page.setDefaultTimeout(NAV_TIMEOUT);

  await page.route('**/*', (r) => {
    const t = r.request().resourceType();
    return (t === 'image' || t === 'font' || t === 'media') ? r.abort() : r.continue();
  });

  await page.goto(arg, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Collect every candidate in one pass. Cheaper than a chain of locators, and
  // it gives the diagnostic dump something useful to print when nothing matches.
  const found = await page.evaluate(() => {
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      aria: el.getAttribute('aria-label') || null,
      text: (el.innerText || '').trim().slice(0, 80) || null,
      href: el.getAttribute('href') || null,
      visible: !!(el.offsetParent || el.getBoundingClientRect().width),
    });

    const anchors = [...document.querySelectorAll('a[href]')]
      .filter((a) => /apply/i.test(a.getAttribute('aria-label') || '')
                  || /\/safety\/go\/\?/.test(a.getAttribute('href') || '')
                  || /^apply\b/i.test((a.innerText || '').trim()))
      .map(describe);

    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter((b) => /apply/i.test(b.getAttribute('aria-label') || '')
                  || /^(easy\s+)?apply\b/i.test((b.innerText || '').trim()))
      .map(describe);

    return {
      title: document.title,
      anchors,
      buttons,
      head: (document.body.innerText || '').slice(0, 4000),
      guest: !!document.querySelector('.sign-up-modal__outlet, .contextual-sign-in-modal'),
    };
  });

  if (process.env.DUMP === '1') {
    console.error(JSON.stringify(found, null, 2));
    await done(null, 'unresolved', 0);
  }

  if (found.guest || /authwall|uas\/login|checkpoint/.test(page.url())) {
    await done(null, 'not_authenticated', 4);
  }

  // A posting can offer BOTH Easy Apply and an offsite apply. When it does,
  // Easy Apply wins: it stays inside the flow the approval gate controls, and
  // the offsite anchor is present but secondary. So check the button FIRST,
  // before accepting any externalApply href.
  const easyApply = found.buttons.some((b) =>
    /easy\s*apply/i.test(`${b.aria || ''} ${b.text || ''}`));
  if (easyApply) {
    // A posting can carry a stale externalApply pointer to a job the company
    // already removed from its ATS. Verify the offsite target resolves before
    // offering it: a 404/410 there means Easy Apply is the only live path.
    const rawAlt = found.anchors.map((a) => unwrap(a.href)).find((u) => u && isExternal(u)) || null;
    let alt = null, alt_status = null;
    if (rawAlt) {
      try {
        const r = await fetch(rawAlt, { method: 'HEAD', redirect: 'follow' });
        alt_status = r.status;
        if (r.status < 400) alt = rawAlt;         // live
      } catch (e) { alt_status = `error:${e.message.slice(0, 40)}`; }
    }
    await teardown();
    console.log(JSON.stringify({ input: arg, apply_url: null, type: 'easy_apply',
      offsite_alt: alt, offsite_alt_dead: rawAlt && !alt ? rawAlt : null,
      offsite_alt_status: alt_status, job_id: jobId }));
    process.exit(3);
  }

  // 1. Offsite. The href already carries the answer.
  //    Prefer visible anchors: the sticky header renders a hidden duplicate.
  const ordered = [...found.anchors].sort((a, b) => Number(b.visible) - Number(a.visible));
  for (const a of ordered) {
    const target = unwrap(a.href);
    if (!target || !isExternal(target)) continue;
    // Verify before returning. A dead offsite target is not an apply URL.
    try {
      const r = await fetch(target, { method: 'HEAD', redirect: 'follow' });
      if (r.status >= 400) {
        await teardown();
        console.log(JSON.stringify({ input: arg, apply_url: null, type: 'offsite_dead',
          dead_url: target, status: r.status, job_id: jobId }));
        process.exit(3);
      }
    } catch { /* network hiccup: fall through and return it rather than false-negative */ }
    await done(target, 'offsite', 0);
  }

  // 2. No control at all is usually a state, not a fault. Classify only here,
  //    since this text would false-positive on a page that has a live button.
  if (/no longer accepting applications|this job is no longer/i.test(found.head)) {
    await done(null, 'closed', 3);
  }
  if (/\bapplied\b|application submitted/i.test(found.head)) {
    await done(null, 'already_applied', 3);
  }

  // 4. Genuinely unexpected. Print what was on the page so the next fix is a
  //    one-line change rather than another round of guessing.
  console.error(JSON.stringify({ no_apply_control: true, title: found.title,
    anchors: found.anchors, buttons: found.buttons }, null, 2));
  await done(null, 'unresolved', 3);
} catch (err) {
  console.error(String(err?.message || err));
  await teardown();
  report(null, 'unresolved');
  process.exit(3);
}
