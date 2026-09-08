#!/usr/bin/env node
// outreach-review.mjs — triage drafted LinkedIn outreach before any of it is
// sent. The readback.mjs of the outreach half of the pipeline.
//
//   node outreach-review.mjs [--status needs_review,pending_approval] [--full]
//   node outreach-review.mjs --slug <slug>
//
// WHY THIS EXISTS
//
// linkedin-draft.sh asks a model to find a contact and write a note, and the
// model then reports on its own work: is_alumni, referral_power, the character
// count, whether this person was already contacted. Every one of those is a
// claim, and nothing checked any of them before linkedin-send.sh ran.
//
// Two things got through, both visible in the queue right now:
//   - Amit Bawaskar was messaged TWICE, once under "Amazon" and once under
//     "Amazon.com Services LLC". The dedup in linkedin-draft.sh compares
//     company strings, so one employer wearing three legal names reads as three
//     employers. Dedup has to be on the PERSON, not the company.
//   - 17 entries sit at needs_review with contact_name null and two or three
//     perfectly usable alt_targets underneath. Nobody is being contacted for
//     those postings at all, which is a quieter failure than a bad message.
//
// So this checks what can be checked mechanically and prints only what cannot:
//   BLOCKER  — do not send: no contact, a repeat of someone already messaged,
//              over the 300-char connection-note limit, or a house-rule
//              violation in the text
//   MISMATCH — the draft's own claims disagree with each other
//   JUDGE    — nothing mechanical is wrong. Is this the right person, and does
//              the message say true things? That question is the reviewer's.
//
// It sends nothing, approves nothing, and writes nothing to the queue.
//
// Exit: 0 reviewed · 1 error

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const QUEUE = path.join(ROOT, 'data', 'linkedin-outreach-queue.json');
const DRAFTS = path.join(ROOT, 'Job_applicator', 'answers');

const argv = process.argv.slice(2);
const opts = { statuses: ['needs_review', 'pending_approval'], slug: '', full: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--status') opts.statuses = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--slug') opts.slug = argv[++i];
  else if (a === '--full') opts.full = true;
  else { console.error(`unknown flag: ${a}`); process.exit(1); }
}

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const queue = readJson(QUEUE, []);
if (!Array.isArray(queue)) { console.error('queue is not an array'); process.exit(1); }

// ------------------------------------------------------------------ identity
// One employer wearing several legal names is still one employer. Strip the
// suffixes and the corporate decoration and compare what is left, so "Amazon",
// " Amazon.com Services LLC" and "Amazon Web Services, Inc." collapse.
const coKey = (s) => String(s || '').toLowerCase()
  .replace(/[.,]/g, ' ')
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc|sa|nv|ag|holdings|group|labs|technologies|technology|services|solutions|systems|international|global|usa|us)\b/g, ' ')
  .replace(/\b(web services|com)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '')
  .trim();

// A person is the profile URL when there is one, and the name otherwise. The
// URL is the reliable key: two people can share a name, and one person's name
// can be spelled three ways across three drafts.
const personKey = (r) => {
  const u = String(r.contact_profile_url || '').toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0];
  if (u) return `url:${u}`;
  const n = String(r.contact_name || '').toLowerCase().replace(/[^a-z]+/g, '');
  return n ? `name:${n}` : '';
};

// Everyone already spoken to, and everyone already queued to be. A person in
// here must not be the contact on a new draft.
const SPOKEN = new Set(['sent', 'approved', 'connected']);
const contacted = new Map();     // personKey -> [{company, slug, status}]
const perCompany = new Map();    // coKey     -> [{name, personKey, status}]
for (const r of queue) {
  const pk = personKey(r);
  const ck = coKey(r.company);
  if (pk && SPOKEN.has(String(r.status))) {
    contacted.set(pk, (contacted.get(pk) || []).concat({ company: String(r.company || '').trim(), slug: r.slug, status: r.status }));
  }
  if (ck && pk && SPOKEN.has(String(r.status))) {
    perCompany.set(ck, (perCompany.get(ck) || []).concat({ name: r.contact_name, personKey: pk, status: r.status }));
  }
}

// ------------------------------------------------------------------- checks
const TYPES = ['recruiter', 'hiring_manager', 'peer', 'interviewer'];
// modes/_custom.md: the MS was COMPLETED 2026-06-10. A note that calls the
// candidate a current student is factually wrong, and it is the single easiest
// thing for a drafting model to get wrong because most outreach templates
// assume a student.
const STUDENT = /\b(currently (a )?(pursuing|studying|enrolled)|current student|i am a student|expected graduation|graduating in|will graduate|pursuing my (ms|master))\b/i;
const CHAR_LIMIT = 300;

