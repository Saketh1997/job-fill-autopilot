#!/usr/bin/env node

/**
 * tailor_resume_local.mjs — zero-LLM resume tailoring.
 *
 * Reads a JD and content-bank.yml, scores every bank entry by how well its tags
 * match the JD's vocabulary, selects the best-fitting subset under a fixed
 * one-page budget, and writes the same payload.json shape that build-cv-html.mjs
 * already consumes.
 *
 * Nothing here generates prose. Every factual string is copied out of the bank,
 * which is itself copied out of cv.md, so metric drift and invented claims are
 * structurally impossible rather than gate-caught. The only assembled string is
 * the summary, which fills one {focus} slot with competency labels that are
 * themselves bank entries.
 *
 * Usage:
 *   node tailor_resume_local.mjs <jd-file> --out <payload.json> [--changes <file>]
 *   node tailor_resume_local.mjs <jd-file> --explain      # show the scoring
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK_PATH = join(HERE, 'content-bank.yml');
const PROFILE_PATH = resolve(HERE, '..', 'config', 'profile.yml');

// Title lines carry far more signal per word than the body: a JD that says
// "Data Engineer" in the title wants data work even if the body mentions
// Kubernetes twice as often. Weight the opening lines accordingly.
const TITLE_LINES = 6;
const TITLE_WEIGHT = 6;
const BODY_WEIGHT = 1;

// ── JD term extraction ──────────────────────────────────────────────────────

/**
 * Build a tag -> weighted-hit-count map for one JD.
 *
 * Matching is done on the raw JD text rather than on jd-skill-gap.mjs's
 * requirement-bullet extraction: real scraped JDs frequently have no
 * "Requirements" header and no markdown bullets, which makes that extractor
 * return one or two tokens (see jd/*.txt). Full-text matching against a curated
 * synonym table is format-independent.
 */
function scoreJdTags(jdText, synonyms) {
  const lines = jdText.split('\n');
  const title = lines.slice(0, TITLE_LINES).join('\n').toLowerCase();
  const body = lines.slice(TITLE_LINES).join('\n').toLowerCase();

  const hits = new Map();
  const bump = (tag, n) => hits.set(tag, (hits.get(tag) || 0) + n);

  for (const [term, tag] of Object.entries(synonyms)) {
    // Word-boundary-ish match that survives symbol-edged terms (c++, ci/cd).
    // Escaping first, then padding with non-word guards, keeps "java" from
    // matching inside "javascript" while letting "c++" match at all.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'g');
    const inTitle = (title.match(re) || []).length;
    const inBody = (body.match(re) || []).length;
    if (inTitle) bump(tag, inTitle * TITLE_WEIGHT);
    if (inBody) bump(tag, inBody * BODY_WEIGHT);
  }
  return hits;
}

/** Sum the JD hit counts for an entry's tags, with diminishing returns. */
function scoreEntry(tags, jdHits) {
  if (!Array.isArray(tags)) return 0;
  let score = 0;
  for (const tag of tags) {
    const hits = jdHits.get(tag) || 0;
    // sqrt so an entry tagged with five lightly-mentioned skills can still beat
    // one tagged with a single skill the JD happens to repeat twelve times.
    if (hits > 0) score += Math.sqrt(hits);
  }
  return score;
}

// ── Selection ───────────────────────────────────────────────────────────────

