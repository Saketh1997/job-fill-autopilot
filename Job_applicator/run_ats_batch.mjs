#!/usr/bin/env node
// run_ats_batch.mjs — drive every Greenhouse / Lever / Ashby posting from a
// window of data/pipeline.csv through the full three-stage chain, one posting at
// a time.
//
//   node run_ats_batch.mjs [--days 7] [--since YYYY-MM-DD] [--limit N]
//                          [--ats greenhouse,lever,ashby] [--only <slug>]
//                          [--plan-only] [--submit] [--force]
//
// By default it never submits: every posting ends filled, verified and waiting
// in its own open tab, and the Submit click belongs to ats_submit.mjs so a form
// is reviewable before it becomes an application.
//
// --submit hands each posting to ats_submit.mjs the moment it is filled and
// clean, instead of parking it. The gate itself is unchanged — ats_submit.mjs
// re-audits the live form and still refuses on an empty required field, a
// validation error, a generic resume or a CAPTCHA. Submitting also closes the
// tab, which is what keeps a 100-posting run from ending as a dead browser.
//
// This is an orchestrator, not a driver: every decision about what goes on a
// form still belongs to the per-ATS driver and to make_plan.py. What this owns
// is everything that makes a 60-posting unattended run survivable:
//
//   - one posting at a time, never parallel. Steps 4+ of the runbook touch an
//     employer's site.
//   - a resumable ledger (logs/ats-batch-ledger.json). A run that dies at
//     posting 30 restarts at 30, and a posting that already submitted is never
//     touched again — a duplicate application is the one error here that cannot
//     be taken back.
//   - a hard timeout per step. The drivers carry their own graceful watchdog;
//     this is the backstop for a wedged event loop.
//   - browser health checked (and the unit restarted) between postings, because
//     one crashed Chrome would otherwise fail every remaining posting.
//   - tab pruning. Sixty postings leaking a tab each is a dead browser.
//   - a stop file. `touch STOP-ATS-BATCH` ends the run cleanly after the posting
//     in flight, rather than killing it mid-form.
//
// Exit: 0 the queue was worked through · 1 setup failure · 130 stopped by file.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveGreenhouseEmbed, GH_EMBED_GONE } from './ats_apply_common.mjs';

const BASE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(BASE, '..');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.csv');
const LEDGER = path.join(BASE, 'logs', 'ats-batch-ledger.json');
const STOP = path.join(BASE, 'STOP-ATS-BATCH');
const ENDPOINT = process.env.CDP_ENDPOINT || 'http://localhost:9226';

// ------------------------------------------------------------------ OmniRoute
// Every model call in this pipeline goes through OmniRoute. The steps that
// shell out through claude_retry.sh set the vars themselves, but make_plan.py
// and map_fields.mjs are plain children: they inherit whatever environment the
// batch was launched with, and `node run_ats_batch.mjs` from a bare shell has
// nothing. make_plan.py then fell open to a deterministic-only plan (0s, exit
// 0, no model pass) — the reason a whole run's worth of fields came back "no
// planned value". Source claude_retry.sh instead of re-declaring the URL and
// token here, so exactly one file knows them.
function hydrateModelRouting() {
  let out = '';
  try {
    out = execFileSync('bash', ['-c',
      `. '${path.join(BASE, 'claude_retry.sh')}' >/dev/null 2>&1; `
      + 'printf "%s\\n%s\\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN"'],
      { encoding: 'utf8' });
  } catch { /* handled by the empty check below */ }
  const [base, token] = out.split('\n');
  if (base) process.env.ANTHROPIC_BASE_URL ||= base.trim();
  if (token) process.env.ANTHROPIC_AUTH_TOKEN ||= token.trim();
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ||= '1';
  // make_plan.py's own default is a first-party model id, which OmniRoute does
  // not serve. Pointing the base URL at OmniRoute without also moving the model
  // onto a routed alias just trades a silent fallback for a 404.
  process.env.PLAN_MODEL ||= 'claude-sonnet-5';
  // A missing token is now the NORMAL case: the pipeline talks to the real API
  // through the claude CLI's own stored credentials, and claude_retry.sh
  // deliberately withholds the OmniRoute token unless the base URL is OmniRoute.
  // Only a missing base URL is worth warning about.
  if (!process.env.ANTHROPIC_BASE_URL) {
    console.error('WARNING: no ANTHROPIC_BASE_URL from claude_retry.sh —'
      + ' make_plan.py will fall open to a deterministic-only plan');
  }
}
hydrateModelRouting();

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const opts = {
  days: 7, since: '', limit: 0, only: '',
  ats: ['greenhouse', 'lever', 'ashby'],
  planOnly: false, force: false, submit: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--days') opts.days = Number(argv[++i]);
  else if (a === '--since') opts.since = argv[++i];
  else if (a === '--limit') opts.limit = Number(argv[++i]);
  else if (a === '--only') opts.only = argv[++i];
  else if (a === '--ats') opts.ats = argv[++i].split(',').map((s) => s.trim());
  else if (a === '--plan-only') opts.planOnly = true;
  else if (a === '--submit') opts.submit = true;
  else if (a === '--force') opts.force = true;
  else { console.error(`unknown flag: ${a}`); process.exit(1); }
}

