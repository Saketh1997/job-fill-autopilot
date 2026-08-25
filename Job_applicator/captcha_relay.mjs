#!/usr/bin/env node
// captcha_relay.mjs — put a human's eyes on a CAPTCHA without putting their
// hands on the keyboard.
//
//   node captcha_relay.mjs <slug> shot              trigger + screenshot the challenge
//   node captcha_relay.mjs <slug> click C4 [B2 ...] click those grid cells
//   node captcha_relay.mjs <slug> verify            press the challenge's Verify/Skip
//   node captcha_relay.mjs <slug> submit            finish the application
//
// WHAT THIS IS NOT: it does not solve, read, or answer the challenge. No model
// ever sees the image. The person looking at the screenshot does the entire
// verification — identifying the target is theirs, and it is the only part that
// the challenge is actually testing. This moves the mouse for them, which is
// the same thing their trackpad does.
//
// The screenshot is annotated with a labelled grid (A1 top-left, columns A-H
// left to right, rows 1-8 top to bottom) drawn over the challenge area, so an
// answer is a cell name rather than a pixel coordinate.
//
// Exit: 0 fine · 1 no tab / no challenge · 2 the challenge went away or expired.

import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BASE, connect } from './ats_apply_common.mjs';

const [slug, cmd, ...rest] = process.argv.slice(2);
if (!slug || !cmd) {
  console.error('usage: captcha_relay.mjs <slug> shot|click <cells...>|verify|submit');
  process.exit(1);
}
const ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9226';
const SHOT = path.join(BASE, 'shots', `${slug}-challenge.png`);
const COLS = 'ABCDEFGHIJ';
const ROWS = 10;
const log = (...m) => console.error('CAPTCHA:', ...m);

const status = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(BASE, 'answers', `${slug}.drive.json`), 'utf8')); }
  catch { return null; }
})();
if (!status) { log(`no answers/${slug}.drive.json — fill the form first`); process.exit(1); }

const browser = await connect(ENDPOINT, log);
const ctx = browser.contexts()[0];
const want = (status.apply_url || status.url).split('?')[0].replace(/\/(apply|application)\/?$/, '');
const page = ctx.pages().find((p) => { try { return p.url().startsWith(want); } catch { return false; } });
if (!page) { log(`no open tab on ${want} — re-run the filler`); await browser.close(); process.exit(1); }

// The challenge lives in a cross-origin hCaptcha frame. Playwright drives the
// browser rather than the page, so it can read that frame's geometry directly.
// Enumerate CAPTCHA iframes from the DOM, not from page.frames().
//
// hCaptcha's frames come back from Playwright with an EMPTY url(), so every
// `/hcaptcha/.test(frame.url())` filter matches nothing and the challenge looks
// absent while it is plainly on screen. The <iframe> elements in the top
// document do carry the src, so that is what identifies them; contentFrame()
// then gets the Frame handle regardless of what url() reports.
async function captchaFrames() {
  const out = [];
  for (const h of await page.$$('iframe')) {
    const src = (await h.getAttribute('src').catch(() => '')) || '';
    if (!/hcaptcha|recaptcha|turnstile|arkose/i.test(src)) continue;
    const visible = await h.evaluate((n) => {
      const s = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none'
        && s.opacity !== '0' && r.width > 100 && r.height > 100;
    }).catch(() => false);
    out.push({ handle: h, src, visible, box: await h.boundingBox().catch(() => null),
      frame: await h.contentFrame().catch(() => null) });
  }
  return out;
}

