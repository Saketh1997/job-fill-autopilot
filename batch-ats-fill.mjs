#!/usr/bin/env node
// batch-ats-fill.mjs — scan for fresh ATS postings, then fill each one and
// draft a LinkedIn contact message, serially, one posting at a time.
//
// Flow:
//   1. Snapshot data/pipeline.csv (to know what's already there)
//   2. node scan.mjs (zero-token, writes new rows to pipeline.csv)
//   3. Diff: find the rows that scan added that are ATS (greenhouse/lever/ashby)
//      and are not already applied / discarded / skip
//   4. For each new row, in order:
//      a. node Job_applicator/run_ats_batch.mjs --only <slug> [--submit]
//      b. Job_applicator/linkedin-draft.sh <slug> <company> <role> <url>
//         Headless contacto: WebSearch for the contact, draft a <=300-char
//         message, upsert it into data/linkedin-outreach-queue.json at
//         status "pending_approval". NEVER sends. Sending is a separate,
//         independently-gated step -- see Job_applicator/linkedin-send.sh
//         and linkedin-approve.sh, and the queue-file doc at the bottom of
//         this comment block.
//
// Usage:
//   node batch-ats-fill.mjs [--submit] [--days N] [--dry-run] [--limit N]
//
//   --submit      pass through to run_ats_batch.mjs (fill + submit each app)
//   --days N      look-back window for run_ats_batch (default 7)
//   --dry-run     scan only, do not fill or draft messages
//   --limit N     stop after N postings
//
// Stop cleanly:  touch Job_applicator/STOP-ATS-BATCH
//
// Exit: 0 success · 1 setup failure · 130 stopped by file
//
// LinkedIn send pipeline (draft/approve/send are three separate scripts on
// purpose -- drafting never has send capability, sending never drafts):
//   1. (this script) linkedin-draft.sh   -> queue entry, status pending_approval
//   2. n8n posts the queued entries to Discord for a human to react to
//   3. Job_applicator/linkedin-approve.sh <slug> approve|reject
//   4. Job_applicator/linkedin-send.sh <slug>   (refuses unless approved)

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const JA   = path.join(ROOT, 'Job_applicator');
const PIPELINE_CSV = path.join(ROOT, 'data', 'pipeline.csv');
const STOP  = path.join(JA, 'STOP-ATS-BATCH');
const LOG_DIR  = path.join(JA, 'logs');
const LOG_FILE = path.join(LOG_DIR, `batch-ats-fill-${new Date().toISOString().slice(0, 10)}.log`);

fs.mkdirSync(LOG_DIR, { recursive: true });

// ------------------------------------------------------------------- logging
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

// ------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opts = { submit: false, sendOutreach: false, days: 7, dryRun: false, limit: 0 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--submit')   opts.submit  = true;
  else if (a === '--send-outreach') opts.sendOutreach = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--days')    opts.days   = Number(argv[++i]);
  else if (a === '--limit')   opts.limit  = Number(argv[++i]);
  else { console.error(`unknown flag: ${a}`); process.exit(1); }
}

// ------------------------------------------------------------------- helpers
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
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
  if (!head) return [];
  return rows
    .filter((r) => r.length >= head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

function atsOf(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('greenhouse.io')) return 'greenhouse';
  if (u.includes('lever.co'))      return 'lever';
  if (u.includes('ashbyhq.com'))   return 'ashby';
  return null;
}

function slugify(company, title) {
  return execFileSync('python3', ['-c',
    `import sys;sys.path.insert(0,"${ROOT}");from jd_extract import slugify;`
    + 'print(slugify(sys.argv[1],sys.argv[2]))', company, title],
    { encoding: 'utf8', cwd: JA }).trim();
}

function urlSet(rows) {
  return new Set(rows.map((r) => (r.url || '').trim()));
}