const today = new Date();
const since = opts.since
  || new Date(today.getTime() - opts.days * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------- utils
const log = (...m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(BASE, 'logs', 'ats-batch.log'), `${line}\n`);
};

function atsOf(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('greenhouse.io')) return 'greenhouse';
  if (u.includes('lever.co')) return 'lever';
  if (u.includes('ashbyhq.com')) return 'ashby';
  // Workday tenants are per-company subdomains (gm.wd5, pnc.wd5, ...), so the
  // ATS is the domain, not the org. workday_jd.py emits a discover-on-page
  // schema because the wizard is account-walled and publishes no field list.
  if (u.includes('myworkdayjobs.com') || u.includes('myworkdaysite.com')) return 'workday';
  return null;
}

// Only a candidate who actually needs sponsorship is filtered by the JD's
// no-sponsorship language, so this reads the profile rather than assuming.
const needsSponsorship = (() => {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8'));
    const hay = JSON.stringify(pj.work_authorization || pj.visa_status || pj).toLowerCase();
    return /\bopt\b|\bcpt\b|f-1|h-?1b|require[sd]? sponsorship|will require sponsorship/.test(hay);
  } catch { return false; }
})();

// Deliberately narrow: it must match an employer REFUSING sponsorship, never a
// posting that merely mentions the word. "We sponsor H-1B visas" and "visa
// sponsorship available" must not trip it, so every branch needs an explicit
// negation attached to the sponsoring verb.
//
// Refusing to sponsor is NOT by itself a reason to skip (narrowed 2026-09-05).
// Saketh is on F-1 OPT with an EAD and is work-authorized for ~3 years with no
// sponsorship at all (OPT + STEM OPT extension), so "we cannot sponsor a visa"
// is a question he answers No to and still applies -- that is exactly what
// CLAUDE.md's sponsorship rule prescribes. Skipping those cost real
// applications: of 74 cached JDs matching the bar, only 21 named OPT/F-1.
// The skip now requires the JD to exclude HIS status by name.
const SPONSORSHIP_BAR = new RegExp([
  'do not apply .{0,120}?sponsor',
  '(does|do|will|can) ?not (provide|offer|sponsor|support)[^.]{0,60}(sponsor|visa|immigration)',
  '(are |is )?(not able|unable) to (provide|offer|sponsor|support)[^.]{0,60}(sponsor|visa|immigration)',
  'no (visa |immigration )?sponsorship (is )?(available|provided|offered)',
  'not (provide|offer) sponsorship',
].join('|'), 'i');

// Employers that rule out OPT/CPT/F-1 itself, not merely H-1B sponsorship.
// Veeva ("no sponsorship for H-1B, OPT, or TN status") excludes him today;
// Garner Health ("unable to sponsor an employment visa at this time") does not.
const STATUS_BAR = /\b(OPT|CPT|F-1|F1)\b|practical training/i;