async function challengeBox() {
  // The visible hCaptcha iframe is stretched over the whole viewport, so its
  // rect is useless as a grid. The card holding the puzzle lives inside it and
  // its geometry is only readable from within the frame; if that read fails,
  // fall back to the iframe rect so the operator still gets a usable picture.
  for (const c of await captchaFrames()) {
    if (!c.visible || !c.box) continue;
    const inner = c.frame ? await c.frame.evaluate(() => {
      const pick = document.querySelector(
        '.challenge-view, .challenge-container, .task-image, .challenge, .interface-challenge',
      );
      if (!pick) return null;
      const r = pick.getBoundingClientRect();
      return r.width > 120 && r.height > 120
        ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    }).catch(() => null) : null;

    if (inner) {
      return { x: c.box.x + inner.x, y: c.box.y + inner.y, w: inner.w, h: inner.h, source: 'challenge-card' };
    }
    // The outer hCaptcha iframes are empty containers stretched over the whole
    // viewport — the challenge itself renders in a nested frame that Playwright
    // cannot read. A grid over the full 1904x992 viewport puts the entire puzzle
    // inside two or three cells, which is useless for a "click the spot"
    // challenge. hCaptcha centres its card, so crop to the middle band: the card
    // observed here (520x570) sits well inside it, and the grid is drawn over
    // exactly this rect so a cell name means the same thing in both directions.
    return {
      x: c.box.x + c.box.width * 0.30,
      y: c.box.y + c.box.height * 0.12,
      w: c.box.width * 0.40,
      h: c.box.height * 0.76,
      source: 'centred-crop',
    };
  }
  return null;
}

// The challenge's own instruction line ("Click on where the item shown can be
// safely placed"). Sent alongside the picture so the operator knows what they
// are being asked before they open the image.
async function challengePrompt() {
  for (const c of await captchaFrames()) {
    if (!c.frame) continue;
    const t = await c.frame.evaluate(() => {
      const el = document.querySelector('.prompt-text, .challenge-prompt, h2, .rc-imageselect-desc-wrapper');
      return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    }).catch(() => '');
    if (t) return t;
  }
  return '';
}

async function ensureChallenge(trigger) {
  let box = await challengeBox();
  if (box) return box;
  if (!trigger) return null;
  log('no challenge on screen; clicking Submit to raise it');
  // scrollIntoViewIfNeeded first. Without it the click throws "element is
  // outside of the viewport", the .catch() swallows it, and the run reports
  // "no challenge appeared" for a button that was never actually pressed.
  const submit = page.locator('button:has-text("Submit application")').first();
  const btn = (await submit.count()) ? submit : page.locator('button[type="submit"]').first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 10000 })
    .catch((e) => log(`submit click failed: ${String(e.message).split('\n')[0]}`));
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(700);
    box = await challengeBox();
    if (box) return box;
    if (/thanks|confirm/i.test(page.url())) return null;   // it just submitted
  }
  return null;
}

