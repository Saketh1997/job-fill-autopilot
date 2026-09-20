#!/usr/bin/env node
// validate_setup.mjs -- is this checkout ready to run, and for whom?
//
//   node validate_setup.mjs              human-readable report
//   node validate_setup.mjs --json       machine-readable, for the setup skill
//   node validate_setup.mjs --strict     exit 1 on WARN as well as FAIL
//
// Two jobs. For a new person it is the completeness check the setup wizard runs
// between phases, so the interview can ask only for what is actually missing.
// For an existing checkout it is a pre-flight: every check below exists because
// the corresponding failure has happened and cost a run or, worse, put a wrong
// answer on a real application.
//
// Exit: 0 ready · 1 blocking problems · (--strict) 1 on warnings too.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, APP, FILES, DIRS } from './lib/paths.mjs';
import { allows, KNOWN as CONSENT_KEYS } from './lib/consent.mjs';

const opts = {
  json: process.argv.includes('--json'),
  strict: process.argv.includes('--strict'),
};

const findings = [];
const add = (level, area, msg, fix) => findings.push({ level, area, msg, fix });
const fail = (...a) => add('FAIL', ...a);
const warn = (...a) => add('WARN', ...a);
const ok   = (...a) => add('OK', ...a);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// ------------------------------------------------------------------ 1. profile
const profile = readJson(FILES.profile);
const schema = readJson(path.join(APP, 'config', 'profile.schema.json'));

if (!profile) {
  fail('profile', `no readable profile at ${FILES.profile}`,
    'run the job-applicator skill, or copy config/profile.example.json');
} else {
  for (const key of (schema?.required || [])) {
    if (!present(profile[key]) && typeof profile[key] !== 'object') {
      fail('profile', `missing required field: ${key}`, 'the setup wizard asks for this');
    }
  }
  const addr = profile.address || {};
  for (const k of ['city', 'state', 'zip', 'country']) {
    if (!present(addr[k])) fail('profile', `address.${k} is empty`, 'forms reject a partial address');
  }
  const edu = profile.education || {};
  for (const k of ['degree', 'school', 'graduated']) {
    if (!present(edu[k])) fail('profile', `education.${k} is empty`, 'asked on nearly every form');
  }
  if (present(profile.first_name) && present(profile.last_name)) {
    ok('profile', `candidate: ${profile.first_name} ${profile.last_name}`);
  }
  if (!present(profile.legal_name)) {
    warn('profile', 'no legal_name set — full-legal-name fields will fall back to first + last',
      'set legal_name if yours differs (middle names, suffixes)');
  }

  // -- resume actually exists
  if (present(profile.resume_path)) {
    const rp = profile.resume_path;
    if (fs.existsSync(rp)) {
      if (path.isAbsolute(rp) && !rp.startsWith(ROOT)) {
        warn('profile', `resume_path points outside this checkout: ${rp}`, 'move it under the repo root');
      } else ok('profile', `generic resume: ${path.basename(rp)}`);
    } else if (fs.existsSync(path.join(ROOT, path.basename(rp)))) {
      warn('profile', `resume_path ${rp} does not exist; identity.mjs will re-anchor to ${path.basename(rp)} at the repo root`,
        'update resume_path to the real location');
    } else {
      fail('profile', `resume_path does not exist: ${rp}`, 'point it at your generic resume PDF');
    }
  }

  // -- documents that are present but unusable are worse than absent: the run
  //    attaches them and the employer receives a broken file.
  for (const [name, rel] of Object.entries(profile.documents || {})) {
    if (!present(rel)) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { fail('documents', `${name} does not exist: ${rel}`); continue; }
    const size = fs.statSync(abs).size;
    if (size < 4096) {
      fail('documents', `${name} is only ${size} bytes — probably truncated: ${rel}`,
        'replace it; a corrupt attachment still gets uploaded');
    } else if (abs.toLowerCase().endsWith('.pdf')) {
      // A valid PDF ends with %%EOF. Cheap check, catches the truncation class.
      const tail = fs.readFileSync(abs).subarray(-1024).toString('latin1');
      if (!tail.includes('%%EOF')) {
        fail('documents', `${name} has no %%EOF trailer — the PDF is truncated: ${rel}`,
          'regenerate it, or point at a known-good copy');
      } else ok('documents', `${name} ok (${Math.round(size / 1024)}KB)`);
    }
  }

  // -- secrets that leak into model prompts
  if (present(profile.job_account_password)) {
    warn('secrets', 'job_account_password is stored in profile.json',
      'move it to login.env (gitignored, chmod 0600) — the whole profile is pasted into model prompts');
  }

  // -- the sponsorship branch. Both answers exist, nothing picks between them,
  //    so a form asking the employer-cannot-sponsor phrasing gets the wrong one.
  const q = profile.application_questions || {};
  const sponsorNow = q.require_sponsorship_now_or_future;
  const sponsorCant = q.require_sponsorship_when_employer_cannot_sponsor;
  if (present(sponsorNow) && present(sponsorCant) && String(sponsorNow) !== String(sponsorCant)) {
    warn('sponsorship', `two sponsorship answers disagree ("${sponsorNow}" vs "${sponsorCant}") and nothing chooses between them per form`,
      'confirm the branch on the live form before submitting; this is a known open gap');
  } else if (!present(sponsorNow)) {
    fail('sponsorship', 'no sponsorship answer set', 'every US form asks this');
  }

  if (!present(q.legally_authorized_to_work)) {
    fail('work-auth', 'application_questions.legally_authorized_to_work is empty');
  }
  if (!present(q.minimum_annual_salary) && !present(profile.salary_expectation?.default)) {
    warn('salary', 'no salary floor set', 'a form with a required salary field will block');
  }

  // -- "how did you hear about us" must only contain true answers
  const hdyh = profile.how_did_you_hear_about_us?.preference_order || [];
  const truthful = new Set(['other', 'job board', 'online search', 'company website', 'linkedin']);
  const unsupported = hdyh.filter((x) => !truthful.has(String(x).toLowerCase()));
  if (unsupported.length) {
    warn('truthfulness', `how_did_you_hear preference_order contains answers you cannot back up: ${unsupported.join(', ')}`,
      'keep only the ones that are literally true — a referral you do not have is a false statement on an application');
  }
}

