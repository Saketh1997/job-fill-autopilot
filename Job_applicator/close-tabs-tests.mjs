#!/usr/bin/env node

/**
 * close-tabs-tests.mjs — regression tests for close_tabs.sh tab selection.
 *
 * close_tabs.sh used to match by HOST. Every embedded Greenhouse form shares one
 * URL shape (job-boards.greenhouse.io/embed/job_app?for={org}&token={id}), so
 * the first posting to finish cleanly closed every OTHER posting's parked form.
 * It destroyed the 2026-08-26 batch and then six reviewed-pending forms in the
 * 2026-08-29 batch before anyone noticed, because the .review.txt sheets survive
 * and the damage only surfaces as "no open tab" on the NEXT posting.
 *
 * Nothing tested it. These pin the contract that replaced it (PIPELINE.md 14.14):
 *   - a finishing posting closes its own tab and nothing else
 *   - the same posting is recognised across its URL forms (embed token, board
 *     path id, employer gh_jid) — a run legitimately moves between them
 *   - a URL carrying no posting id closes NOTHING (leaking a tab is cheap,
 *     over-matching destroys a filled application)
 *   - --host-wide still sweeps, for a human cleaning up
 *   - selection failure closes nothing rather than guessing
 *
 * A stub CDP server serves /json/list, so no browser is required.
 */

import { execFileSync } from 'child_process';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const BASE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(BASE, 'close_tabs.sh');

const TABS = [
  { type: 'page', id: 'ht', url: 'https://job-boards.greenhouse.io/hightouch/jobs/6174215004' },
  { type: 'page', id: 'tg', url: 'https://job-boards.greenhouse.io/togetherai/jobs/5223190007' },
  { type: 'page', id: 'rb', url: 'https://job-boards.greenhouse.io/embed/job_app?for=roblox&token=8060254' },
  { type: 'page', id: 'hp', url: 'https://job-boards.greenhouse.io/embed/job_app?for=hpiq&token=6173700004' },
  { type: 'page', id: 'tw', url: 'https://job-boards.greenhouse.io/embed/job_app?for=twitch&token=8751076002' },
  { type: 'page', id: 'nt', url: 'https://jobs.ashbyhq.com/netic/6f1d2c34-1111-4a2b-9c3d-abcdef123456' },
  { type: 'page', id: 'ot', url: 'https://jobs.ashbyhq.com/other/99999999-2222-4a2b-9c3d-fedcba654321' },
  // a decoy whose token is the digit tail of netic's uuid
  { type: 'page', id: 'dc', url: 'https://jobs.ashbyhq.com/decoy/job?token=123456' },
  { type: 'page', id: 'bl', url: 'about:blank' },
  { type: 'other', id: 'sw', url: 'https://job-boards.greenhouse.io/sw.js' },
];

let passed = 0;
let failed = 0;

function check(name, got, want) {
  const g = JSON.stringify([...got].sort());
  const w = JSON.stringify([...want].sort());
  if (g === w) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n         want ${w}\n         got  ${g}`);
  }
}

// The stub CDP must be a SEPARATE PROCESS: the assertions below use
// execFileSync, which blocks this process's event loop, so an in-process
// server would never accept the connection.
const dir = mkdtempSync(join(tmpdir(), 'close-tabs-'));
mkdirSync(join(dir, 'json'), { recursive: true });
writeFileSync(join(dir, 'json', 'list'), JSON.stringify(TABS));

const port = 9000 + (process.pid % 900);
const stub = spawn('python3', ['-m', 'http.server', String(port), '--directory', dir], {
  stdio: 'ignore',
});

function stop() {
  stub.kill();
  rmSync(dir, { recursive: true, force: true });
}
process.on('exit', stop);

// Wait for the stub to bind rather than sleeping a guessed interval.
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try {
    execFileSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${port}/json/list`], { stdio: 'pipe' });
    up = true;
  } catch {
    execFileSync('sleep', ['0.1']);
  }
}
if (!up) {
  console.log('could not start the stub CDP server');
  stop();
  process.exit(1);
}

// The dry-run listing goes to stderr, so capture both streams through a shell.
function dryRunIds(url, extra = [], envPairs = '') {
  const cmd = `${envPairs} CDP_ENDPOINT=http://127.0.0.1:${port} bash ${JSON.stringify(SCRIPT)} ${JSON.stringify(url)} --dry-run ${extra.join(' ')} 2>&1`;
  const out = execFileSync('bash', ['-c', cmd], { cwd: BASE, encoding: 'utf8' });
  return [...out.matchAll(/^\s{2}(\S+)\s{2}/gm)].map((m) => m[1]);
}

console.log('close_tabs.sh selection');

// The exact scenario that destroyed six forms: Twitch finishes with 8 tabs open.
check('finishing posting closes only its own tab',
  dryRunIds('https://job-boards.greenhouse.io/embed/job_app?for=twitch&token=8751076002'), ['tw']);

check('ashby posting closes only its own tab',
  dryRunIds('https://jobs.ashbyhq.com/netic/6f1d2c34-1111-4a2b-9c3d-abcdef123456'), ['nt']);

check('board path-id form matches its own tab',
  dryRunIds('https://job-boards.greenhouse.io/hightouch/jobs/6174215004'), ['ht']);

// A run legitimately moves between a posting's URL forms; identity must hold.
check('embed token matches the same posting opened by board path',
  dryRunIds('https://job-boards.greenhouse.io/embed/job_app?for=hightouch&token=6174215004'), ['ht']);

// Same posting, but the employer's own page is a different host: this run is
// cleaning greenhouse, so nothing on it may be closed from that URL.
check('a posting url on another host closes nothing here',
  dryRunIds('https://hightouch.com/careers?gh_jid=6174215004'), []);

// Over-matching is the expensive direction.
check('unidentifiable url closes nothing',
  dryRunIds('https://job-boards.greenhouse.io/'), []);

check('a decoy token equal to a uuid digit-tail is not collateral',
  dryRunIds('https://jobs.ashbyhq.com/netic/6f1d2c34-1111-4a2b-9c3d-abcdef123456')
    .filter((i) => i === 'dc'), []);

check('--host-wide still sweeps the whole host',
  dryRunIds('https://job-boards.greenhouse.io/x', ['--host-wide']), ['ht', 'tg', 'rb', 'hp', 'tw']);

check('non-page targets are never touched',
  dryRunIds('https://job-boards.greenhouse.io/x', ['--host-wide']).filter((i) => i === 'sw'), []);

// If selection cannot run, closing nothing is the only safe outcome.
check('no node on PATH closes nothing',
  dryRunIds('https://job-boards.greenhouse.io/embed/job_app?for=twitch&token=8751076002', [], 'PATH=/usr/bin:/bin'), []);

stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
