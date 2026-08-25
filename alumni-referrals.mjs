#!/usr/bin/env node
// alumni-referrals.mjs — find Oregon State alumni at the companies in your
// pipeline, and DRAFT a referral ask for each one.
//
//   node alumni-referrals.mjs scan    [--days 7] [--limit 15] [--only <company>] [--loose]
//   node alumni-referrals.mjs drafts  [--force]
//   node alumni-referrals.mjs queue                       # every draft as JSON
//   node alumni-referrals.mjs approve <draft-id>... | --all
//   node alumni-referrals.mjs reject  <draft-id>... | --all
//   node alumni-referrals.mjs send    [--delay 120] [--max 15] [--dry-run]
//   node alumni-referrals.mjs list
//
// `scan`, `drafts` and `queue` never touch anyone: they read the alumni
// directory and write files. `send` transmits, and ONLY the drafts whose
// `**Send:**` line says `yes`. A freshly generated draft says `no`, so the
// default state of everything on disk is "do not send".
//
// `queue` / `approve` / `reject` exist so an orchestrator (n8n -> Discord) can
// be the thing that flips that line, instead of a text editor. The gate is
// unchanged and still lives in `send`; only the approver moved.
//
// Guarantees `send` makes:
//   - never twice to the same profile. data/alumni-sent.tsv is append-only, is
//     written the instant a send succeeds (before any pause), and is consulted
//     before every send. A duplicate referral ask is the one error here that
//     cannot be taken back.
//   - one at a time, --delay seconds apart (default 120).
//   - --max per run (default 15). This matters more than the delay: LinkedIn's
//     real ceilings are daily and weekly, not per-message.
//   - the message sent is the text between the MESSAGE markers AT SEND TIME, so
//     what was approved is what goes out, edits included.
//   - a connection note over 300 chars is refused, not truncated mid-sentence.
//   - `touch STOP-ALUMNI` ends the run cleanly after the one in flight.
//
// The delay is a courtesy and a rate-limit hedge, not camouflage. LinkedIn's
// User Agreement (8.2) prohibits automated messaging and enforcement is
// account-level; pacing lowers the odds of tripping a volume limit but does not
// make automation undetectable. Approving a small number of genuinely edited
// messages is both the safer and the more effective use of this.
//
// It asks for a REFERRAL (submit my name through your internal portal), never a
// REFERENCE (vouch for work you have seen). An alum who has never worked with
// you cannot honestly give the second, and asking puts them in an awkward spot.
//
// Data written:
//   data/alumni-contacts.tsv     append-only ledger, deduped on profile URL
//   output/referral-drafts/*.md  one draft per contact, yours to edit and send
//
// Requires the shared logged-in Chrome (see Job_applicator/CLAUDE.md):
//   systemctl --user start job-browser.service     # CDP on :9226
// If LinkedIn is logged out there, the script says so and stops. Log in once by
// hand in that browser; the session persists.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PIPELINE = path.join(ROOT, 'data', 'pipeline.csv');
const LEDGER = path.join(ROOT, 'data', 'alumni-contacts.tsv');
const SENTLOG = path.join(ROOT, 'data', 'alumni-sent.tsv');
const DRAFTS = path.join(ROOT, 'output', 'referral-drafts');
const PROFILE = path.join(ROOT, 'Job_applicator', 'profile.json');
const STOP = path.join(ROOT, 'STOP-ALUMNI');
const ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9226';