// ------------------------------------------------------------------ 2. consent
const consent = readJson(FILES.consent);
if (!consent) {
  warn('consent', `no config/consent.json — nothing is authorized, the pipeline will fill and stop`,
    'copy config/consent.example.json and turn on only what you mean');
} else {
  const on = CONSENT_KEYS.filter((k) => allows(k));
  ok('consent', on.length ? `granted: ${on.join(', ')}` : 'no grants (fill-and-stop mode)');
  if (allows('outreach_auto_send') && !allows('outreach_draft')) {
    fail('consent', 'outreach_auto_send is granted but outreach_draft is not',
      'a send with no draft step has nothing to verify');
  }
  if (allows('submit_when_clean') && !consent.granted_by) {
    warn('consent', 'submit_when_clean is granted but granted_by is empty',
      'the run log should name who authorized it');
  }
}

// ------------------------------------------------------- 3. supporting content
if (!fs.existsSync(FILES.cv)) {
  warn('content', `no cv.md at ${FILES.cv}`, 'free-text answers and the fact-check gate both read it');
}
if (!fs.existsSync(FILES.contentBank)) {
  warn('content', 'no content-bank.yml', 'tailor_resume_local.mjs has no bullets to select from');
}
if (!fs.existsSync(FILES.portals)) {
  fail('search', `no portals.yml at ${FILES.portals}`, 'stage 1 has nothing to scan');
}
if (!fs.existsSync(FILES.loginEnv)) {
  warn('accounts', 'no login.env', 'portal signups and the email-code reader both need it');
} else {
  const mode = (fs.statSync(FILES.loginEnv).mode & 0o777).toString(8);
  if (mode !== '600') warn('accounts', `login.env is mode ${mode}, expected 600`, `chmod 600 ${FILES.loginEnv}`);
  else ok('accounts', 'login.env present, mode 600');
}

// ----------------------------------------------------------- 4. model providers
// There is no API key on this box and none is needed: every model call
// authenticates through the CLIs' own stored credentials. Two distinct chains,
// and confusing them is how "the model did nothing" reports start.
//
//   claude_retry.sh  MODEL_CHAIN  general calls (questions, review, plans, free text)
//                                 claude -> agy:sonnet -> agy:gemini-pro
//   agy_step.sh      AGY_CHAIN    the browser-driving fill step. Stays INSIDE agy
//                                 on purpose: falling back out to claude would put
//                                 a different driver on a half-filled form.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(process.env.HOME || '', '.local/bin/claude');
const AGY_BIN = process.env.AGY_BIN || path.join(process.env.HOME || '', '.local/bin/agy');
const MCP_BIN = process.env.PLAYWRIGHT_MCP_BIN
  || path.join(process.env.HOME || '', '.nvm/versions/node/v20.20.2/bin/playwright-mcp');

