#!/usr/bin/env node
/**
 * send_followup_dm.mjs -- follow-up DM to someone who ACCEPTED a connection invite.
 *
 *   node send_followup_dm.mjs <drafts.json> [--dry-run] [--only <slug>]
 *
 * This is the leg the outreach queue never had. `linkedin_send.py` covers the two
 * FIRST-contact channels (connect note, InMail) and hard-refuses anything that is
 * not `approved`; neither leg can attach a document, which is why the four
 * follow-ups sent 2026-08-27 went out bare. Saketh's standing instruction
 * (2026-08-27) is that every follow-up carries a resume, so the attachment is a
 * precondition here, not an option: no chip in the compose box, no send.
 *
 * Safety properties, all deliberate:
 *   - SERIAL. One target at a time, and the run STOPS on the first target that
 *     does not confirm. One attempt is all a message gets (PIPELINE.md 9.2/9.3).
 *   - Nothing is typed until the profile proves the invite was ACCEPTED. A
 *     "Pending" profile means the invite is still outstanding and a "Message"
 *     click there would spend an InMail credit on text written for a DM.
 *   - --dry-run does everything except click Send, then closes the composer.
 *   - Text goes in with CDP insertText, never keystrokes: LinkedIn may have
 *     "press Enter to send" on, and a typed newline would fire a half-written
 *     message. insertText dispatches no key events at all.
 *   - Every step is verified by reading the box back before the next one runs.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const CDP_URL = process.env.CDP_ENDPOINT || 'http://localhost:9226';
const OUT = '/home/hunter/projects/career-ops/Job_applicator/answers/followup-send.json';

const args = process.argv.slice(2);
const DRAFTS = args[0];
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (!DRAFTS) { console.error('usage: send_followup_dm.mjs <drafts.json> [--dry-run] [--only <slug>]'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/**
 * Close every open message overlay, INCLUDING the ones inside shadow roots.
 *
 * The original version queried only `document`, so it closed nothing: LinkedIn's
 * composer lives in a shadow tree. A leftover overlay from the previous target
 * then satisfied the next target's compose-box lookup, and the second message
 * was typed into the FIRST person's conversation and sent there. That is not a
 * hypothetical -- it happened on 2026-09-08 to a recruiter.
 */
async function closeOverlays(page) {
  try {
    await page.evaluate(() => {
      const SEL = '.msg-overlay-bubble-header__control--close, ' +
                  'button[data-control-name="overlay.close_conversation_window"], ' +
                  '.msg-overlay-bubble-header__controls button[aria-label*="Close"]';
      const clickIn = (root) => root.querySelectorAll(SEL).forEach(b => { try { b.click(); } catch {} });
      clickIn(document);
      const walk = (n, d) => {
        if (d > 8 || !n) return;
        if (n.shadowRoot) { clickIn(n.shadowRoot); walk(n.shadowRoot, d + 1); }
        for (const c of (n.children || [])) walk(c, d + 1);
      };
      walk(document.documentElement, 0);
    });
  } catch {}
  await sleep(1500);
}

/**
 * Whose conversation is this composer actually attached to?
 *
 * THE gate. Everything else in this file is a convenience; this is the check
 * that stops a message going to the wrong person. Read from the compose-box
 * handle so it sees inside the shadow tree, and refuse on any mismatch.
 */