// LinkedIn's first-party alumni directory. `keywords` filters the school's
// people by free text, which is how the UI itself narrows by employer.
const SCHOOL = process.env.ALUMNI_SCHOOL || 'oregon-state-university';
const alumniUrl = (company) =>
  `https://www.linkedin.com/school/${SCHOOL}/people/?keywords=${encodeURIComponent(company)}`;

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const opts = {
  days: 7, limit: 15, only: '', force: false, loose: false,
  delay: 120,      // seconds between sends
  max: 15,         // hard cap per run; LinkedIn's real limits are daily/weekly
  dryRun: false,
  all: false,
  targets: [],     // positional draft ids for `approve` / `reject`
};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--days') opts.days = Number(argv[++i]);
  else if (a === '--limit') opts.limit = Number(argv[++i]);
  else if (a === '--only') opts.only = argv[++i];
  else if (a === '--force') opts.force = true;
  else if (a === '--loose') opts.loose = true;
  else if (a === '--delay') opts.delay = Number(argv[++i]);
  else if (a === '--max') opts.max = Number(argv[++i]);
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--all') opts.all = true;
  else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(1); }
  else opts.targets.push(a);
}

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 60);

// data/pipeline.csv is quoted CSV; titles carry commas.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length >= head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ------------------------------------------------------------------- the ledger
// Append-only and deduped on profile URL: the same alum shows up under several
// postings at one employer, and contacting them twice is the failure mode here.
const LEDGER_HEAD = 'first_seen\tcompany\tname\theadline\tprofile_url\trole_applied\tdegree\tstatus';

function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').slice(1).filter(Boolean)
    .map((l) => {
      const [first_seen, company, name, headline, profile_url, role_applied, degree, status] = l.split('\t');
      return { first_seen, company, name, headline, profile_url, role_applied, degree, status };
    });
}

function appendLedger(rows) {
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, `${LEDGER_HEAD}\n`);
  const lines = rows.map((r) => [r.first_seen, r.company, r.name, r.headline,
    r.profile_url, r.role_applied, r.degree || '', r.status].join('\t'));
  fs.appendFileSync(LEDGER, `${lines.join('\n')}\n`);
}

// ------------------------------------------------------------------ sent log
// Separate, append-only, and never rewritten. The ledger gets regenerated and
// hand-edited; this file is the single source of truth for "already contacted".
// Sending the same alum a second referral ask is the one mistake in this whole
// script that cannot be undone, so the check that prevents it does not share a
// file with anything that gets rewritten.
const SENT_HEAD = 'sent_at\tprofile_url\tname\tcompany\tmethod\tchars';

function readSent() {
  if (!fs.existsSync(SENTLOG)) return [];
  return fs.readFileSync(SENTLOG, 'utf8').split('\n').slice(1).filter(Boolean)
    .map((l) => {
      const [sent_at, profile_url, name, company, method, chars] = l.split('\t');
      return { sent_at, profile_url, name, company, method, chars };
    });
}

function appendSent(r) {
  if (!fs.existsSync(SENTLOG)) fs.writeFileSync(SENTLOG, `${SENT_HEAD}\n`);
  fs.appendFileSync(SENTLOG,
    `${[r.sent_at, r.profile_url, r.name, r.company, r.method, r.chars].join('\t')}\n`);
}

// -------------------------------------------------------------------- browser
async function connect() {
  let browser;
  try {
    browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 15000 });
  } catch {
    console.error(`cannot reach Chrome on ${ENDPOINT}.\n`
      + '  systemctl --user restart job-browser.service   # then retry');
    process.exit(1);
  }
  const ctx = browser.contexts()[0];
  return { browser, page: await ctx.newPage() };
}

// A logged-out LinkedIn renders the public marketing page, which has no people
// cards — indistinguishable from "no alumni here" unless it is checked for.
async function loggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(2500);
  log(`  session check: ${page.url().slice(0, 80)}`);
  return !/\/(login|uas\/login|checkpoint|authwall|signup)/.test(page.url());
}