if (fs.existsSync(CLAUDE_BIN)) ok('models', `claude CLI: ${CLAUDE_BIN}`);
else fail('models', `no claude CLI at ${CLAUDE_BIN}`,
  'set CLAUDE_BIN, or install it — it is the first link in MODEL_CHAIN');

if (fs.existsSync(AGY_BIN)) {
  ok('models', `agy (Antigravity CLI): ${AGY_BIN}`);
} else {
  // Not merely a fallback: agy_step.sh drives the fill, so losing it costs the
  // whole fill stage, not just resilience when claude's quota is spent.
  fail('models', `no agy at ${AGY_BIN}`,
    'agy is the quota fallback AND the model that drives the fill step (agy_step.sh). '
    + 'Install Antigravity CLI and run `agy mcp list` to confirm the playwright server is registered');
}

if (fs.existsSync(MCP_BIN)) {
  ok('models', 'playwright-mcp present');
} else {
  fail('models', `no playwright-mcp at ${MCP_BIN}`,
    'npm i -g @playwright/mcp on the pinned Node; ats_common.py invokes it by absolute path and never falls back to PATH');
}

// Exhaustion is sticky on purpose: without it all 18 postings in a batch each
// re-pay the same failure. Stale entries are harmless, so only report live ones.
const quotaFile = process.env.QUOTA_STATE_FILE || path.join(process.env.HOME || '', '.career-ops/quota.state');
if (fs.existsSync(quotaFile)) {
  const now = Math.floor(Date.now() / 1000);
  const cooling = fs.readFileSync(quotaFile, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { const i = l.lastIndexOf('='); return [l.slice(0, i), Number(l.slice(i + 1))]; })
    .filter(([, until]) => Number.isFinite(until) && until > now);
  if (cooling.length) {
    warn('models', `provider(s) in quota cooldown: ${cooling.map(([p, u]) => `${p} until ${new Date(u * 1000).toISOString().slice(0, 16).replace('T', ' ')}`).join(', ')}`,
      `they are skipped until then; clear by hand with _cr_clear_quota, or rm ${quotaFile}`);
  } else {
    ok('models', 'no provider in quota cooldown');
  }
}

// ------------------------------------------------------------------ 4. machine
const missingDirs = Object.entries(DIRS).filter(([, d]) => !fs.existsSync(d)).map(([k]) => k);
if (missingDirs.length) {
  warn('machine', `artefact directories missing: ${missingDirs.join(', ')}`,
    'node -e "import(\'./lib/paths.mjs\').then(m=>m.ensureDirs())"');
}
const cdp = process.env.CDP_ENDPOINT || 'http://localhost:9226';
try {
  const res = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(2500) });
  const v = await res.json();
  ok('machine', `browser reachable at ${cdp} (${v.Browser})`);
} catch {
  warn('machine', `no CDP browser at ${cdp}`,
    'bash setup/install_browser_stack.sh, then systemctl --user start xvfb job-browser');
}
if (!fs.existsSync(FILES.venv)) {
  warn('machine', `no venv at ${FILES.venv}`, 'python stages import mcp from it; a bare python3 will ModuleNotFoundError');
}

// ------------------------------------------------------------------- 5. report
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

if (opts.json) {
  console.log(JSON.stringify({
    ready: fails.length === 0,
    root: ROOT,
    counts: { fail: fails.length, warn: warns.length, ok: findings.length - fails.length - warns.length },
    findings,
  }, null, 2));
} else {
  const icon = { OK: '  ok  ', WARN: ' WARN ', FAIL: ' FAIL ' };
  console.log(`career-ops setup check — ${ROOT}\n`);
  for (const f of findings) {
    console.log(`[${icon[f.level]}] ${f.area.padEnd(14)} ${f.msg}`);
    if (f.fix && f.level !== 'OK') console.log(`${' '.repeat(25)}↳ ${f.fix}`);
  }
  console.log('');
  if (fails.length) console.log(`${fails.length} blocking problem(s). Not ready to run.`);
  else if (warns.length) console.log(`Ready, with ${warns.length} warning(s).`);
  else console.log('Ready.');
}

process.exit(fails.length || (opts.strict && warns.length) ? 1 : 0);
