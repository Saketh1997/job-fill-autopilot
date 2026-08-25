#!/usr/bin/env node

/**
 * review_resume_patch.mjs — the one LLM call in the resume pipeline.
 *
 * Takes the deterministic draft from tailor_resume_local.mjs and asks a model to
 * review it against the JD, returning a small PATCH rather than a rewritten CV.
 * The patch is validated against content-bank.yml before anything is applied, so
 * the model can reorder and relabel but never introduce a claim.
 *
 * Design constraints, each load-bearing:
 *   - Single shot. No tools, no file reads, no agent loop. The old pipeline's
 *     ~248k input tokens per resume were loop overhead, not task size; this call
 *     is ~2.5k in / ~300 out.
 *   - Patch-only, ID-based. Free text is accepted for `summary` and competency
 *     labels only. Bullets and projects are selected by bank ID, so their text
 *     stays byte-identical to cv.md and metric drift is impossible.
 *   - Advisory. Every field is validated here; anything unbacked is dropped and
 *     logged, not trusted.
 *   - Fail open. Network down, quota exhausted, malformed response: the
 *     deterministic draft ships unchanged and the exit code stays 0. The model
 *     is on by default but never load-bearing.
 *
 * Usage:
 *   node review_resume_patch.mjs --jd <jd.txt> --payload <payload.json> [--log <jsonl>]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { callModelCli } from './cli_model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK_PATH = join(HERE, 'content-bank.yml');
const CV_PATH = resolve(HERE, '..', 'cv.md');

// This used to speak to OmniRoute over the SDK. OmniRoute is gone, and reaching
// api.anthropic.com directly needs an API key the box does not have, so the call
// now goes through the `claude` CLI (cli_model.mjs), which authenticates with
// its own stored credentials. The model id is therefore a FIRST-PARTY id, not
// an OmniRoute alias.
const MODEL = process.env.REVIEW_MODEL || 'claude-sonnet-5';
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 300000);

// ── Patch schema (structured outputs — guarantees a parseable response) ──────

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['ok', 'patched'],
      description: 'ok if the draft already fits the JD well; patched if you changed anything.',
    },
    summary: {
      type: 'string',
      description: 'Replacement professional summary, or empty string to keep the draft as-is.',
    },
    competencies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Replacement competency labels, chosen ONLY from allowed_competencies. Empty array keeps the draft.',
    },
    projects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Project IDs from allowed_projects, in the order they should appear. Empty array keeps the draft.',
    },
    bullets: {
      type: 'array',
      items: { type: 'string' },
      description: 'Experience bullet IDs from allowed_bullets to keep. Empty array keeps the draft.',
    },
    notes: {
      type: 'string',
      description: 'One line per change, and any JD requirement the candidate genuinely lacks.',
    },
  },
  required: ['verdict', 'summary', 'competencies', 'projects', 'bullets', 'notes'],
  additionalProperties: false,
};

/**
 * Parse the response body tolerantly.
 *
 * `output_config.format` guarantees bare JSON on the first-party API, but this
 * pipeline routes through a local gateway that proxies other providers and
 * silently drops the field — those responses come back in ```json fences. Rather
 * than depend on the gateway honoring it, strip fences and fall back to the
 * outermost brace pair. Harmless when the guarantee does hold.
 */
function parseJsonLoose(text) {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in response');
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

// Soft-skill tags. A summary saying "collaboration" is not making a technical
// capability claim, so these terms are exempt from the vocabulary check below.
const SOFT_TAGS = new Set(['collaboration', 'teaching', 'support', 'entry-level']);

/**
 * Cheap stemmer: every form a term might take in the summary versus the form
 * cv.md happens to use. cv.md writes "Benchmarked against baseline joins"; a
 * summary naturally says "benchmarking". Without the -ing/-ed arm the guard
 * rejects that as unbacked, which is a false positive on a real cv.md claim.
 */
function stems(word) {
  const out = new Set([word]);
  if (word.endsWith('ies') && word.length > 4) out.add(word.slice(0, -3) + 'y');
  if (word.endsWith('es') && word.length > 3) out.add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 2) out.add(word.slice(0, -1));
  if (word.endsWith('ing') && word.length > 5) out.add(word.slice(0, -3));
  if (word.endsWith('ed') && word.length > 4) out.add(word.slice(0, -2));
  return [...out];
}

