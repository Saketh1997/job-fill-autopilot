#!/usr/bin/env node
// check_liveness.mjs — decide whether a scraped posting is still applyable
// BEFORE the pipeline spends a tailoring run or a fill on it.
//
// Expiry is not one state. This separates the ones worth acting on:
//   live            proceed
//   expired         posting says so in words -> skip, mark expired
//   not_found       404 / gone -> skip
//   redirected      bounced to a search or careers home -> skip (or re-resolve)
//   stale_suspect   nothing says dead, but signals are off -> hold for human
//
//   node check_liveness.mjs --scrape scrapes/<x>.json [--posted-before DAYS]
//   node check_liveness.mjs --text scrapes/<x>.txt --url <url>
//
// Exit: 0 live   2 not live (see status)   3 error

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SCRAPE = val('--scrape', '');
const TEXT = val('--text', '');
const URL_ARG = val('--url', '');
const STALE_DAYS = Number(val('--posted-before', 60));

const out = (o, code) => { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); process.exit(code); };

let text = '', url = URL_ARG, title = '', fields = [], best = null, scrapeCandidates = [];
try {
  if (SCRAPE) {
    const s = JSON.parse(readFileSync(SCRAPE, 'utf8'));
    url = url || s.final_url || s.requested || '';
    title = s.title || '';
    fields = s.fields || [];
    best = s.best || null;
    scrapeCandidates = s.candidates || [];
    // Prefer the saved text file if present; fall back to title.
    if (s.text_path) { try { text = readFileSync(s.text_path, 'utf8'); } catch { /* none */ } }
    text = text || title;
  } else if (TEXT) {
    text = readFileSync(TEXT, 'utf8');
  } else {
    out({ error: 'need --scrape <json> or --text <txt> --url <url>' }, 3);
  }
} catch (e) { out({ error: `read failed: ${e.message}` }, 3); }

const body = text.toLowerCase();
const reasons = [];

// 0. A present, real apply control proves the posting is live. Check this
//    FIRST and short-circuit: it does not depend on body text, and a page whose
//    form lives on an external ATS (Ashby, Greenhouse) legitimately has zero
//    inline fields. Without this, the "no body text" caution below fires on
//    perfectly live postings scraped without --text.
const realApply = !!best || (Array.isArray(scrapeCandidates) && scrapeCandidates.some((c) =>
  /\bapply\b/i.test(`${c.text || ''} ${c.aria || ''}`)
  && c.abs && !/#$/.test(c.abs)
  && !/check_application_status|career-programs|military|\/careers\/?(\?|$)|^https?:\/\/[^/]+\/?$/i.test(c.abs)));
if (realApply) {
  out({ status: 'live', url, reason: 'apply control present' }, 0);
}

