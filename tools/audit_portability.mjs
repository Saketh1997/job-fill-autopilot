#!/usr/bin/env node
// audit_portability.mjs -- what still stops someone else from running this?
//
//   node tools/audit_portability.mjs             grouped report
//   node tools/audit_portability.mjs --json      machine-readable
//   node tools/audit_portability.mjs --hits      every occurrence, file:line
//
// Three classes, in the order they should be fixed:
//
//   PATH     a hardcoded checkout path. Replace with lib/paths.{mjs,py,sh}.
//   IDENTITY a person's name or contact detail baked into code. If it reaches a
//            model prompt or a form field it is a wrong answer on someone else's
//            checkout; in a comment it is only noise.
//   MACHINE  an assumption about this box (pinned interpreter paths, ports,
//            systemd units). Belongs in setup, not in a driver.
//
// Read-only. It never edits anything.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../Job_applicator/lib/paths.mjs';

const opts = { json: process.argv.includes('--json'), hits: process.argv.includes('--hits') };

const SKIP_DIR = new Set(['node_modules', '.git', 'venv', '.venv-jobspy', 'logs', 'jd',
  'resumes', 'answers', 'plans', 'schema', 'cache', 'reports', 'harvest', 'output', '__pycache__']);
const EXT = new Set(['.mjs', '.js', '.py', '.sh', '.json', '.yml', '.yaml']);
const CODE_EXT = new Set(['.mjs', '.js', '.py', '.sh']);

// The candidate's own identity, read from the profile so this tool has no name
// hardcoded in it either.
let IDENT = [];
try {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'Job_applicator', 'profile.json'), 'utf8'));
  IDENT = [p.first_name, p.last_name, p.email, p.university_email, p.phone]
    .filter((v) => v && String(v).length > 3)
    .map((v) => String(v));
} catch { /* no profile: the identity class is simply skipped */ }

const RULES = [
  { cls: 'PATH', re: new RegExp(escape(ROOT).replace(/\//g, '\\/'), 'g'),
    what: 'hardcoded checkout path', fix: 'source lib/paths.sh, or import lib/paths.mjs' },
  { cls: 'MACHINE', re: /\/home\/[a-z0-9_-]+\/\.nvm\/versions\/node\/[^\s'"]+/g,
    what: 'pinned Node path', fix: 'resolve from PATH, or read it from setup config' },
  { cls: 'MACHINE', re: /localhost:9226|127\.0\.0\.1:9226/g,
    what: 'hardcoded CDP endpoint', fix: 'default to process.env.CDP_ENDPOINT' },
  { cls: 'MACHINE', re: /\/opt\/google\/chrome\/chrome/g,
    what: 'hardcoded Chrome binary', fix: 'resolve in setup/install_browser_stack.sh' },
];
function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

for (const name of IDENT) {
  RULES.push({ cls: 'IDENTITY', re: new RegExp(escape(name), 'g'),
    what: `candidate identity ("${name}")`, fix: 'read it from lib/identity.mjs' });
}

const isComment = (line) => /^\s*(\/\/|#|\*|\/\*)/.test(line);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) yield* walk(full); continue; }
    if (/\.bak(-|\.|$)/.test(e.name)) continue;          // backups are not shipped
    if (!EXT.has(path.extname(e.name))) continue;
    yield full;
  }
}

const found = [];
for (const file of walk(ROOT)) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(text)) continue;
    // Identity belongs in config and data files -- that is what they are for.
    // It is only a defect in something executable.
    if (rule.cls === 'IDENTITY' && !CODE_EXT.has(path.extname(file))) continue;
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      if (!rule.re.test(line)) return;
      // A literal that is already the fallback behind an env var is the fix, not
      // the defect: `process.env.CDP_ENDPOINT || 'http://localhost:9226'`.
      if (/process\.env\.|os\.environ|\$\{?[A-Z_]+[:-]/.test(line)) return;
      found.push({
        cls: rule.cls,
        file: path.relative(ROOT, file),
        line: i + 1,
        what: rule.what,
        fix: rule.fix,
        // A name in a comment explains a decision; a name in code answers a
        // question wrongly. Only the second class blocks anybody.
        severity: isComment(line) ? 'prose' : 'code',
        text: line.trim().slice(0, 120),
      });
    });
  }
}

// No process.exit here: it truncates a large JSON payload mid-write on a pipe.
if (opts.json) {
  process.stdout.write(JSON.stringify(found, null, 2) + '\n');
} else {

const byClass = {};
for (const f of found) (byClass[f.cls] ||= []).push(f);

console.log(`portability audit — ${ROOT}\n`);
for (const cls of ['PATH', 'IDENTITY', 'MACHINE']) {
  const hits = byClass[cls] || [];
  const code = hits.filter((h) => h.severity === 'code');
  const prose = hits.length - code.length;
  const files = new Set(code.map((h) => h.file));
  console.log(`${cls.padEnd(9)} ${String(code.length).padStart(4)} in code across ${files.size} file(s)` +
              (prose ? `, ${prose} more in comments (harmless)` : ''));
  if (!code.length) { console.log(''); continue; }
  const perFile = {};
  for (const h of code) (perFile[h.file] ||= []).push(h);
  for (const [file, hs] of Object.entries(perFile).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(hs.length).padStart(3)}  ${file}`);
    if (opts.hits) for (const h of hs) console.log(`          ${h.line}: ${h.text}`);
  }
  console.log(`       ↳ ${hits[0].fix}\n`);
}
const blocking = found.filter((h) => h.severity === 'code').length;
console.log(`${blocking} occurrence(s) to fix before another person can run this checkout.`);
}