/**
 * Reject a rewritten summary that names a technology absent from cv.md.
 *
 * The summary is the one place the model emits free prose, so it is the one
 * place a fabricated skill could enter. verify-cv-facts.mjs catches invented
 * *metrics* downstream but not invented *skills*, which is the gap this closes.
 *
 * The check runs over a closed technology vocabulary (the bank's synonym keys
 * plus its own skill item names) rather than over every capitalized word. An
 * earlier version flagged any capitalized token missing from cv.md, which
 * rejected ordinary English ("Development") and plurals of backed terms
 * ("LLMs" when cv.md says "LLM agents") — so nearly every legitimate rewrite
 * was discarded. Matching a curated vocabulary has no such false positives.
 *
 * Residual limitation: a technology outside the synonym table would pass here.
 * That table covers the vocabulary a model would realistically reach for, and
 * an unbacked claim still has to survive human review before submission.
 */
function summaryIsGrounded(summary, cvText, bank) {
  // The bank is a curated, hand-reviewed restatement of cv.md, and it is already
  // the authority for what may appear in the competency row — a label like
  // "Machine Learning (PyTorch)" is the sanctioned framing of cv.md's PyTorch
  // line. Treat it as backing evidence here too, or the guard rejects the model
  // for using phrasing the deterministic script itself emits.
  const cv = [
    cvText,
    ...bank.competencies.map(c => c.label),
    ...bank.skills.flatMap(s => [s.category, ...s.items.map(i => i.name)]),
    ...bank.projects.flatMap(p => [p.name, p.tech]),
    ...bank.summary_templates.flatMap(t => [t.lead, t.proof]),
  ].join('\n').toLowerCase();
  const hay = summary.toLowerCase();

  const vocabulary = new Set();
  for (const [term, tag] of Object.entries(bank.synonyms)) {
    if (!SOFT_TAGS.has(tag)) vocabulary.add(term.toLowerCase());
  }
  for (const cat of bank.skills) {
    for (const item of cat.items) vocabulary.add(item.name.toLowerCase());
  }

  const unbacked = [];
  for (const term of vocabulary) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Optional trailing "s"/"es" so a plural in the summary matches the term.
    const re = new RegExp(`(?<![\\w-])${escaped}(?:e?s)?(?![\\w-])`, 'i');
    if (!re.test(hay)) continue;
    if (stems(term).some(s => cv.includes(s))) continue;
    unbacked.push(term);
  }
  return { ok: unbacked.length === 0, unbacked };
}