// ------------------------------------------------------------------- OmniRoute
// Hydrate from claude_retry.sh so subprocesses (make_plan.py etc.) get the
// right base-URL and model alias — same as run_ats_batch.mjs does.
function hydrateOmniRoute() {
  let out = '';
  try {
    out = execFileSync('bash', ['-c',
      `. '${path.join(JA, 'claude_retry.sh')}' >/dev/null 2>&1; `
      + 'printf "%s\n%s\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN"'],
      { encoding: 'utf8' });
  } catch { /* ignore */ }
  const [base, token] = out.split('\n');
  if (base)  process.env.ANTHROPIC_BASE_URL  ||= base.trim();
  if (token) process.env.ANTHROPIC_AUTH_TOKEN ||= token.trim();
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ||= '1';
  process.env.PLAN_MODEL ||= 'auto/best-coding';
}
hydrateOmniRoute();

// ------------------------------------------------------------------- LinkedIn contact draft
// Headless "contacto": Job_applicator/linkedin-draft.sh runs `claude -p` with
// WebSearch (via OmniRoute) to find the hiring manager/recruiter and draft a
// <=300-char LinkedIn connection note, then upserts a queue entry into
// data/linkedin-outreach-queue.json at status "pending_approval". It NEVER
// sends anything -- that is linkedin-send.sh's job, and it refuses to run
// unless a human has flipped the queue entry to "approved" (Discord + n8n,
// via linkedin-approve.sh). This function only drafts.
function draftContactMessage(job) {
  const label = `${job.company.trim()} | ${job.title}`;
  log(`  drafting LinkedIn message: ${label}`);
  const r = spawnSync('bash', [
    path.join(JA, 'linkedin-draft.sh'),
    job.slug, job.company.trim(), job.title, job.url,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    timeout: 600000, // 10 min cap -- web search + one model call, not a browser drive
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  fs.appendFileSync(LOG_FILE,
    `\n--- linkedin-draft stdout (${job.slug}) ---\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}\n`);
  if (r.status !== 0) {
    log(`  WARNING: linkedin-draft.sh exited non-zero for ${job.slug} (queue entry may be missing or needs_review)`);
    return false;
  }
  log(`  queued for approval: ${job.slug}`);
  return true;
}

// ------------------------------------------------------------------- main
log('=== batch-ats-fill start ===');
log(`opts: submit=${opts.submit} days=${opts.days} dryRun=${opts.dryRun} limit=${opts.limit || 'none'}`);

// 1. Snapshot existing URLs so we can diff after scan
if (!fs.existsSync(PIPELINE_CSV)) {
  log('ERROR: data/pipeline.csv not found — run a scan first');
  process.exit(1);
}
const beforeRows = parseCsv(fs.readFileSync(PIPELINE_CSV, 'utf8'));
const beforeUrls = urlSet(beforeRows);
log(`pipeline snapshot: ${beforeRows.length} existing row(s)`);

// 2. Run the scanner
if (!opts.dryRun) {
  log('Running run_scan.sh …');
  const scanResult = spawnSync('bash', ['run_scan.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  if (scanResult.stdout) process.stdout.write(scanResult.stdout);
  if (scanResult.stderr) process.stderr.write(scanResult.stderr);
  fs.appendFileSync(LOG_FILE, `\n--- scan stdout ---\n${scanResult.stdout || ''}\n--- scan stderr ---\n${scanResult.stderr || ''}\n`);
  if (scanResult.status !== 0) {
    log(`run_scan.sh exited ${scanResult.status} — continuing with whatever was added`);
  } else {
    log('run_scan.sh done');
  }
} else {
  log('--dry-run: skipping scan');
}

// 3. Diff: find new ATS rows the scan added
const afterRows = parseCsv(fs.readFileSync(PIPELINE_CSV, 'utf8'));
const newRows = afterRows.filter((r) => {
  const url = (r.url || '').trim();
  if (!url) return false;
  if (beforeUrls.has(url)) return false;                           // was already there
  if (!atsOf(url)) return false;                                   // not an ATS posting
  const st = (r.status || '').toLowerCase();
  if (st === 'discarded' || st === 'skip') return false;
  if (String(r.applied).toUpperCase() === 'TRUE') return false;
  return true;
});

log(`new ATS posting(s) after scan: ${newRows.length}`);

if (!newRows.length) {
  log('nothing new to fill — exiting');
  process.exit(0);
}

// Dedup on slug (same job posted at two URLs)
const slugSeen = new Set();
const queue = [];
for (const r of newRows) {
  let slug;
  try { slug = slugify(r.company, r.title); } catch { slug = `${r.company}-${r.title}`.replace(/\s+/g, '-').toLowerCase(); }
  if (slugSeen.has(slug)) continue;
  slugSeen.add(slug);
  queue.push({ ...r, slug, ats: atsOf(r.url) });
}
log(`deduplicated queue: ${queue.length} posting(s)`);

const limit = opts.limit > 0 ? opts.limit : queue.length;
let filled = 0, contactsQueued = 0, contactsSent = 0;

// 4. Serial loop: fill → LinkedIn draft → approve & send
for (const [i, job] of queue.entries()) {
  if (i >= limit) { log(`limit ${limit} reached — stopping`); break; }
  if (fs.existsSync(STOP)) { log('STOP-ATS-BATCH present — stopping cleanly'); process.exit(130); }

  const label = `[${i + 1}/${Math.min(queue.length, limit)}] ${job.ats} ${job.company.trim()} — ${job.title}`;
  log(label);

  // 4a. Fill the application form
  if (!opts.dryRun) {
    const fillArgs = [
      path.join(JA, 'run_ats_batch.mjs'),
      '--only', job.slug,
      '--days', String(opts.days),
      '--force',      // the row is brand-new, force overrides any stale ledger entry
    ];
    if (opts.submit) fillArgs.push('--submit');

    log(`  filling: node run_ats_batch.mjs --only ${job.slug}${opts.submit ? ' --submit' : ''}`);
    const r = spawnSync('node', fillArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 2400000,   // 40 min hard cap (same as run_all_phases.sh)
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    fs.appendFileSync(LOG_FILE,
      `\n--- fill stdout (${job.slug}) ---\n${r.stdout || ''}\n--- fill stderr ---\n${r.stderr || ''}\n`);
    log(`  fill exit: ${r.status ?? 'timeout'}`);
    if (r.status !== 0) log(`  WARNING: fill step exited non-zero for ${job.slug}`);
    filled++;
  } else {
    log(`  --dry-run: would fill ${job.slug}`);
    filled++;
  }

  // 4b. LinkedIn contact message draft & send
  if (!opts.dryRun) {
    if (draftContactMessage(job)) {
      contactsQueued++;
      if (opts.sendOutreach || opts.submit) {
        log(`  approving outreach for ${job.slug}…`);
        const appr = spawnSync('bash', [path.join(JA, 'linkedin-approve.sh'), job.slug, 'approve'], {
          cwd: JA,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });
        if (appr.status === 0) {
          log(`  sending outreach for ${job.slug}…`);
          const snd = spawnSync('bash', [path.join(JA, 'linkedin-send.sh'), job.slug], {
            cwd: JA,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CDP_ENDPOINT: process.env.CDP_ENDPOINT || 'http://localhost:9226' },
          });
          if (snd.stdout) process.stdout.write(snd.stdout);
          if (snd.stderr) process.stderr.write(snd.stderr);
          if (snd.status === 0) {
            contactsSent++;
            log(`  outreach sent successfully for ${job.slug}`);
          } else {
            log(`  outreach send finished with code ${snd.status}`);
          }
        } else {
          log(`  outreach approve skipped / needs review for ${job.slug}`);
        }
      }
    }
  } else {
    log(`  --dry-run: would draft LinkedIn message for ${job.slug}`);
    contactsQueued++;
  }

  if (fs.existsSync(STOP)) { log('STOP-ATS-BATCH present — stopping after posting'); process.exit(130); }
}

log(`=== batch-ats-fill done: ${filled} filled, ${contactsQueued} drafted, ${contactsSent} sent ===`);
log(`Log: ${LOG_FILE}`);