// 0a. Structural death: no apply control AND every field is search/alert chrome.
//     This is the HTTP-200-but-button-gone case (Amazon's signature).
const searchOnly = fields.length > 0 && fields.every((f) =>
  /keyword|search|locationsearch|locationjobfilter|keywordjobfilter|distancefilter|frequency|\bq\b|email/i
    .test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`));
if (searchOnly) {
  out({ status: 'expired', url, confidence: 'medium',
        reasons: ['no apply control present; every field is search/alert chrome'],
        note: 'structural signal: HTTP 200 but the apply button is gone' }, 2);
}

// 0. Some sites 200 a dead job but redirect the URL to a search or error path.
//    If the final URL drifted to a non-job path, that is the tell, no text
//    needed. Amazon bounces expired jobs toward /search and /error.
if (url && /\/(search|error|not-found|expired|jobs\/?$)(\?|$)/i.test(url)
    && !/\/jobs?\/\d/i.test(url)) {
  out({ status: 'redirected', url, confidence: 'high',
        reasons: [`final url is not a job page: ${url}`] }, 2);
}

// 0b. Platform-specific dead-page banners. These sites return HTTP 200 with a
//     normal title and hide the status in JS-rendered body text, so the generic
//     list below misses them unless --text was captured.
const PLATFORM_DEAD = [
  /this (job|position) is no longer available/,
  /this position has been filled/,
  /no longer accepting applications for this/,
  /job (id )?(not found|no longer active)/,
  /the (job|position) you.?re looking for/,          // "...is no longer available/has moved"
  /this posting is not currently active/,
];
for (const re of PLATFORM_DEAD) if (re.test(body)) { reasons.push(`platform_dead: ${re.source}`); break; }
if (reasons.length) out({ status: 'expired', url, confidence: 'high', reasons }, 2);

// A title with no body is a signal in itself: JS-rendered status pages often
// leave the title intact. Flag it so a live-looking result is not trusted blind.
if (text && text.trim() === (title || '').trim()) {
  out({ status: 'stale_suspect', url, confidence: 'low',
        reasons: ['only a title was available; body text not captured, cannot confirm liveness'],
        action: 'rescrape with --text, or hold for human' }, 2);
}

// 1. Explicit closure language. High confidence, act on it.
const EXPIRED = [
  /no longer (accepting|available|active)/,
  /this (job|position|posting|requisition) (has )?(expired|closed|been filled|is no longer)/,
  /applications? (are )?(closed|no longer accepted)/,
  /posting has expired/,
  /position has been filled/,
  /we are no longer accepting applications/,
  /this job is no longer accepting/,
  /req(uisition)? (is )?closed/,
];
for (const re of EXPIRED) if (re.test(body)) { reasons.push(`closure_text: ${re.source}`); break; }
if (reasons.length) out({ status: 'expired', url, confidence: 'high', reasons }, 2);

// 2. Not found / gone. Title and body both leak this.
const NOTFOUND = [
  /404|not found|page (does not|doesn.t) exist|page unavailable/,
  /job (not found|does not exist|has been removed)/,
  /this link (has expired|is no longer valid)/,
  /oops|something went wrong/,
];
for (const re of NOTFOUND) {
  if (re.test(body) || re.test(title.toLowerCase())) { reasons.push(`notfound_text: ${re.source}`); break; }
}
if (reasons.length) out({ status: 'not_found', url, confidence: 'high', reasons }, 2);

// 3. Redirected to a search / careers home instead of a posting. This is the
//    CFM case: the apply link resolved to a job-search widget, not a job.
const searchFields = fields.filter((f) =>
  /keyword|search|locationsearch|locationjobfilter|keywordjobfilter|distancefilter|frequency/i
    .test(`${f.name || ''} ${f.id || ''} ${f.label || ''}`));
if (fields.length > 0 && searchFields.length === fields.length) {
  out({ status: 'redirected', url, confidence: 'high',
        reasons: ['every field is a search/alert control; no application form'] }, 2);
}

// 4. Stale suspects. Nothing declares the job dead, but something is off. These
//    do NOT auto-skip: they hold for a human, because a false skip here means a
//    live job silently dropped.
const soft = [];

// 4a. Old posting. Needs a date the scrape carries; skip if absent.
const posted = (text.match(/posted[^\d]{0,20}(\d{4}-\d{2}-\d{2})/i)
             || text.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
if (posted) {
  const days = (Date.now() - Date.parse(posted)) / 86400000;
  if (days > STALE_DAYS) soft.push(`posted ${Math.round(days)}d ago (> ${STALE_DAYS})`);
}

// 4b. Applicant-count language some boards show on dead-ish posts.
if (/over \d{3,} applicants|no longer taking new/i.test(body)) soft.push('high applicant / winding-down language');

// 4c. An apply control that points back at a login or careers root rather than
//     a form. best_kind submit on a page with a real form is fine; navigate to
//     a non-job URL is a smell.
if (best && best.abs && /\/(login|signin|careers|talentcommunity)(\/|\?|$)/i.test(best.abs)
    && !/job|requisition|apply\/\d/i.test(best.abs)) {
  soft.push(`apply target looks like a portal root: ${best.abs}`);
}

if (soft.length) out({ status: 'stale_suspect', url, confidence: 'low',
                       reasons: soft, action: 'hold for human, do not auto-skip' }, 2);

// Nothing tripped. Treat as live.
out({ status: 'live', url }, 0);