function selectCompetencies(bank, jdHits, limit) {
  const scored = bank.competencies
    .map(c => ({ ...c, score: scoreEntry(c.tags, jdHits) }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(c => c.score > 0);
  if (matched.length >= limit) return matched.slice(0, limit);

  // Sparse JD (thin posting, or a scraped careers page rather than a real ad).
  // Rather than shipping a two-item competency row, top up in bank order —
  // which is ordered by how central each skill is to the CV. These are still
  // real cv.md skills; they are simply not JD-driven, and the changes file
  // records that they were fillers.
  const fillers = bank.competencies
    .filter(c => !matched.some(m => m.label === c.label))
    .slice(0, limit - matched.length)
    .map(c => ({ ...c, score: 0, filler: true }));
  return [...matched, ...fillers];
}

function selectExperience(bank, jdHits, budget) {
  // Rank every bullet globally, then regroup under its employer. This lets a
  // JD-relevant bullet from a lower-weighted role outrank a weak bullet from
  // the top role, which fixed per-role quotas cannot express.
  const scored = [];
  for (const job of bank.experience) {
    for (const b of job.bullets) {
      scored.push({
        jobId: job.id,
        bulletId: b.id,
        text: b.text,
        score: (scoreEntry(b.tags, jdHits) + 0.1) * (job.weight ?? 1),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const keptIds = new Set();
  const perJob = new Map();
  for (const s of scored) {
    if (keptIds.size >= budget.experience_bullets_total) break;
    const job = bank.experience.find(j => j.id === s.jobId);
    // An optional role (the support job) only earns a slot on a real match,
    // not on the +0.1 floor every bullet gets.
    if (job.optional && s.score < 0.5) continue;
    keptIds.add(s.bulletId);
    if (!perJob.has(s.jobId)) perJob.set(s.jobId, []);
    perJob.get(s.jobId).push(s.bulletId);
  }

  // Emit in the bank's own order so chronology is never scrambled.
  const out = [];
  for (const job of bank.experience) {
    const ids = perJob.get(job.id);
    if (!ids || ids.length === 0) continue;
    out.push({
      company: job.company,
      role: job.role,
      location: job.location,
      dates: job.dates,
      bullets: job.bullets.filter(b => ids.includes(b.id)).map(b => b.text),
    });
  }
  return out;
}

function selectProjects(bank, jdHits, budget) {
  const scored = bank.projects
    .map(p => ({ ...p, score: scoreEntry(p.tags, jdHits) }))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.score - a.score);

  const chosen = scored.slice(0, budget.projects_max);
  // Long descriptions only when few projects share the space.
  const variant = chosen.length <= 2 ? 'full' : 'short';
  return chosen.map(p => ({
    id: p.id,
    name: p.name,
    tech: p.tech,
    description: p.variants[variant] ?? p.variants.short ?? p.variants.full,
  }));
}

function selectSkills(bank, jdHits, budget) {
  return bank.skills
    .map(cat => ({
      ...cat,
      score: (cat.items.reduce((sum, i) => sum + scoreEntry(i.tags, jdHits), 0) + 0.1) * (cat.weight ?? 1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, budget.skill_categories)
    .map(cat => ({
      category: cat.category,
      // Reorder inside the category so the JD's own terms lead the line.
      items: [...cat.items]
        .sort((a, b) => scoreEntry(b.tags, jdHits) - scoreEntry(a.tags, jdHits))
        .slice(0, budget.skill_items_per_category)
        .map(i => i.name)
        .join(', '),
    }));
}

function buildSummary(bank, jdHits, competencies) {
  const track = bank.summary_templates
    .map(t => ({ ...t, score: scoreEntry(t.tags, jdHits) }))
    .sort((a, b) => b.score - a.score)[0];

  // {focus} is filled only from competencies already selected above, so the
  // summary can never name a skill the rest of the CV does not support.
  const focus = competencies.slice(0, 3).map(c => c.label.replace(/\s*\([^)]*\)/g, ''));
  const focusText = focus.length
    ? focus.length === 1 ? focus[0] : `${focus.slice(0, -1).join(', ')} and ${focus[focus.length - 1]}`
    : 'software and data engineering';

  return { text: `${track.lead.replace('{focus}', focusText)} ${track.proof}`, track: track.track };
}

// ── Candidate block ─────────────────────────────────────────────────────────

function buildCandidate(profile) {
  const c = profile.candidate || {};
  const linkedin = String(c.linkedin || '').replace(/^https?:\/\//, '');
  return {
    name: c.full_name || '',
    phone: c.phone || '',
    email: c.email || '',
    linkedin: linkedin ? { url: `https://${linkedin}`, display: linkedin } : undefined,
    // Portfolio is always the bare domain: profile.yml carries a #hero anchor
    // that reads badly on a printed CV.
    portfolio: { url: 'https://sakethmetta.org', display: 'sakethmetta.org' },
    location: c.location || '',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jdPath = args.find(a => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const changesIdx = args.indexOf('--changes');
  const explain = args.includes('--explain');

  if (!jdPath || !existsSync(jdPath)) {
    console.error('Usage: node tailor_resume_local.mjs <jd-file> --out <payload.json> [--changes <file>] [--explain]');
    process.exit(1);
  }

  const bank = yaml.load(readFileSync(BANK_PATH, 'utf-8'));
  const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
  const jdText = readFileSync(jdPath, 'utf-8');

  const jdHits = scoreJdTags(jdText, bank.synonyms);
  const budget = bank.budget;

  // A real posting lights up a dozen or more tags. A near-empty hit map almost
  // always means the scrape captured a careers landing page or a cookie wall
  // rather than the ad, and the tailoring below will be generic. Say so loudly
  // instead of silently shipping a defaulted CV.
  const totalHits = [...jdHits.values()].reduce((a, b) => a + b, 0);
  const weakJd = jdHits.size < 4 || totalHits < 6;
  if (weakJd) {
    console.error(`WEAK_JD_SIGNAL: only ${jdHits.size} distinct skill tags matched in ${jdPath}.`);
    console.error('  The posting may be a careers page or a failed scrape. Tailoring will be generic.');
  }

  const competencies = selectCompetencies(bank, jdHits, budget.competencies);
  const summary = buildSummary(bank, jdHits, competencies);
  const experience = selectExperience(bank, jdHits, budget);
  const projects = selectProjects(bank, jdHits, budget);
  const skills = selectSkills(bank, jdHits, budget);

  if (explain) {
    const ranked = [...jdHits.entries()].sort((a, b) => b[1] - a[1]);
    console.log('JD tag hits:', ranked.slice(0, 15).map(([t, n]) => `${t}:${n}`).join('  '));
    console.log('Track:      ', summary.track);
    console.log('Competencies:', competencies.map(c => `${c.label}(${c.score.toFixed(1)})`).join(', '));
    console.log('Projects:   ', projects.map(p => p.id).join(', '));
    console.log('Bullets:    ', experience.reduce((n, e) => n + e.bullets.length, 0));
    console.log('Skills:     ', skills.map(s => s.category).join(' | '));
    if (!args.includes('--out')) return;
  }

  const payload = {
    lang: 'en',
    page_format: 'letter',
    candidate: buildCandidate(profile),
    summary: summary.text,
    competencies: competencies.map(c => c.label),
    experience,
    projects: projects.map(({ id, ...p }) => p),
    education: bank.education,
    skills,
  };

  const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
  if (!outPath) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');

  if (changesIdx !== -1) {
    const droppedProjects = bank.projects.filter(p => !projects.some(c => c.name === p.name));
    const droppedJobs = bank.experience.filter(j => !experience.some(e => e.role === j.role));
    const lines = [
      `- Deterministic tailoring (zero LLM). Track selected: ${summary.track}.`,
      `- Top JD signals: ${[...jdHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t).join(', ') || '(none matched)'}`,
      `- Competencies drawn from cv.md-backed bank entries only: ${competencies.map(c => c.label).join('; ')}`,
      `- Kept ${experience.reduce((n, e) => n + e.bullets.length, 0)} experience bullets across ${experience.length} roles`,
      ...droppedJobs.map(j => `- Dropped role for space/relevance: ${j.role} (${j.company})`),
      ...droppedProjects.map(p => `- Dropped project for space/relevance: ${p.name}`),
    ];
    writeFileSync(args[changesIdx + 1], lines.join('\n') + '\n', 'utf-8');
  }

  console.log(`LOCAL_TAILOR_OK: ${outPath}`);
}

main();