function sponsorshipBarred(jdPath) {
  try {
    const jd = fs.readFileSync(jdPath, 'utf8');
    return SPONSORSHIP_BAR.test(jd) && STATUS_BAR.test(jd);
  } catch { return false; }
}

// data/pipeline.csv is quoted CSV; titles carry commas.
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
  return rows.filter((r) => r.length >= head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// The one slug function every stage shares, so the batch cannot disagree with
// the drivers about which posting a slug means.
function slugify(company, title) {
  return execFileSync('python3', ['-c',
    'import sys;sys.path.insert(0,"' + ROOT + '");from jd_extract import slugify;'
    + 'print(slugify(sys.argv[1],sys.argv[2]))', company, title],
  { encoding: 'utf8' }).trim();
}

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const hasBytes = (p) => { try { return fs.statSync(p).size > 0; } catch { return false; } };

// ---------------------------------------------------------------- the browser
// A dead Chrome fails every remaining posting identically and instantly, which
// is the difference between "batch found 8 closed postings" and "batch produced
// 60 identical meaningless failures". Check it, restart it, wait for the port.
function browserUp() {
  const r = spawnSync('curl', ['-s', '-m', '5', `${ENDPOINT}/json/version`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('Browser');
}

function ensureBrowser() {
  if (browserUp()) return true;
  log('CDP endpoint is down — restarting job-browser.service');
  spawnSync('systemctl', ['--user', 'restart', 'job-browser.service'], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {                 // the port takes ~10s to bind
    spawnSync('sleep', ['1']);
    if (browserUp()) { log('browser is back'); return true; }
  }
  log('browser did not come back');
  return false;
}

// Every posting leaves its tab open on purpose now — that tab IS the filled
// application, and closing it throws the work away. So pruning may only touch
// tabs that belong to no pending application: a posting this batch failed on,
// or something left over from an older run.
function pendingUrls() {
  const keep = new Set();
  for (const rec of Object.values(ledger)) {
    if (rec.result === 'awaiting-approval' || rec.result === 'blocked') {
      keep.add((rec.resolved_url || rec.url || '').split('?')[0].replace(/\/$/, ''));
    }
  }
  const dir = path.join(BASE, 'answers');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.drive.json')) continue;
    const st = readJson(path.join(dir, f), {});
    if (st && !st.submitted && (st.apply_url || st.url)) {
      keep.add((st.apply_url || st.url).split('?')[0].replace(/\/$/, ''));
    }
  }
  return keep;
}

function pruneTabs() {
  const r = spawnSync('curl', ['-s', '-m', '5', `${ENDPOINT}/json/list`], { encoding: 'utf8' });
  const targets = readJson(r.stdout || '[]', []) || [];
  const keep = pendingUrls();
  const isPending = (u) => {
    const bare = (u || '').split('?')[0].replace(/\/$/, '');
    for (const k of keep) if (k && (bare.startsWith(k) || k.startsWith(bare))) return true;
    return false;
  };
  const doomed = targets.filter((t) => t.type === 'page'
    && /greenhouse\.io|lever\.co|ashbyhq\.com/.test(t.url || '')
    && !isPending(t.url));
  for (const t of doomed) {
    spawnSync('curl', ['-s', '-m', '5', `${ENDPOINT}/json/close/${t.id}`], { stdio: 'ignore' });
  }
  if (doomed.length) log(`pruned ${doomed.length} ATS tab(s) with no pending application`);
  return doomed.length;
}

// ------------------------------------------------------------------ step runs
function step(name, cmd, args, { timeout, slug, cwd = BASE }) {
  const logFile = path.join(BASE, 'logs', `${slug}-batch.log`);
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CDP_ENDPOINT: ENDPOINT },
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const out = `\n===== ${name} (${new Date().toISOString()}, ${secs}s, exit ${r.status})\n`
    + `$ ${cmd} ${args.join(' ')}\n${r.stdout || ''}\n${r.stderr || ''}`;
  fs.appendFileSync(logFile, out);
  const killed = r.signal || (r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message)));
  return {
    ok: r.status === 0 && !killed,
    code: killed ? 124 : r.status,
    secs,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400),
  };
}