/** Plain-English read of the profile's top-card controls. */
async function readProfileState(page) {
  return await page.evaluate(() => {
    const seen = [];
    let pending = false, message = false, connect = false;
    for (const el of document.querySelectorAll('main button, main a, main [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.y > 80 && r.y < 800)) continue;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      const a = (el.getAttribute('aria-label') || '').trim();
      const label = (t || a);
      if (!label || label.length > 80) continue;
      seen.push(label);
      const low = (t + ' ' + a).toLowerCase();
      if (low.includes('pending') || low.includes('invitation sent')) pending = true;
      if (/^message\b/.test(t.toLowerCase()) || a.toLowerCase().startsWith('message ')) message = true;
      if (t.toLowerCase() === 'connect' || a.toLowerCase().startsWith('invite')) connect = true;
    }
    const degree = (document.body.innerText.match(/·\s*(1st|2nd|3rd)/) || [])[1] || null;
    const heading = (document.querySelector('main h1') || {}).innerText || '';
    return { seen: seen.slice(0, 25), pending, message, connect, degree, heading: heading.trim() };
  });
}

async function clickMessage(page) {
  return await page.evaluate(() => {
    for (const el of document.querySelectorAll('main button, main a, main [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.y > 80 && r.y < 800)) continue;
      const t = (el.innerText || '').trim().toLowerCase();
      const a = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (a.includes('messaging') || t.includes('messaging')) continue;   // global nav
      if (t === 'message' || a.startsWith('message ')) { el.click(); return true; }
    }
    return false;
  });
}

async function composerBelongsTo(box) {
  return await box.evaluate((el) => {
    // Climb to THIS box's own conversation bubble. Scoping to the shadow root is
    // not enough: several overlays share one shadow tree, so a root-wide search
    // returns every open conversation and any "does the intended name appear"
    // test passes even when this box belongs to someone else.
    let bubble = el;
    for (let i = 0; i < 15 && bubble.parentElement; i++) {
      bubble = bubble.parentElement;
      const c = (bubble.className || '').toString();
      if (/msg-overlay-conversation-bubble|msg-convo-wrapper|msg-overlay-container/.test(c)) break;
    }
    const names = new Set();
    bubble.querySelectorAll('.msg-form__upload-attachment, [aria-label*="conversation with"]').forEach(n => {
      const t = (n.innerText || '') + ' ' + (n.getAttribute('aria-label') || '');
      const m = t.match(/conversation with ([^\n]+?)\s*$/im);
      if (m) names.add(m[1].trim());
    });
    bubble.querySelectorAll('.msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title')
      .forEach(n => { const t = (n.innerText || '').trim().split('\n')[0]; if (t) names.add(t); });
    return { bubbleCls: (bubble.className || '').toString().slice(0, 80), names: [...names] };
  });
}

/**
 * Find the compose box that belongs to `contactName`, not merely the first one
 * on the page. Several conversation overlays can be open at once (a human using
 * the same browser opens them too), and picking by document order is what sent
 * the second contact's message into the first contact's thread on 2026-09-08.
 */
async function findComposerFor(page, contactName) {
  const want = contactName.toLowerCase();
  for (let attempt = 0; attempt < 20; attempt++) {
    const boxes = await page.$$(BOX);
    const seen = [];
    for (const b of boxes) {
      const bb = await b.boundingBox();
      if (!bb || bb.width === 0) continue;
      const info = await composerBelongsTo(b);
      seen.push(info.names);
      const exact = info.names.filter(n => n.toLowerCase().includes(want) || want.includes(n.toLowerCase()));
      const others = info.names.filter(n => !(n.toLowerCase().includes(want) || want.includes(n.toLowerCase()))
                                            && !/^status is/i.test(n));
      if (exact.length && !others.length) return { box: b, names: info.names, seen };
    }
    if (attempt === 19) return { box: null, names: [], seen };
    await sleep(500);
  }
  return { box: null, names: [], seen: [] };
}

const BOX = '.msg-form__contenteditable [role="textbox"], .msg-form__contenteditable, div.msg-form__contenteditable[contenteditable="true"], form.msg-form div[role="textbox"][contenteditable="true"]';

async function findComposer(page) {
  for (let i = 0; i < 20; i++) {
    const h = await page.$(BOX);
    if (h) { const b = await h.boundingBox(); if (b && b.width > 0) return h; }
    await sleep(500);
  }
  return null;
}

async function readBox(page, box) {
  // Read back through the handle we actually typed into. Resolving the selector
  // again can land on a different node (the compose box is a nest of divs that
  // all match), which reads as "the text never landed" when it did.
  if (box) { try { return (await box.innerText()).trim(); } catch {} }
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || '').trim() : null;
  }, BOX);
}