async function run() {
  if (cmd === 'shot') {
    const box = await ensureChallenge(true);
    if (!box) {
      if (/thanks|confirm/i.test(page.url())) { log(`no challenge — the page is at ${page.url()}`); return 0; }
      log('no challenge appeared'); return 2;
    }
    // Grid drawn in the TOP document, over the frame. Removed before any click,
    // so it can never intercept the interaction it is describing.
    await page.evaluate(({ b, cols, rows }) => {
      document.getElementById('__atsq_grid')?.remove();
      const wrap = document.createElement('div');
      wrap.id = '__atsq_grid';
      wrap.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;`
        + `height:${b.h}px;z-index:2147483647;pointer-events:none;`;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols.length; c++) {
          const cell = document.createElement('div');
          cell.style.cssText = `position:absolute;left:${(c / cols.length) * 100}%;`
            + `top:${(r / rows) * 100}%;width:${100 / cols.length}%;height:${100 / rows}%;`
            + 'border:1px solid rgba(255,0,0,.55);font:11px/1 monospace;color:#fff;'
            + 'text-shadow:0 0 3px #000,0 0 3px #000;padding:1px;box-sizing:border-box;';
          cell.textContent = `${cols[c]}${r + 1}`;
          wrap.appendChild(cell);
        }
      }
      document.body.appendChild(wrap);
    }, { b: { x: box.x, y: box.y, w: box.w, h: box.h }, cols: COLS, rows: ROWS });

    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    // Crop to the challenge itself: a full-page screenshot of a 1900px form
    // arrives on a phone as an unreadable strip.
    await page.screenshot({
      path: SHOT,
      clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.w + 24, height: box.h + 24 },
    }).catch(() => page.screenshot({ path: SHOT }));
    await page.evaluate(() => document.getElementById('__atsq_grid')?.remove());
    fs.writeFileSync(`${SHOT}.box.json`, JSON.stringify({
      ...box, hash: crypto.createHash('md5').update(fs.readFileSync(SHOT)).digest('hex'),
      taken_at: Date.now(),
    }, null, 2));

    // One JSON line on stdout: this is the n8n contract. The Discord node posts
    // `screenshot`, the reply comes back as cells, and `click` takes them.
    console.log(JSON.stringify({
      slug,
      screenshot: SHOT,
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) },
      source: box.source,
      grid: { cols: COLS.split(''), rows: ROWS, label: `A1 (top-left) .. ${COLS[COLS.length - 1]}${ROWS} (bottom-right)` },
      prompt: await challengePrompt(),
      reply_with: `node captcha_relay.mjs ${slug} click <cells>`,
      note: 'hCaptcha challenges expire in roughly two minutes; a stale reply needs a fresh shot',
    }));
    return 0;
  }

  if (cmd === 'click') {
    const box = JSON.parse(fs.readFileSync(`${SHOT}.box.json`, 'utf8'));
    if (!rest.length) { log('give at least one cell, e.g. C4'); return 1; }

    // STALENESS GUARD. A Discord round-trip takes longer than an hCaptcha
    // challenge lives. If the puzzle rotated while the operator was answering,
    // their cells describe an image that is no longer on screen, and clicking
    // them would be clicking at random on a DIFFERENT challenge. Compare the
    // area against the picture that was actually sent, and refuse if it moved.
    const clip = { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12),
      width: box.w + 24, height: box.h + 24 };
    const fresh = path.join(BASE, 'shots', `${slug}-verify.png`);
    const now = await page.screenshot({ clip, path: fresh }).catch(() => null);
    // Coarse comparison, not an exact hash: hCaptcha animates its progress dots
    // and the page repaints behind the transparent overlay, so byte equality
    // refused every click on a puzzle that had not actually changed.
    let score = 100;
    if (now) {
      try {
        score = Number(execFileSync('python3',
          [path.join(BASE, 'compare_images.py'), SHOT, fresh], { encoding: 'utf8' }).trim());
      } catch { score = 100; }
    }
    const same = Number.isFinite(score) && score < 8;
    if (!same) {
      log(`the challenge differs from the screenshot by ${score}% (threshold 8%)`);
      log('the challenge on screen is not the one in the screenshot (it rotated or closed).');
      log(`take a fresh shot:  node captcha_relay.mjs ${slug} shot`);
      return 2;
    }
    log(`challenge matches the screenshot (${score}% different, ${Math.round((Date.now() - box.taken_at) / 1000)}s old)`);
    for (const cell of rest) {
      const m = /^([A-Ha-h])(\d)$/.exec(cell.trim());
      if (!m) { log(`skipping ${cell}: not a grid cell`); continue; }
      const c = COLS.indexOf(m[1].toUpperCase());
      const r = Number(m[2]) - 1;
      const x = box.x + ((c + 0.5) / COLS.length) * box.w;
      const y = box.y + ((r + 0.5) / ROWS) * box.h;
      await page.mouse.click(x, y);
      log(`clicked ${cell.toUpperCase()} at ${Math.round(x)},${Math.round(y)}`);
      await page.waitForTimeout(500);
    }
    return 0;
  }

  if (cmd === 'verify') {
    for (const c of await captchaFrames()) {
      if (!c.frame) continue;
      const btn = c.frame.locator('.button-submit, button:has-text("Verify"), button:has-text("Skip"), #checkbox');
      if (await btn.count().catch(() => 0)) {
        await btn.first().click({ timeout: 8000 }).catch(() => {});
        log('pressed the challenge button');
        await page.waitForTimeout(2500);
        return 0;
      }
    }
    log('no verify control found in the challenge frame');
    return 2;
  }

  if (cmd === 'submit') {
    const btn = page.locator('button:has-text("Submit application"), button[type="submit"]').first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      if (/thanks|confirm/i.test(page.url())) { console.log(`SUBMITTED ${page.url()}`); return 0; }
    }
    log(`no confirmation; still at ${page.url()}`);
    return 2;
  }

  log(`unknown command ${cmd}`);
  return 1;
}

const code = await run();
try { await browser.close(); } catch { /* detached */ }
process.exit(code);