// ------------------------------------------------------------------- the work
fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });
if (fs.existsSync(STOP)) fs.unlinkSync(STOP);

const ledger = readJson(LEDGER, {});
const saveLedger = () => fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);

const allRows = parseCsv(fs.readFileSync(PIPELINE, 'utf8'));
let queue = allRows
  .filter((r) => (r.date || '') >= since)
  .filter((r) => opts.ats.includes(atsOf(r.url)))
  .filter((r) => String(r.applied).toUpperCase() !== 'TRUE')
  // A posting the candidate has ruled out. Marked in pipeline.csv rather
  // than in the ledger, because the ledger is rewritten by every run and a
  // decision has to outlive that. Never faked as 'submitted' — a row that
  // claims an application that was never sent poisons every later count.
  .filter((r) => !['discarded', 'skip'].includes(String(r.status || '').toLowerCase()))
  .map((r) => ({ ...r, ats: atsOf(r.url), slug: slugify(r.company, r.title) }));

// One posting can appear twice in a scan window under two URLs. The slug is the
// identity everything else keys off, so collapse on it here rather than
// discovering the duplicate as a second application.
const seen = new Set();
queue = queue.filter((r) => (seen.has(r.slug) ? false : seen.add(r.slug)));
if (opts.only) queue = queue.filter((r) => r.slug === opts.only);
if (!opts.force) {
  queue = queue.filter((r) => {
    const done = ledger[r.slug];
    if (done && (done.result === 'submitted' || done.result === 'closed')) return false;
    return !hasBytes(path.join(BASE, 'answers', `${r.slug}.drive.json`))
      || readJson(path.join(BASE, 'answers', `${r.slug}.drive.json`), {}).submitted !== true;
  });
}
if (opts.limit) queue = queue.slice(0, opts.limit);

log(`queue: ${queue.length} posting(s) since ${since} (${opts.ats.join('/')}) `
  + `— ${opts.planOnly ? 'plan only, no browser'
    : opts.submit ? 'fill, then submit each one as it comes clean'
      : 'fill only; approval and Submit are ats_submit.mjs'}`);
if (!queue.length) { log('nothing to do'); process.exit(0); }

const tally = { ready: 0, submitted: 0, blocked: 0, failed: 0, skipped: 0, closed: 0 };
let stopped = false;