const norm = s => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Put `text` in the composer and PROVE it landed.
 *
 * Strategy order matters. Nothing here may press Enter: LinkedIn's "press Enter
 * to send" setting turns a typed newline into a half-written message, so
 * newlines arrive as Shift+Enter or as inserted text, never as Enter.
 */
async function typeMessage(page, box, text) {
  const tried = [];

  const attempt = async (name, fn) => {
    if (norm(await readBox(page, box)) === norm(text)) return true;
    try { await fn(); } catch (e) { tried.push(`${name}: threw ${e.message}`); return false; }
    await sleep(1200);
    const got = norm(await readBox(page, box));
    if (got === norm(text)) { tried.push(`${name}: OK`); return true; }
    tried.push(`${name}: got ${got.length}/${norm(text).length} chars`);
    // leave nothing behind for the next strategy to append to
    try {
      await box.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await sleep(500);
    } catch {}
    return false;
  };

  const focus = async () => {
    await box.click();
    await sleep(500);
    await box.evaluate(el => el.focus());
    await sleep(300);
  };

  // 1. CDP insertText -- dispatches no key events at all
  const ok1 = await attempt('cdp-insertText', async () => {
    await focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text });
  });
  if (ok1) return { ok: true, how: 'cdp-insertText', tried };

  // 2. execCommand insertText, inside the element, paragraph by paragraph
  const ok2 = await attempt('execCommand', async () => {
    await focus();
    await box.evaluate((el, t) => {
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      sel.addRange(r);
      document.execCommand('insertText', false, t);
    }, text);
  });
  if (ok2) return { ok: true, how: 'execCommand', tried };

  // 3. real keystrokes, with Shift+Enter for newlines so Enter never fires
  const ok3 = await attempt('keyboard-shiftenter', async () => {
    await focus();
    const paras = text.split('\n');
    for (let i = 0; i < paras.length; i++) {
      if (paras[i]) await page.keyboard.insertText(paras[i]);
      if (i < paras.length - 1) await page.keyboard.press('Shift+Enter');
    }
  });
  if (ok3) return { ok: true, how: 'keyboard-shiftenter', tried };

  return { ok: false, how: null, tried };
}

/**
 * The whole composer lives in a SHADOW ROOT (host div.theme--light), so
 * `document.querySelector` from the page context cannot see any of it. Every
 * read here therefore starts from the compose-box handle and uses its
 * getRootNode() as the scope. This was the bug that made a successful upload
 * look like a failed one.
 */
async function attachmentChips(page, box) {
  return await box.evaluate((el) => {
    const rootNode = el.getRootNode();
    const scope = rootNode instanceof ShadowRoot ? rootNode : document;
    const out = [];
    for (const n of scope.querySelectorAll(
      '.msg-form__attachment-list, .msg-form__attachment-preview')) {
      const t = (n.innerText || '').trim().replace(/\s+/g, ' ');
      if (t) out.push(t);
    }
    return [...new Set(out)];
  });
}

/** Clear attachments a previous run left staged, so we never send two copies. */
async function clearAttachments(page, box) {
  const n = await box.evaluate((el) => {
    const rootNode = el.getRootNode();
    const scope = rootNode instanceof ShadowRoot ? rootNode : document;
    let clicked = 0;
    for (const prev of scope.querySelectorAll('.msg-form__attachment-preview')) {
      for (const b of prev.querySelectorAll('button')) { b.click(); clicked++; }
    }
    return clicked;
  });
  await sleep(1500);
  return n;
}