async function alumniAt(page, company) {
  // 'commit' (not 'domcontentloaded'): LinkedIn keeps long-lived connections
  // open, so waiting for the document to finish can outlast any sane timeout
  // even though the page is fully usable. Commit fires on first response, and
  // the explicit settle below is what actually gates on content.
  await page.goto(alumniUrl(company), { waitUntil: 'commit', timeout: 60000 });
  // The people grid arrives on a second XHR well after commit. 5s was not
  // enough and returned an empty list that looked exactly like "no alumni
  // here" — wait for the cards themselves, then scroll to pull the next batch.
  await page.waitForSelector('a[href*="/in/"]', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.mouse.wheel(0, 2500).catch(() => {});
  await page.waitForTimeout(3000);

  // The anchor wraps the whole card, so a.innerText is
  //   "Brian Le 2nd degree connection · 2nd Biology Major at Oregon State
  //    <Someone> is a mutual connection Connect"
  // Taking that verbatim as the name put an entire paragraph in the TSV. The
  // degree badge is the reliable separator: everything before it is the name,
  // everything after is the headline plus social chrome to strip.
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const DEGREE = /\s*(\d+)(?:st|nd|rd|th)\s+degree connection\s*·?\s*\d*(?:st|nd|rd|th)?\s*/i;
    const out = new Map();

    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      const url = (a.href || '').split('?')[0];
      if (!/linkedin\.com\/in\/[^/]+$/.test(url) || out.has(url)) continue;

      const text = clean(a.innerText || '');
      if (!text) continue;

      let name = text;
      let headline = '';
      // Degree decides the send path: 1st can be messaged directly, 2nd/3rd
      // can only receive a 300-char note attached to a connection request.
      let degree = '';
      const m = text.match(DEGREE);
      if (m) { name = clean(text.slice(0, m.index)); degree = m[1] || ''; }

      // Prefer the card's own subtitle element. Deriving the headline by
      // string-surgery on the card text does not work: the mutual-connection
      // sentence that follows the headline starts with a person's name, so
      // there is no delimiter between "…Software Engineer @ Nike" and "Jeff
      // Ewing … is a mutual connection", and a regex greedy enough to remove
      // the second ate the first as well (every headline came out empty).
      let card = a;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelector('.artdeco-entity-lockup__subtitle')) break;
      }
      const sub = card.querySelector('.artdeco-entity-lockup__subtitle')
        || card.querySelector('[class*="lockup__subtitle"]')
        || card.querySelector('[class*="profile-card__profile-info"] [class*="subtitle"]');
      if (sub) headline = clean(sub.innerText);

      const title = card.querySelector('.artdeco-entity-lockup__title')
        || card.querySelector('[class*="lockup__title"]');
      if (title) {
        const t = clean(title.innerText).replace(DEGREE, ' ').trim();
        if (t && t.length <= 80) name = t;
      }

      // The degree badge lives on the card, not necessarily on the anchor we
      // matched: a card carries several /in/ links and the first in DOM order
      // is often the bare title link, whose innerText is just the name. Reading
      // the badge off the anchor left every degree empty.
      if (!degree) {
        // textContent, not innerText: LinkedIn puts the full phrase ("2nd
        // degree connection") in a .visually-hidden span, which innerText
        // omits by design. Walk up a few levels because the container that
        // holds the subtitle does not always hold the badge.
        let up = card;
        for (let i = 0; i < 4 && up && !degree; i++) {
          const dm = clean(up.textContent || '').match(DEGREE);
          if (dm) degree = dm[1] || '';
          up = up.parentElement;
        }
      }
      if (!degree) {
        const badge = card.querySelector('[class*="lockup__degree"], [class*="distance-badge"]');
        const bm = clean(badge?.textContent || '').match(/(\d+)(?:st|nd|rd|th)/i);
        if (bm) degree = bm[1];
      }

      if (!name || name.length > 80 || /^\d/.test(name)) continue;
      out.set(url, { name, headline: clean(headline).slice(0, 200), profile_url: url, degree });
    }
    return [...out.values()];
  });
}

// LinkedIn's alumni `keywords` box is a full-text search over profiles, not an
// employer filter: searching "CLEAR" returned a pre-med student and a realtor.
// Keep only people whose headline actually names the employer, unless --loose.
function atCompany(person, company) {
  const hay = `${person.headline}`.toLowerCase();
  const c = company.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  if (!c) return false;
  // Match the longest distinctive token so "SHEIN U.S." still matches "Shein".
  const token = c.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  return token.length >= 3 && hay.includes(token);
}