function validatePatch(patch, bank, cvText) {
  const allowedCompetencies = new Set(bank.competencies.map(c => c.label));
  const allowedProjects = new Map(bank.projects.map(p => [p.id, p]));
  const allowedBullets = new Set(bank.experience.flatMap(j => j.bullets.map(b => b.id)));

  const rejected = [];
  const clean = { summary: '', competencies: [], projects: [], bullets: [] };

  if (patch.summary && patch.summary.trim()) {
    const grounded = summaryIsGrounded(patch.summary, cvText, bank);
    if (grounded.ok) clean.summary = patch.summary.trim();
    else rejected.push(`summary named terms absent from cv.md: ${grounded.unbacked.join(', ')}`);
  }

  for (const label of patch.competencies || []) {
    if (allowedCompetencies.has(label)) clean.competencies.push(label);
    else rejected.push(`competency not in bank: ${label}`);
  }

  for (const id of patch.projects || []) {
    if (allowedProjects.has(id)) clean.projects.push(id);
    else rejected.push(`project id not in bank: ${id}`);
  }

  for (const id of patch.bullets || []) {
    if (allowedBullets.has(id)) clean.bullets.push(id);
    else rejected.push(`bullet id not in bank: ${id}`);
  }

  // A patch that drops the pinned project or empties experience is a mistake,
  // not a tailoring decision. Ignore the selection rather than ship a CV with
  // no work history.
  const pinned = bank.projects.filter(p => p.pinned).map(p => p.id);
  if (clean.projects.length && !pinned.every(p => clean.projects.includes(p))) {
    rejected.push(`project selection dropped pinned project(s) ${pinned.join(', ')} — ignoring`);
    clean.projects = [];
  }
  if (clean.projects.length && clean.projects.length < bank.budget.projects_min) {
    rejected.push('project selection below minimum — ignoring');
    clean.projects = [];
  }
  if (clean.bullets.length && clean.bullets.length > bank.budget.experience_bullets_total) {
    clean.bullets = clean.bullets.slice(0, bank.budget.experience_bullets_total);
    rejected.push('bullet selection over budget — truncated');
  }

  return { clean, rejected };
}

// ── Patch application ───────────────────────────────────────────────────────