async function processOne(page, t) {
  const res = { slug: t.slug, name: t.contact_name, status: 'failed', evidence: '', error: '' };
  log(`\n${'='.repeat(70)}\n[TARGET] ${t.contact_name}  (${t.slug})\n[URL]    ${t.contact_profile_url}`);
  log(`[ATTACH] ${path.basename(t.resume)}\n[CHARS]  ${t.message.length}`);

  if (!fs.existsSync(t.resume)) { res.error = `resume missing: ${t.resume}`; return res; }

  await page.goto(t.contact_profile_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  await closeOverlays(page);

  const st = await readProfileState(page, t.contact_name);
  log(`[PROFILE] heading=${JSON.stringify(st.heading)} degree=${st.degree} ` +
      `pending=${st.pending} message=${st.message} connect=${st.connect}`);
  log(`[CONTROLS] ${st.seen.join(' | ')}`);

  // The invite must actually be accepted. Pending == still outstanding.
  if (st.pending) {
    res.error = 'profile still shows Pending -- invite not accepted; refusing to send';
    return res;
  }
  if (st.degree && st.degree !== '1st') {
    res.error = `profile shows ${st.degree} degree, not 1st -- not a connection; refusing to send`;
    return res;
  }
  if (!st.message) {
    res.error = 'no Message control on the profile';
    return res;
  }

  await closeOverlays(page);   // no stale bubble may satisfy the lookup below
  if (!await clickMessage(page)) { res.error = 'Message control vanished before click'; return res; }
  await sleep(3500);

  const found = await findComposerFor(page, t.contact_name);
  const box = found.box;
  log(`[OWNER]  composers on page: ${JSON.stringify(found.seen)}`);
  if (!box) {
    res.error = `no compose box unambiguously belonging to ${t.contact_name} -- ` +
                `refusing to type into a conversation that may be someone else's`;
    res.evidence = `composers seen: ${JSON.stringify(found.seen)}`;
    return res;
  }
  log(`[OWNER]  using the composer for ${JSON.stringify(found.names)}`);

  // ---- text
  // Clear any persisted draft first: LinkedIn keeps what a previous run left in
  // the box, and appending to it would send the message twice over.
  const pre = await readBox(page, box);
  if (pre && pre.trim()) {
    log(`[DRAFT]  composer already held ${pre.length} chars; clearing first`);
    await box.click();
    await page.keyboard.press('Control+A');
    await sleep(300);
    await page.keyboard.press('Delete');
    await sleep(800);
    const cleared = await readBox(page, box);
    if (cleared && cleared.trim()) {
      res.error = `composer held a stale draft (${cleared.length} chars) that would not clear`;
      res.evidence = `box: ${JSON.stringify(cleared.slice(0, 200))}`;
      return res;
    }
  }

  const typedRes = await typeMessage(page, box, t.message);
  log(`[TYPING] ${typedRes.tried.join(' | ')}`);
  if (!typedRes.ok) {
    res.error = 'could not get the message text into the compose box';
    res.evidence = `strategies tried -- ${typedRes.tried.join(' | ')}`;
    return res;
  }
  const typed = await readBox(page, box);
  log(`[TYPED]  verified ${typed.length} chars via ${typedRes.how}`);

  // ---- attachment: mandatory for a follow-up
  const already = await attachmentChips(page, box);
  if (already.length) {
    log(`[STALE]  composer already held an attachment; clearing it`);
    await clearAttachments(page, box);
    const still = await attachmentChips(page, box);
    if (still.length) {
      res.error = `composer holds an attachment that would not clear (${JSON.stringify(still)}) -- ` +
                  `refusing to send two copies`;
      return res;
    }
  }

  // TWO file inputs exist: one accepts image/* only, the other accepts documents.
  // Setting a PDF on the image-only input silently does nothing, which is exactly
  // how this failed the first time. Pick by the accept attribute, never by order.
  // Scope the input to THIS bubble. Selecting page-wide and taking the last
  // pdf-capable input can hand back the input belonging to a different open
  // conversation, so the file is staged on someone else's form: the chip appears,
  // the upload "settles", and the message goes out with no attachment at all.
  const inputs = await page.$$('input.msg-form__attachment-upload-input, input[type="file"]');
  let fileInput = null;
  for (const h of inputs) {
    const info = await h.evaluate((e, boxEl) => {
      const acc = e.getAttribute('accept') || '';
      // does this input live in the same conversation bubble as the compose box?
      let bub = boxEl;
      for (let i = 0; i < 15 && bub.parentElement; i++) {
        bub = bub.parentElement;
        if (/msg-overlay-conversation-bubble|msg-convo-wrapper|msg-overlay-container/
            .test((bub.className || '').toString())) break;
      }
      return { acc, sameBubble: bub.contains(e) };
    }, box);
    if (/pdf/i.test(info.acc) && info.sameBubble) { fileInput = h; break; }
  }
  if (!fileInput) {
    res.error = 'no document-capable file input inside this conversation\'s own composer';
    return res;
  }
  await fileInput.setInputFiles(t.resume);
  await sleep(3500);

  let chips = await attachmentChips(page, box);
  for (let i = 0; i < 6 && chips.length === 0; i++) { await sleep(1500); chips = await attachmentChips(page, box); }
  const base = path.basename(t.resume);
  const stem = base.replace(/\.pdf$/i, '').slice(0, 20);
  const attached = chips.some(c => c.includes(stem) || /\.pdf/i.test(c));
  if (!attached) {
    res.error = 'resume did not attach (no attachment chip in the composer)';
    res.evidence = `chips seen: ${JSON.stringify(chips)}`;
    return res;
  }
  log(`[ATTACHED] ${JSON.stringify(chips)}`);

  // The chip appears as soon as the file is STAGED. the first contact's 10:54 message
  // on 2026-09-08 went out with the chip showing "55 KB Attached" and arrived
  // with no file at all, so wait for the upload to settle and for no progress
  // indicator to remain before the Send click.
  let stable = 0, last = '';
  for (let i = 0; i < 20 && stable < 3; i++) {
    const now = JSON.stringify(await attachmentChips(page, box));
    const busy = await box.evaluate((el) => {
      const rootNode = el.getRootNode();
      const scope = rootNode instanceof ShadowRoot ? rootNode : document;
      return !!scope.querySelector(
        '.msg-form__attachment-preview progress, [role="progressbar"], .artdeco-spinner, [class*="uploading"]');
    });
    stable = (now === last && !busy) ? stable + 1 : 0;
    last = now;
    await sleep(1000);
  }
  log(`[UPLOAD] settled after waiting; chips=${last}`);

  // text can be cleared by the upload widget; re-verify before sending
  const after = await readBox(page, box);
  if (norm(after) !== norm(t.message)) {
    res.error = 'message text changed after attaching the resume -- refusing to send a mangled draft';
    res.evidence = `box now: ${JSON.stringify((after || '').slice(0, 200))}`;
    return res;
  }

  if (DRY) {
    res.status = 'dry-run';
    res.evidence = `composed ${t.message.length} chars + attachment ${JSON.stringify(chips)}; Send NOT clicked`;
    log('[DRY-RUN] everything staged; not clicking Send');
    // Leave the composer EMPTY. LinkedIn persists drafts, and a dry-run that
    // left its text and attachment behind would trip the stale-draft guards on
    // the real send -- the rehearsal would block the performance.
    const removed = await clearAttachments(page, box);
    await box.click();
    await page.keyboard.press('Control+A');
    await sleep(200);
    await page.keyboard.press('Delete');
    await sleep(800);
    const leftText = (await readBox(page, box)) || '';
    const leftChips = await attachmentChips(page, box);
    res.evidence += `; cleanup: removed ${removed} attachment control(s), ` +
                    `text left=${leftText.trim().length} chars, chips left=${JSON.stringify(leftChips)}`;
    log(`[CLEANUP] text left=${leftText.trim().length} chars, chips left=${JSON.stringify(leftChips)}`);
    await closeOverlays(page);
    return res;
  }

  const sent = await box.evaluate((el) => {
    const rootNode = el.getRootNode();
    const scope = rootNode instanceof ShadowRoot ? rootNode : document;
    for (const b of scope.querySelectorAll('button.msg-form__send-button, button')) {
      const t = (b.innerText || '').trim().toLowerCase();
      if ((b.classList.contains('msg-form__send-button') || t === 'send') && !b.disabled) {
        b.click(); return true;
      }
    }
    return false;
  });
  if (!sent) { res.error = 'composed message and attachment but found no enabled Send button'; return res; }
  await sleep(5000);

  const emptied = norm(await readBox(page, box)) === '';
  const inThread = await box.evaluate((el, needle) => {
    const rootNode = el.getRootNode();
    const scope = rootNode instanceof ShadowRoot ? rootNode.host : document.body;
    return ((scope.innerText || '')).includes(needle);
  }, t.message.slice(0, 60));

  if (!emptied && !inThread) {
    res.error = 'clicked Send but could not confirm the message left the composer';
    return res;
  }
  // Did the FILE land, or only the words? The composer emptying proves neither.
  await sleep(4000);
  const landed = await box.evaluate((el, fname) => {
    const rootNode = el.getRootNode();
    const scope = rootNode instanceof ShadowRoot ? rootNode : document;
    const events = [...scope.querySelectorAll('li.msg-s-message-list__event, .msg-s-event-listitem')]
      .map(n => n.innerText || '').join('\n');
    const stem = fname.replace(/\.pdf$/i, '').slice(0, 25);
    return { hasFile: events.includes(stem) || /\.pdf/i.test(events), events: events.length };
  }, path.basename(t.resume));

  res.status = landed.hasFile ? 'sent' : 'sent_without_attachment';
  res.evidence = `clicked Send; composer cleared=${emptied}, text visible in thread=${inThread}; ` +
                 `staged attachment=${JSON.stringify(chips)}; attachment present in thread=${landed.hasFile}`;
  log(`[SENT]   ${res.evidence}`);
  if (!landed.hasFile) {
    // Not a failure of the send -- the message is gone and cannot be recalled --
    // but the standing rule is that a follow-up carries a resume, so say so
    // loudly rather than reporting a clean success.
    res.error = 'message sent but the resume is NOT in the thread -- attachment silently dropped';
    log(`[WARN]   ${res.error}`);
  }
  return res;
}

(async () => {
  let drafts = JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  if (ONLY) drafts = drafts.filter(d => d.slug === ONLY);
  if (!drafts.length) { console.error('no drafts to send'); process.exit(2); }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const results = [];
  let stopped = null;

  for (const t of drafts) {
    let r;
    try { r = await processOne(page, t); }
    catch (e) { r = { slug: t.slug, name: t.contact_name, status: 'failed', error: String(e && e.message || e) }; }
    results.push(r);
    if (r.status === 'failed' || r.status === 'sent_without_attachment') {
      stopped = r;
      console.error(`\n[STOP] ${r.name} did not confirm: ${r.error}`);
      console.error('[STOP] halting the run -- remaining targets untouched (serial rule).');
      break;
    }
    await sleep(4000);
  }

  await page.close().catch(() => {});
  fs.writeFileSync(OUT, JSON.stringify({ ran_at: new Date().toISOString(), dry_run: DRY, results }, null, 2));
  log(`\n${'='.repeat(70)}\nwrote ${OUT}`);
  for (const r of results) log(`  ${r.status.toUpperCase().padEnd(8)} ${r.name}  ${r.error || r.evidence}`);
  process.exit(stopped ? 1 : 0);
})();