// ----------------------------------------------------------------------- scan
async function runScan() {
  if (!fs.existsSync(PIPELINE)) { console.error(`missing ${PIPELINE}`); process.exit(1); }
  const since = new Date(Date.now() - opts.days * 86400000).toISOString().slice(0, 10);

  // One entry per company: the ask is "refer me", not "refer me five times".
  const byCompany = new Map();
  for (const r of parseCsv(fs.readFileSync(PIPELINE, 'utf8'))) {
    if ((r.date || '') < since) continue;
    if (['discarded', 'skip'].includes(String(r.status || '').toLowerCase())) continue;
    const company = (r.company || '').trim();
    if (!company) continue;
    if (opts.only && company.toLowerCase() !== opts.only.toLowerCase()) continue;
    if (!byCompany.has(company)) byCompany.set(company, r.title || '');
  }

  let companies = [...byCompany.keys()];
  const known = new Set(readLedger().map((r) => r.company.toLowerCase()));
  if (!opts.force) companies = companies.filter((c) => !known.has(c.toLowerCase()));
  companies = companies.slice(0, opts.limit);

  if (!companies.length) { log('no new companies to check'); return; }
  log(`checking ${companies.length} company(ies) for ${SCHOOL} alumni — reading only`);

  const { browser, page } = await connect();
  try {
    if (!await loggedIn(page)) {
      console.error('LinkedIn is logged out in the shared browser.\n'
        + '  Open it (x11vnc :5900 / DISPLAY=:99), sign in once by hand, then re-run.');
      process.exit(2);
    }

    const seen = new Set(readLedger().map((r) => r.profile_url));
    const fresh = [];
    for (const [i, company] of companies.entries()) {
      if (fs.existsSync(STOP)) { log('STOP-ALUMNI present — stopping'); break; }
      log(`[${i + 1}/${companies.length}] ${company}`);
      let people = [];
      try { people = await alumniAt(page, company); }
      catch (e) {
        log(`  lookup failed: ${String(e.message).split('\n')[0].slice(0, 120)}`);
        log(`  landed on: ${page.url().slice(0, 100)}`);
        log(`  title: ${(await page.title().catch(() => '?')).slice(0, 80)}`);
      }

      const relevant = opts.loose ? people : people.filter((p) => atCompany(p, company));
      if (people.length && !relevant.length && !opts.loose) {
        log(`  ${people.length} alum(s) on page, none list ${company} in their headline`);
      }
      const rows = relevant.filter((p) => !seen.has(p.profile_url)).map((p) => {
        seen.add(p.profile_url);
        return {
          first_seen: new Date().toISOString().slice(0, 10),
          company,
          name: p.name,
          headline: p.headline,
          profile_url: p.profile_url,
          role_applied: byCompany.get(company) || '',
          status: 'new',
        };
      });
      log(`  ${people.length} alum(s) on page, ${relevant.length} at ${company}, ${rows.length} new`);
      fresh.push(...rows);
      await sleep(4000 + Math.random() * 3000);   // be a polite guest
    }
    if (fresh.length) appendLedger(fresh);
    log(`done — ${fresh.length} new contact(s) -> ${path.relative(ROOT, LEDGER)}`);
    log('next:  node alumni-referrals.mjs drafts');
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// --------------------------------------------------------------------- drafts
// Deterministic template, no model call. Every factual claim comes from
// profile.json; nothing about the alum is asserted beyond what LinkedIn showed.
// Markers the send path parses. The message that goes out is whatever sits
// between them AT SEND TIME, so an edit in the file is an edit to the message —
// there is no second copy that could drift from what was approved.
const MSG_OPEN = '<!--MESSAGE-->';
const MSG_CLOSE = '<!--/MESSAGE-->';
const NOTE_CAP = 300;

function draftFor(c, me) {
  const first = (c.name || '').split(/\s+/)[0] || 'there';
  const connected = String(c.degree) === '1';
  const role = c.role_applied ? `the ${c.role_applied} role` : 'an open role';

  // 2nd/3rd degree can only be reached by a note attached to a connection
  // request, and LinkedIn hard-truncates that at 300 characters.
  const note = `Hi ${first} — fellow Beaver here (${me.school} ${me.credential}). `
    + `I applied for ${role} at ${c.company}. `
    + 'Would you be open to referring me internally? Happy to send my resume either way.';

  const dm = `Hi ${first},

I'm ${me.name}, ${me.credential} at ${me.school}. I found you through the OSU alumni
directory and saw you're at ${c.company} — I applied for ${c.role_applied || 'a role there'} recently.

A referral is a real ask from someone I haven't worked with, so no pressure: if you'd
rather point me at the right team, or tell me the posting is stale, that's genuinely
useful too. If you are open to referring me, I'll send my resume and the req number so
it takes you two minutes.

Either way, glad to connect with another Beaver.

${me.name}
${me.links}`;

  const body = connected ? dm : note;
  const method = connected ? 'message' : 'connection-note';
  const over = !connected && body.length > NOTE_CAP;

  return `# ${c.name} — ${c.company}

- **Profile:** ${c.profile_url}
- **Headline:** ${c.headline || '(none captured)'}
- **Role applied:** ${c.role_applied || '(none recorded)'}
- **Connection:** ${c.degree ? `${c.degree}${c.degree === '1' ? 'st' : c.degree === '2' ? 'nd' : 'rd'} degree` : 'unknown'}
- **Method:** ${method}${connected ? '' : ` (max ${NOTE_CAP} chars)`}
- **Length:** ${body.length}${over ? `  ⚠ OVER ${NOTE_CAP} — trim it or the send is refused` : ''}

**Send:** no

> Flip \`**Send:** no\` to \`yes\` to approve this one. \`send\` only touches
> approved drafts, waits 2 minutes between each, and never contacts the same
> person twice.

## Message — edited freely; sent verbatim

${MSG_OPEN}
${body}
${MSG_CLOSE}

---
_Nothing here has been sent. Edit before approving: a referral ask that reads
generic gets ignored, and the alum remembers the name._
`;
}

// Parse a draft back into something sendable. Returns null when it is not
// approved, so the default state of every file on disk is "do not send".
function parseDraft(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const grab = (re) => (raw.match(re) || [])[1]?.trim() || '';
  const approved = /^\*\*Send:\*\*\s*(yes|y|true)\s*$/im.test(raw);
  const i = raw.indexOf(MSG_OPEN);
  const j = raw.indexOf(MSG_CLOSE);
  if (i === -1 || j === -1 || j < i) return null;
  return {
    file,
    approved,
    profile_url: grab(/^-\s*\*\*Profile:\*\*\s*(\S+)/im),
    name: grab(/^#\s*(.+?)\s+—/im),
    company: grab(/^#\s*.+?\s+—\s*(.+)$/im),
    method: grab(/^-\s*\*\*Method:\*\*\s*([a-z-]+)/im) || 'connection-note',
    body: raw.slice(i + MSG_OPEN.length, j).trim(),
  };
}

function runDrafts() {
  const rows = readLedger().filter((r) => opts.force || r.status === 'new');
  if (!rows.length) { log('nothing to draft (run `scan` first, or pass --force)'); return; }

  let p = {};
  try { p = JSON.parse(fs.readFileSync(PROFILE, 'utf8')); } catch { /* fall back below */ }
  const me = {
    name: [p.first_name, p.last_name].filter(Boolean).join(' ')
      || p.name || p.full_name || '(set first_name in profile.json)',
    school: 'Oregon State',
    credential: (p.education?.degree) || 'MS Computer Science',
    links: [p.portfolio_url || p.website, p.linkedin_url || p.linkedin]
      .filter(Boolean).join(' · '),
  };

  fs.mkdirSync(DRAFTS, { recursive: true });
  for (const c of rows) {
    const f = path.join(DRAFTS, `${slugify(c.company)}-${slugify(c.name)}.md`);
    fs.writeFileSync(f, draftFor(c, me));
  }
  log(`wrote ${rows.length} draft(s) -> ${path.relative(ROOT, DRAFTS)}/`);
  log('review, edit, then send them yourself. This script sends nothing.');
}

// ----------------------------------------------------------------------- list
function runList() {
  const rows = readLedger();
  if (!rows.length) { log('no contacts yet — node alumni-referrals.mjs scan'); return; }
  const byCompany = new Map();
  for (const r of rows) byCompany.set(r.company, (byCompany.get(r.company) || 0) + 1);
  console.log(`${rows.length} contact(s) across ${byCompany.size} company(ies):\n`);
  for (const [company, n] of [...byCompany].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${company}`);
  }
  const drafted = fs.existsSync(DRAFTS) ? fs.readdirSync(DRAFTS).length : 0;
  console.log(`\ndrafts on disk: ${drafted} (${path.relative(ROOT, DRAFTS)}/)`);
}

// -------------------------------------------------------------- queue/approve
// The n8n-facing half of the approval gate. `queue` emits every draft as JSON so
// an orchestrator can post it for a human to look at; `approve` / `reject` flip
// the `**Send:**` line the way a hand-edit would. The gate itself does not move:
// `send` still reads that line and still refuses anything that does not say yes.
// What changes is only who writes it — a Discord reaction routed through n8n
// instead of a text editor.

const draftFiles = () => (fs.existsSync(DRAFTS) ? fs.readdirSync(DRAFTS) : [])
  .filter((f) => f.endsWith('.md'))
  .map((f) => path.join(DRAFTS, f));

// A draft id is its filename without .md ("stripe-jane-doe"). Accept the bare
// id, the filename, or a full path, so n8n can echo back whatever `queue` gave.
function resolveDraft(target) {
  const want = slugify(path.basename(String(target), '.md'));
  return draftFiles().find((f) => slugify(path.basename(f, '.md')) === want) || null;
}

function runQueue() {
  const sent = new Set(readSent().map((r) => r.profile_url));
  const out = [];
  for (const f of draftFiles()) {
    const d = parseDraft(f);
    if (!d) continue;
    out.push({
      id: path.basename(f, '.md'),
      name: d.name,
      company: d.company,
      profile_url: d.profile_url,
      method: d.method,
      chars: d.body.length,
      over_limit: d.method === 'connection-note' && d.body.length > NOTE_CAP,
      already_sent: sent.has(d.profile_url),
      status: sent.has(d.profile_url) ? 'sent'
        : d.approved ? 'approved' : 'pending_approval',
      message: d.body,
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

// decision: 'yes' approves, 'no' returns the draft to the un-sendable default.
function setApproval(decision) {
  let files;
  if (opts.all) {
    files = draftFiles();
  } else {
    if (!opts.targets.length) {
      console.error('usage: node alumni-referrals.mjs approve <draft-id>... | --all');
      process.exit(1);
    }
    files = [];
    for (const t of opts.targets) {
      const f = resolveDraft(t);
      if (!f) { console.error(`no draft matching ${t} in ${path.relative(ROOT, DRAFTS)}/`); process.exit(1); }
      files.push(f);
    }
  }

  const changed = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    // A draft already marked SENT is terminal: re-approving it is how the same
    // person gets contacted twice, which is the one error that cannot be undone.
    if (/^\*\*Send:\*\*\s*SENT\s*$/im.test(raw)) {
      log(`${path.basename(f, '.md')}: already sent — leaving as is`);
      continue;
    }
    const next = raw.replace(/^\*\*Send:\*\*\s*.*$/im, `**Send:** ${decision}`);
    if (next !== raw) fs.writeFileSync(f, next);
    changed.push(path.basename(f, '.md'));
  }
  log(`${decision === 'yes' ? 'approved' : 'un-approved'} ${changed.length} draft(s): ${changed.join(', ') || '(none)'}`);
}

const runApprove = () => setApproval('yes');
const runReject = () => setApproval('no');

// ----------------------------------------------------------------------- send
// Sends ONLY drafts whose `**Send:**` line says yes, one at a time, with a real
// pause between them, and never twice to the same profile.
//
// The delay is a courtesy and a rate-limit hedge, not camouflage: LinkedIn
// fingerprints interaction patterns, not just timing, so this reduces the
// chance of tripping a volume limit but does not make automation invisible.
// The daily cap matters more — LinkedIn's real ceilings are daily and weekly.

async function sendConnectionNote(page, text) {
  // "Connect" is sometimes behind the More menu on 2nd/3rd-degree profiles.
  let btn = page.locator('button:has-text("Connect")').first();
  if (!(await btn.count())) {
    await page.locator('button:has-text("More")').first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);
    btn = page.locator('div[role="menu"] :text("Connect")').first();
  }
  if (!(await btn.count())) return { ok: false, why: 'no Connect button (already connected or pending?)' };
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(1400);

  const addNote = page.locator('button:has-text("Add a note")').first();
  if (await addNote.count()) { await addNote.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(900); }

  const box = page.locator('textarea[name="message"], textarea#custom-message').first();
  if (!(await box.count())) return { ok: false, why: 'no note textarea (invite limit reached?)' };
  await box.click({ timeout: 8000 }).catch(() => {});
  await box.type(text, { delay: 12 });
  await page.waitForTimeout(500);

  const readBack = await box.inputValue().catch(() => '');
  if (readBack.trim().slice(0, 40) !== text.trim().slice(0, 40)) {
    return { ok: false, why: 'note did not take the text' };
  }
  const send = page.locator('button:has-text("Send invitation"), button:has-text("Send")').first();
  if (!(await send.count())) return { ok: false, why: 'no Send button' };
  await send.click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const stillOpen = await page.locator('textarea[name="message"]').count();
  return stillOpen ? { ok: false, why: 'dialog still open after Send' } : { ok: true };
}

async function sendMessage(page, text) {
  const btn = page.locator('button:has-text("Message")').first();
  if (!(await btn.count())) return { ok: false, why: 'no Message button' };
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(1800);

  const box = page.locator('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]').first();
  if (!(await box.count())) return { ok: false, why: 'no message composer' };
  await box.click({ timeout: 8000 }).catch(() => {});
  await box.type(text, { delay: 10 });
  await page.waitForTimeout(600);

  const typed = (await box.innerText().catch(() => '')).trim();
  if (typed.slice(0, 40) !== text.trim().slice(0, 40)) {
    return { ok: false, why: 'composer did not take the text' };
  }
  const send = page.locator('button.msg-form__send-button, button:has-text("Send")').first();
  if (!(await send.count()) || !(await send.isEnabled().catch(() => false))) {
    return { ok: false, why: 'Send button missing or disabled' };
  }
  await send.click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  return { ok: true };
}

async function runSend() {
  if (!fs.existsSync(DRAFTS)) { console.error('no drafts — run `scan` then `drafts`'); process.exit(1); }

  const drafts = fs.readdirSync(DRAFTS).filter((f) => f.endsWith('.md'))
    .map((f) => parseDraft(path.join(DRAFTS, f))).filter(Boolean);
  const approved = drafts.filter((d) => d.approved);
  const already = new Set(readSent().map((r) => r.profile_url));
  const queue = approved.filter((d) => d.profile_url && !already.has(d.profile_url));

  const skipped = approved.length - queue.length;
  log(`${drafts.length} draft(s), ${approved.length} approved, `
    + `${skipped} already contacted, ${queue.length} to send`);
  if (!queue.length) { log('nothing to send'); return; }

  // Refuse over-length connection notes rather than letting LinkedIn truncate
  // the ask into nonsense mid-sentence.
  const over = queue.filter((d) => d.method === 'connection-note' && d.body.length > NOTE_CAP);
  for (const d of over) log(`  REFUSED ${d.name}: note is ${d.body.length} chars (max ${NOTE_CAP}) — trim it`);
  const sendable = queue.filter((d) => !over.includes(d)).slice(0, opts.max);

  log(`sending ${sendable.length} (cap ${opts.max}/run, ${opts.delay}s between)`
    + `${opts.dryRun ? ' — DRY RUN, nothing will be sent' : ''}`);

  const { browser, page } = await connect();
  try {
    if (!await loggedIn(page)) { console.error('LinkedIn is logged out'); process.exit(2); }

    for (const [i, d] of sendable.entries()) {
      if (fs.existsSync(STOP)) { log('STOP-ALUMNI present — stopping'); break; }
      log(`[${i + 1}/${sendable.length}] ${d.name} (${d.company}) via ${d.method}, ${d.body.length} chars`);

      if (opts.dryRun) { log('  dry run — skipped'); continue; }

      await page.goto(d.profile_url, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(4000);

      // Adaptive rather than trusting the degree captured at scan time.
      // LinkedIn's degree badge sits in a visually-hidden span whose markup
      // moves around, so scan-time detection is best-effort — but the profile
      // page itself is unambiguous: a Connect button means not connected, and
      // its absence means already connected (or invite pending). Deciding here,
      // against the live page, is correct regardless of what the scan recorded.
      let res;
      try {
        res = d.method === 'message'
          ? await sendMessage(page, d.body)
          : await sendConnectionNote(page, d.body);
        if (!res.ok && /no Connect button/i.test(res.why || '')) {
          log('  no Connect button — already connected, sending as a message');
          res = await sendMessage(page, d.body);
          if (res.ok) d.method = 'message';
        }
      } catch (e) {
        res = { ok: false, why: String(e.message).split('\n')[0].slice(0, 120) };
      }

      if (res.ok) {
        // Written the instant it succeeds, before any pause, so a crash mid-run
        // can never replay a send that already happened.
        appendSent({
          sent_at: new Date().toISOString(),
          profile_url: d.profile_url,
          name: d.name,
          company: d.company,
          method: d.method,
          chars: String(d.body.length),
        });
        fs.writeFileSync(d.file,
          fs.readFileSync(d.file, 'utf8').replace(/^\*\*Send:\*\*\s*.*$/im, '**Send:** SENT'));
        log('  sent');
      } else {
        log(`  NOT sent: ${res.why}`);
      }

      if (i < sendable.length - 1) {
        log(`  waiting ${opts.delay}s`);
        await sleep(opts.delay * 1000);
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  log(`done — sent log: ${path.relative(ROOT, SENTLOG)}`);
}

// ---------------------------------------------------------------------- debug
// LinkedIn reshuffles its DOM often; this prints what the page actually served
// so the extractor can be re-pointed without guessing.
async function runDebug() {
  const company = opts.only || 'Nvidia';
  const { browser, page } = await connect();
  try {
    if (!await loggedIn(page)) { console.error('logged out'); process.exit(2); }
    const url = alumniUrl(company);
    log(`navigating: ${url}`);
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(3000);
    log(`landed: ${page.url()}`);
    log(`title:  ${await page.title().catch(() => '?')}`);
    const info = await page.evaluate(() => ({
      inLinks: document.querySelectorAll('a[href*="/in/"]').length,
      orgPeople: document.querySelectorAll('[class*="org-people"]').length,
      profileCards: document.querySelectorAll('[class*="profile-card"], [data-view-name*="profile"]').length,
      bodyStart: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    }));
    console.log(JSON.stringify(info, null, 2));
    const shot = path.join(ROOT, 'output', 'alumni-debug.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    log(`screenshot: ${path.relative(ROOT, shot)}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ----------------------------------------------------------------------- main
const cmds = {
  scan: runScan, drafts: runDrafts, send: runSend, list: runList, debug: runDebug,
  queue: runQueue, approve: runApprove, reject: runReject,
};
if (!cmds[cmd]) {
  console.error('usage: node alumni-referrals.mjs '
    + '<scan|drafts|queue|approve|reject|send|list|debug> [flags]');
  process.exit(1);
}
await cmds[cmd]();
