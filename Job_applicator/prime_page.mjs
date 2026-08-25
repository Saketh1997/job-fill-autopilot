#!/usr/bin/env node
// prime_page.mjs — put the browser on the posting with the consent banner gone,
// deterministically, BEFORE the model is invoked.
//
//   node prime_page.mjs <url> [--endpoint http://localhost:9226]
//
// Why this exists: dismissing a cookie banner cost the T. Rowe Price run four
// turns (click, snapshot, click again, re-navigate) and roughly 15k tokens of
// accessibility tree, every run, on every portal. It is the same handful of
// selectors every time, so it does not need a model.
//
// It also leaves the model with a page whose state is already known, which is
// what lets the prompt forbid an opening snapshot.
//
// Prints one JSON line: {ok, url, title, banner, reused_tab}.
// Exit 0 even when the banner is not found — absence is the normal case on a
// second visit, not a failure. Exit 1 only if the page could not be reached.

import { chromium } from 'playwright';

const args = process.argv.slice(2);
let url = '';
let endpoint = process.env.CDP_ENDPOINT || 'http://localhost:9226';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--endpoint') endpoint = args[++i];
  else if (!args[i].startsWith('-') && !url) url = args[i];
}
if (!url) {
  console.log(JSON.stringify({ ok: false, error: 'usage: prime_page.mjs <url> [--endpoint URL]' }));
  process.exit(1);
}

// Ordered most specific first. OneTrust and TrustArc cover the large majority of
// enterprise career portals; the Workday-native notice and the text matches are
// the tail.
const BANNERS = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  'button[data-automation-id="legalNoticeAcceptButton"]',
  'button[data-testid="cookie-accept-all"]',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept Cookies")',
  'button:has-text("Accept All")',
  'button:has-text("I Accept")',
  'button:has-text("Agree")',
];

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context over CDP');

  // Reuse a tab already on this portal rather than leaking another one — the
  // persistent browser is shared, and close_tabs.sh cleans by host.
  //
  // Match on the registrable domain, NOT the exact host. Portals move you to a
  // different subdomain the moment you sign in — amazon.jobs sends you from
  // www.amazon.jobs to account.amazon.jobs — and that is precisely when there is
  // work in progress worth protecting. Exact-host matching found no tab, so
  // `reused` stayed false, the in-flow guard below (which only runs when a tab
  // was reused) never fired, and a part-filled wizard was navigated away from on
  // 2026-08-09.
  const regDomain = (h) => h.split('.').slice(-2).join('.');
  const domain = regDomain(new URL(url).host);
  let page = ctx.pages().find((p) => {
    try { return regDomain(new URL(p.url()).host) === domain; } catch { return false; }
  });
  const reused = Boolean(page);
  if (!page) page = await ctx.newPage();

  // Never navigate away from work in progress. A tab already on this host but
  // PAST the posting URL is a signed-in wizard, a login screen or a part-filled
  // draft — goto() would throw all of it away and, on Workday, land back at a
  // posting whose Apply button now says "Use My Last Application". Reload only
  // when the tab is sitting on the posting itself (or nothing was open).
  const here = page.url();
  const samePath = (a, b) => {
    try { const x = new URL(a), y = new URL(b); return x.host === y.host && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, ''); }
    catch { return false; }
  };
  const inFlow = reused && !samePath(here, url) && /\/(apply|login|signin|task|candidate|account)/i.test(here);
  if (inFlow) {
    // leave it exactly where it is
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  let banner = 'none-found';
  for (const sel of BANNERS) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 5000 }).catch(() => el.click({ force: true, timeout: 5000 }));
        banner = sel;
        break;
      }
    } catch { /* selector absent on this portal, try the next */ }
  }

  // Let the overlay finish tearing down; a half-removed banner still eats clicks.
  if (banner !== 'none-found') await page.waitForTimeout(1200);

  const out = { ok: true, url: page.url(), title: (await page.title()).slice(0, 120), banner, reused_tab: reused, navigated: !inFlow, resumed_in_flow: inFlow };
  console.log(JSON.stringify(out));
  await browser.close();          // detaches CDP; does NOT close the tab
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message || err).slice(0, 300) }));
  try { await browser?.close(); } catch { /* already gone */ }
  process.exit(1);
}