function applyPatch(payload, clean, bank) {
  const applied = [];
  const out = { ...payload };

  if (clean.summary) {
    out.summary = clean.summary;
    applied.push('summary');
  }
  if (clean.competencies.length) {
    out.competencies = clean.competencies.slice(0, bank.budget.competencies);
    applied.push('competencies');
  }
  if (clean.projects.length) {
    const variant = clean.projects.length <= 2 ? 'full' : 'short';
    out.projects = clean.projects.map(id => {
      const p = bank.projects.find(x => x.id === id);
      return { name: p.name, tech: p.tech, description: p.variants[variant] ?? p.variants.short };
    });
    applied.push('projects');
  }
  if (clean.bullets.length) {
    const keep = new Set(clean.bullets);
    const experience = [];
    for (const job of bank.experience) {
      const bullets = job.bullets.filter(b => keep.has(b.id));
      if (!bullets.length) continue;
      experience.push({
        company: job.company,
        role: job.role,
        location: job.location,
        dates: job.dates,
        bullets: bullets.map(b => b.text),
      });
    }
    if (experience.length) {
      out.experience = experience;
      applied.push('bullets');
    }
  }
  return { payload: out, applied };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(jdText, payload, bank) {
  const bulletCatalog = bank.experience
    .flatMap(j => j.bullets.map(b => `  ${b.id} [${j.role}]: ${b.text}`))
    .join('\n');
  const projectCatalog = bank.projects
    .map(p => `  ${p.id}: ${p.name} — ${p.tech}`)
    .join('\n');

  return `You are reviewing a resume that a deterministic script already tailored for the job description below. Your job is to CHECK it and patch only what is genuinely wrong. A draft that already fits well needs no changes: return verdict "ok" with empty fields.

## Job description
${jdText.slice(0, 8000)}

## The draft the script produced
Summary: ${payload.summary}
Competencies: ${payload.competencies.join(' | ')}
Experience: ${payload.experience.map(e => `${e.role} (${e.bullets.length} bullets)`).join(', ')}
Projects: ${payload.projects.map(p => p.name).join(', ')}
Skills: ${payload.skills.map(s => `${s.category}: ${s.items}`).join(' / ')}

## What you may change

allowed_competencies (pick at most ${bank.budget.competencies}, exact strings only):
${bank.competencies.map(c => `  ${c.label}`).join('\n')}

allowed_projects (IDs; ${bank.budget.projects_min}-${bank.budget.projects_max} of them; postgres-rosl must always be included):
${projectCatalog}

allowed_bullets (IDs; at most ${bank.budget.experience_bullets_total} total):
${bulletCatalog}

## Rules

- You may rewrite the summary and reorder/reselect competencies, projects and bullets. You may NOT write bullet or project text: select by ID and the script pastes the exact wording from the CV.
- Competency labels must be copied exactly from allowed_competencies. Anything else is discarded.
- The summary may only name skills, employers and technologies that appear in the draft above or in the allowed lists. Never introduce a technology the candidate has not used.
- The candidate is a recent MS graduate with no full-time professional software experience. Never imply seniority.
- No em dashes. Plain text only.
- Prefer the draft. Patch when the script clearly mis-ranked something for this JD, not to reword for taste.

## Output

Return ONLY a JSON object, no prose and no markdown fences, with exactly these keys:

{"verdict": "ok" | "patched",
 "summary": "replacement summary, or \\"\\" to keep the draft",
 "competencies": ["exact labels from allowed_competencies, or [] to keep the draft"],
 "projects": ["project IDs, or [] to keep the draft"],
 "bullets": ["bullet IDs, or [] to keep the draft"],
 "notes": "one line per change, plus any JD requirement the candidate genuinely lacks"}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const jdPath = arg('--jd');
  const payloadPath = arg('--payload');
  const logPath = arg('--log');

  if (!jdPath || !payloadPath || !existsSync(jdPath) || !existsSync(payloadPath)) {
    console.error('Usage: node review_resume_patch.mjs --jd <jd.txt> --payload <payload.json> [--log <jsonl>]');
    process.exit(1);
  }

  const bank = yaml.load(readFileSync(BANK_PATH, 'utf-8'));
  const cvText = readFileSync(CV_PATH, 'utf-8');
  const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));
  const jdText = readFileSync(jdPath, 'utf-8');

  const record = { ts: new Date().toISOString(), jd: jdPath, model: MODEL };

  if (process.env.REVIEW_SKIP === '1') {
    console.error('REVIEW_SKIPPED: skipped by REVIEW_SKIP=1 — shipping deterministic draft');
    process.exit(0);
  }

  let patch;
  try {
    // The CLI has no structured-output mode, so the schema is stated in the
    // prompt and the response is parsed loosely. validatePatch() below is the
    // real guard either way — it already rejects anything the patch is not
    // allowed to say, so a malformed or over-reaching response cannot ship.
    const instruction = 'Reply with ONLY a JSON object matching this schema, no prose and no code fence:\n'
      + `${JSON.stringify(PATCH_SCHEMA)}\n\n`;
    const { text, cost_usd: costUsd } = callModelCli({
      prompt: instruction + buildPrompt(jdText, payload, bank),
      model: MODEL,
      timeout: TIMEOUT_MS,
    });
    if (!text) throw new Error('empty response from the model');
    patch = parseJsonLoose(text);
    record.usage = { cost_usd: costUsd };
  } catch (err) {
    // Fail open: the deterministic draft is already a shippable CV.
    record.error = String(err.message || err);
    if (logPath) appendFileSync(logPath, JSON.stringify(record) + '\n');
    console.error(`REVIEW_SKIPPED: ${record.error} — shipping deterministic draft`);
    process.exit(0);
  }

  const { clean, rejected } = validatePatch(patch, bank, cvText);
  const { payload: patched, applied } = applyPatch(payload, clean, bank);

  record.verdict = patch.verdict;
  record.applied = applied;
  record.rejected = rejected;
  record.notes = patch.notes;
  if (logPath) appendFileSync(logPath, JSON.stringify(record) + '\n');

  if (applied.length) {
    writeFileSync(payloadPath, JSON.stringify(patched, null, 2), 'utf-8');
  }
  for (const r of rejected) console.error(`REVIEW_REJECTED: ${r}`);
  console.log(`REVIEW_OK: verdict=${patch.verdict} applied=[${applied.join(',') || 'none'}] rejected=${rejected.length}`);
}

main();