function review(entry) {
  const draft = readJson(path.join(DRAFTS, `${entry.slug}-linkedin.json`), {}) || {};
  // The queue row is authoritative for status; the draft file carries the
  // richer fields the queue schema never persisted (is_alumni, referral_power,
  // channel, the InMail body, alt_targets).
  const r = { ...draft, ...entry, alt_targets: entry.alt_targets || draft.alt_targets || [] };
  const problems = [];
  const add = (cls, why) => problems.push({ cls, why });

  const msg = String(r.message || '');
  const channel = r.channel || (r.inmail_subject ? 'inmail' : 'connect');
  const pk = personKey(r);

  if (!r.contact_name || !r.contact_profile_url) {
    add('BLOCKER', `no contact chosen (${(r.alt_targets || []).length} alt_target(s) available)`);
  } else {
    if (!/linkedin\.com\/in\//i.test(String(r.contact_profile_url))) {
      add('BLOCKER', `contact_profile_url is not a LinkedIn profile: ${r.contact_profile_url}`);
    }
    const prior = contacted.get(pk) || [];
    if (prior.length) {
      add('BLOCKER', `${r.contact_name} was already contacted: ${prior.map((p) => `${p.company} (${p.status})`).join(', ')} — pick a different person at this company`);
    }
  }

  if (channel === 'connect') {
    if (!msg.trim()) add('BLOCKER', 'connection note is empty');
    else if (msg.length > CHAR_LIMIT) add('BLOCKER', `connection note is ${msg.length} chars, limit is ${CHAR_LIMIT} — LinkedIn will truncate it`);
  }
  if (msg.includes('—')) add('BLOCKER', 'message contains an em dash (house rule: none)');
  if (STUDENT.test(msg) || STUDENT.test(String(r.inmail_body || ''))) {
    add('BLOCKER', 'message implies the candidate is a current student; the MS was completed 2026-06-10');
  }

  if (channel === 'inmail' && !(r.is_alumni === true && r.referral_power === 'high')) {
    add('MISMATCH', `channel is inmail but is_alumni=${r.is_alumni} referral_power=${r.referral_power} — InMail credits are finite and this does not meet the bar`);
  }
  if (r.is_alumni === true && !String(r.alumni_evidence || '').trim()) {
    add('MISMATCH', 'is_alumni is true with no alumni_evidence recorded');
  }
  if (r.referral_power === 'none') {
    add('MISMATCH', `referral_power is none: ${r.referral_rationale || '(no rationale)'} — this contact cannot help`);
  }
  if (r.contact_type && !TYPES.includes(r.contact_type)) {
    add('MISMATCH', `contact_type "${r.contact_type}" is not one of ${TYPES.join('/')}`);
  }

  const cls = problems.some((p) => p.cls === 'BLOCKER') ? 'BLOCKER'
    : problems.some((p) => p.cls === 'MISMATCH') ? 'MISMATCH' : 'JUDGE';
  return { r, cls, problems, msg, channel };
}

// -------------------------------------------------------------------- output
let rows = queue.filter((r) => (opts.slug ? r.slug === opts.slug : opts.statuses.includes(String(r.status))));
if (!rows.length) {
  console.log(`nothing at status ${opts.statuses.join('/')}${opts.slug ? ` for ${opts.slug}` : ''}.`);
  process.exit(0);
}

const results = rows.map(review);
const n = (c) => results.filter((x) => x.cls === c).length;

console.log(`# outreach review — ${results.length} draft(s) at ${opts.statuses.join('/')}`);
console.log(`triage: ${n('BLOCKER')} blocker · ${n('MISMATCH')} mismatch · ${n('JUDGE')} ready for a judgement call`);
console.log(`people already contacted: ${contacted.size}\n`);

const order = { BLOCKER: 0, MISMATCH: 1, JUDGE: 2 };
results.sort((a, b) => order[a.cls] - order[b.cls]);

for (const { r, cls, problems, msg, channel } of results) {
  console.log(`--- [${cls}] ${String(r.company || '').trim()} — ${r.role}`);
  console.log(`    slug:    ${r.slug}`);
  console.log(`    contact: ${r.contact_name || '(none)'}${r.contact_title ? ` — ${r.contact_title}` : ''}`
    + `${r.contact_type ? ` [${r.contact_type}]` : ''}`);
  if (r.contact_profile_url) console.log(`             ${r.contact_profile_url}`);
  console.log(`    channel: ${channel}   alumni: ${r.is_alumni ?? '?'}   referral_power: ${r.referral_power ?? '?'}`);
  if (r.alumni_evidence) console.log(`    evidence: ${String(r.alumni_evidence).slice(0, 200)}`);
  const already = perCompany.get(coKey(r.company)) || [];
  if (already.length) console.log(`    already contacted here: ${already.map((p) => p.name).join(', ')}`);
  for (const p of problems) console.log(`    !! ${p.cls}: ${p.why}`);
  if (msg.trim()) console.log(`    message (${msg.length} chars):\n      ${msg.replace(/\n/g, '\n      ')}`);
  if (!r.contact_name && (r.alt_targets || []).length) {
    console.log('    alt_targets:');
    for (const t of r.alt_targets.slice(0, 3)) {
      console.log(`      - ${t.name} — ${t.role}`);
      if (opts.full && t.why) console.log(`        ${String(t.why).slice(0, 220)}`);
    }
  }
  console.log('');
}