for (const [i, job] of queue.entries()) {
  if (fs.existsSync(STOP)) { log('STOP-ATS-BATCH present — stopping cleanly'); stopped = true; break; }

  const { slug, ats } = job;
  const head = `[${i + 1}/${queue.length}] ${ats} ${job.company.trim()} — ${job.title}`;
  log(head);
  const rec = ledger[slug] = {
    slug, ats, company: job.company.trim(), title: job.title, url: job.url,
    started: new Date().toISOString(), stage: 'start', result: 'running', notes: [],
  };
  saveLedger();

  const fail = (stage, note) => {
    rec.stage = stage; rec.result = 'failed'; rec.notes.push(note);
    rec.finished = new Date().toISOString();
    tally.failed++; saveLedger(); log(`  FAILED at ${stage}: ${note}`);
  };

  try {
    // Greenhouse embed URLs carry no board slug. Resolve once here so the
    // schema fetch and the driver both address the same canonical posting.
    let url = job.url;
    if (ats === 'greenhouse' && /\/embed\/job_app/.test(url)) {
      url = await resolveGreenhouseEmbed(url);
      // The posting itself is gone. Normal attrition, not a failure to fix.
      if (url === GH_EMBED_GONE) {
        rec.stage = 'resolve'; rec.result = 'closed';
        rec.notes.push('the embed URL 404s — the posting has been taken down');
        rec.finished = new Date().toISOString();
        tally.closed++; saveLedger(); log('  posting is gone (404) — skipping');
        continue;
      }
      if (/\/embed\/job_app/.test(url)) { fail('resolve', 'embed URL could not be resolved to a board'); continue; }
      rec.resolved_url = url;
      log(`  resolved embed -> ${url}`);
    }

    // 1. JD (stage 1). Cheap, cached, and every later stage reads it.
    const jd = path.join(BASE, 'jd', `${slug}.txt`);
    if (!hasBytes(jd)) {
      rec.stage = 'jd';
      const r = step('get_jd', './get_jd.sh', [slug], { timeout: 240000, slug });
      if (!hasBytes(jd)) { fail('jd', `get_jd.sh exit ${r.code}: ${r.stderr}`); continue; }
    }

    // 1b. Eligibility. Only postings that rule out OPT/F-1 BY NAME — GM, ZOLL
    //     and Veeva all do — are skipped. An employer that merely declines to
    //     sponsor a visa is still a valid target: the candidate needs no
    //     sponsorship for ~3 years, answers that question No, and applies.
    //     Checked here rather than in the question pass because it should cost
    //     nothing and stop the run before the resume and two model calls are
    //     paid for.
    if (needsSponsorship && sponsorshipBarred(jd)) {
      rec.stage = 'eligibility';
      rec.result = 'skipped';
      rec.notes.push('the JD rules out OPT/F-1 status by name, which is the candidate\'s actual status');
      rec.finished = new Date().toISOString();
      tally.skipped++; saveLedger();
      log('  JD rules out OPT/F-1 status by name — skipping');
      continue;
    }

    // 2. Form schema. Greenhouse and Lever expose one; Ashby's API 401s and its
    //    fetcher writes a "discover on page" marker, which is still required —
    //    preflight refuses to start without the file.
    const schema = path.join(BASE, 'schema', `${slug}.json`);
    if (!hasBytes(schema)) {
      rec.stage = 'schema';
      const r = step('schema', 'python3', [`${ats}_jd.py`, url, slug], { timeout: 180000, slug });
      if (!hasBytes(schema)) { fail('schema', `${ats}_jd.py exit ${r.code}: ${r.stderr}`); continue; }
    }

    // 3. Tailored resume (stage 2). Runs BEFORE make_plan.py, which records
    //    which PDF is going on the form. A generic resume blocks submit, so a
    //    failure here is worth a retry before giving up on the posting.
    const resume = path.join(BASE, 'resumes', `${slug}.pdf`);
    if (!hasBytes(resume)) {
      rec.stage = 'resume';
      let r = step('tailor', './tailor_resume.sh', [slug], { timeout: 1200000, slug });
      if (!hasBytes(resume)) {
        log('  tailoring failed once, retrying');
        r = step('tailor-retry', './tailor_resume.sh', [slug], { timeout: 1200000, slug });
      }
      if (!hasBytes(resume)) { fail('resume', `tailor_resume.sh exit ${r.code}: ${r.stderr}`); continue; }
    }

    // 4. Plan. Deterministic first, one model call for the free text.
    const plan = path.join(BASE, 'plans', `${slug}.json`);
    if (!hasBytes(plan)) {
      rec.stage = 'plan';
      const r = step('plan', 'python3', ['make_plan.py', slug], { timeout: 900000, slug });
      if (!hasBytes(plan)) { fail('plan', `make_plan.py exit ${r.code}: ${r.stderr}`); continue; }
    }

    if (opts.planOnly) {
      rec.stage = 'plan'; rec.result = 'planned'; rec.finished = new Date().toISOString();
      tally.skipped++; saveLedger(); log('  planned (--plan-only)'); continue;
    }

    // 5. The driver. Everything above this line is local; this is the step that
    //    touches an employer's site, so it runs alone, with a health-checked
    //    browser and a hard timeout on top of the driver's own watchdog.
    if (!ensureBrowser()) { fail('browser', 'CDP endpoint unavailable'); break; }
    pruneTabs();

    rec.stage = 'apply';
    // No --submit. The driver fills and stops; ats_submit.mjs owns the click.
// Two model calls per posting now (questions + review), and a big form is a
// big prompt twice: DRW answered 49 questions and then reviewed 74 fields,
// and 780s killed it mid-review. The driver's own watchdog stays inside the
// batch's hard timeout so the graceful path still wins.
    const args = [`${ats}_apply.mjs`, slug, '--timeout', '1500'];
    if (opts.force) args.push('--force');
    const r = step('apply', 'node', args, { timeout: 1800000, slug });

    const status = readJson(path.join(BASE, 'answers', `${slug}.drive.json`), {});
    rec.finished = new Date().toISOString();
    rec.exit = r.code;
    rec.blocked_on = status.blocked_on || [];
    rec.left_for_human = status.left_for_human || [];
    rec.model_cost_usd = status.model_cost_usd;

    if (status.awaiting_submit) {
      rec.result = 'awaiting-approval';
      rec.verified = (status.verified || []).length;
      tally.ready++;
      log(`  READY — ${rec.verified} field(s) verified, tab open for review`);

      // --submit: hand it straight to stage 4 rather than parking it. The
      // approval gate does not disappear — ats_submit.mjs re-audits the LIVE
      // form before it clicks, and still refuses on an empty required field, a
      // validation error, a generic resume or a CAPTCHA. What changes is only
      // who waits: submitting here also closes the tab, which is what makes a
      // 100-posting run survivable at all.
      if (opts.submit) {
        rec.stage = 'submit';
        const s = step('submit', 'node', ['ats_submit.mjs', slug, '--yes'], { timeout: 300000, slug });
        const after = readJson(path.join(BASE, 'answers', `${slug}.drive.json`), {});
        if (after.submitted) {
          rec.result = 'submitted';
          rec.submitted_at = after.submitted_at || new Date().toISOString();
          tally.ready--; tally.submitted++;
          log('  SUBMITTED');
        } else {
          // ats_submit.mjs talks on stderr, so a stdout-only search reported
          // every refusal as a bare "exit 2" and threw away the reason.
          const said = `${s.stdout}\n${s.stderr}`;
          // The reason lives on the line that names the slug ("SUBMIT: <slug>:
          // not clean — ..."), so filtering those out left only "exit 2". Drop
          // just the tally line, which is the one that carries no information.
          const why = (said.match(/SUBMIT: [^\n|]*/g) || [])
            .filter((l) => !/^SUBMIT: submitted \d/.test(l))
            .map((l) => l.replace(/^SUBMIT: [\w.-]+?: /, ''))
            .slice(-2).join(' | ').slice(0, 220);
          rec.submit_blocked = why || `ats_submit exit ${s.code}`;
          log(`  filled but NOT submitted: ${rec.submit_blocked}`);
        }
      }
    } else if ((rec.blocked_on[0] || '').match(/posting may be closed|no #?application-form|no application form/i)) {
      rec.result = 'closed'; tally.closed++; log(`  posting looks closed: ${rec.blocked_on[0]}`);
    } else if (rec.blocked_on.length) {
      rec.result = 'blocked'; tally.blocked++;
      log(`  BLOCKED (${rec.blocked_on.length}): ${rec.blocked_on[0].slice(0, 160)}`);
    } else {
      rec.result = 'failed'; tally.failed++;
      log(`  no usable status written; driver exit ${r.code}: ${r.stderr}`);
    }
    saveLedger();
  } catch (e) {
    fail(rec.stage, `orchestrator error: ${String(e.message || e).slice(0, 200)}`);
  }
}

pruneTabs();
log(`done — submitted ${tally.submitted}, ready for approval ${tally.ready}, blocked ${tally.blocked}, `
  + `closed ${tally.closed}, failed ${tally.failed}, other ${tally.skipped}`);
log(`ledger: ${LEDGER}`);
if (tally.ready) log(`review and submit:  node ats_submit.mjs --list   then   node ats_submit.mjs <slug>`);
process.exit(stopped ? 130 : 0);
