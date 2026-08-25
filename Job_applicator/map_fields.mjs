#!/usr/bin/env node
// map_fields.mjs — turn a scrape_page fields array into values to fill.
//
// Two stateless calls, never an agent:
//   5a  mechanical fields  -> local Llama (or any Ollama model). Cheap, cacheable.
//   5b  free-text fields   -> Sonnet, with the JD and cv.md. Skipped if none.
//
// The model NEVER sees: file inputs, consent checkboxes, or anything matching
// the auth guard. Those are script decisions, and letting a model near them is
// how you end up subscribed to job alerts or typing your name into a login form.
//
//   node map_fields.mjs --fields scrapes/<hash>.json --profile profile.json \
//                       [--jd scrapes/<hash>.txt] [--cv cv.md] [--out answers.json]
//
// Env:
//   OLLAMA_URL      default http://localhost:11434
//   OLLAMA_MODEL    default llama3.1:8b
//   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN   (OmniRoute)
//     ANTHROPIC_API_KEY is accepted as a fallback token name.
//   FREETEXT_MODEL  default claude-sonnet-5
//   CACHE           default ./cache/field-map.json
//
// Exit: 0 ok   2 unfilled required fields   3 error   4 auth wall

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { callModelCli } from './cli_model.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const FIELDS_PATH = val('--fields', '');
const PROFILE_PATH = val('--profile', 'profile.json');
const JD_PATH = val('--jd', '');
const CV_PATH = val('--cv', '');
const OUT_PATH = val('--out', '');
const CACHE_PATH = process.env.CACHE || './cache/field-map.json';

if (!FIELDS_PATH) { console.error('usage: map_fields.mjs --fields <scrape.json> --profile <profile.json>'); process.exit(3); }

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readText = (p) => (p && existsSync(p) ? readFileSync(p, 'utf8') : '');

const scrape = readJson(FIELDS_PATH);
const fields = Array.isArray(scrape) ? scrape : (scrape.fields || []);
const profile = readJson(PROFILE_PATH);

// Flatten to dot paths. A small model traverses nested JSON unreliably, and a
// flat map is also what the cache resolver stores, so address.zip works the
// same as zip.
const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) { if (v.length) out[key] = v.join(', '); }
    else if (v && typeof v === 'object') flatten(v, key, out);
    else if (v !== null && v !== undefined && v !== '') out[key] = String(v);
  }
  return out;
};
const flatProfile = flatten(profile);

// Credentials never reach a model, a prompt, or the cache. A profile is a
// convenient place to keep them and a terrible place to leave them: the whole
// object is serialized into every mapping prompt.
const SECRET = /password|passwd|secret|token|api[_-]?key|credential|ssn|social[_-]?security|passport|license[_-]?number/i;
for (const k of Object.keys(flatProfile)) {
  if (SECRET.test(k)) delete flatProfile[k];
}

// Forms ask for the same information in a handful of shapes. Precompute them so
// a small model is never assembling or parsing strings, only selecting one.
const P = flatProfile;
const compose = (key, parts, sep = ', ') => {
  if (P[key]) return;
  const vals = parts.map((k) => P[k]).filter(Boolean);
  if (vals.length === parts.length) P[key] = vals.join(sep);
};
compose('address.city_state', ['address.city', 'address.state']);
compose('address.city_state_zip', ['address.city', 'address.state', 'address.zip']);
compose('address.full', ['address.street', 'address.city', 'address.state', 'address.zip']);
if (!P['name.full'] && P['first_name'] && P['last_name']) P['name.full'] = `${P.first_name} ${P.last_name}`;

// ------------------------------------------------------------------ guards
const AUTH = /session_key|session_password|logincsrf|current-password|^password$/i;
if (fields.some((f) => AUTH.test(`${f.name || ''} ${f.id || ''} ${f.autocomplete || ''}`))) {
  console.log(JSON.stringify({ blocked: 'auth_wall', answers: {} }, null, 2));
  process.exit(4);
}

const NEVER_CHECK = /alert|consent|subscribe|opt.?in|marketing|text.?message|newsletter/i;

// ------------------------------------------------------------- partitioning
const isFile = (f) => f.type === 'file';
const isCheck = (f) => f.type === 'checkbox' || f.type === 'radio';
const isFreeText = (f) =>
  f.tag === 'textarea'
  || Number(f.maxlength || 0) > 500
  || /why |describe|tell us|cover letter|additional information|anything else|in your own words/i
      .test(`${f.label || ''} ${f.hint || ''}`);

const script_handled = [];
const mechanical = [];
const freetext = [];

for (const f of fields) {
  if (!f.name) continue;
  if (isFile(f)) { script_handled.push({ ...f, action: 'setInputFiles', source: 'resume_pdf' }); continue; }
  if (isCheck(f)) {
    // Only ever check a required box. Consent and marketing are never checked,
    // required or not: a required consent box is a run we decline, not one we
    // silently agree to.
    const consenty = NEVER_CHECK.test(`${f.name} ${f.label || ''}`);
    script_handled.push({ ...f, action: 'checkbox', check: !!f.required && !consenty, consenty });
    continue;
  }
  (isFreeText(f) ? freetext : mechanical).push(f);
}

// Slim payload. The model does not need frame_url, ids, or empty option arrays.
const slim = (f) => ({
  name: f.name,
  label: f.label || null,
  hint: f.hint || undefined,
  type: f.type,
  required: !!f.required,
  options: f.options && f.options.length ? f.options.map((o) => o.text) : undefined,
  maxlength: f.maxlength || undefined,
});

// -------------------------------------------------------------------- cache
// Field labels repeat brutally across postings. Hash the label plus its option
// set and the model stops seeing questions it has already answered.
const cacheKey = (f) => createHash('sha1')
  .update(`${f.label || f.name}|${(f.options || []).map((o) => o.text).join('|')}`)
  .digest('hex').slice(0, 16);

let cache = {};
try { cache = readJson(CACHE_PATH); } catch { cache = {}; }

// ------------------------------------------------------------------- models
const ollama = async (prompt) => {
  const r = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      prompt, stream: false, format: 'json',
      options: { temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  return (await r.json()).response;
};

// This used to POST to OmniRoute's /v1/messages with a bearer token. OmniRoute
// is gone, and the token it carried is rejected by api.anthropic.com, so the
// call now goes through the `claude` CLI (cli_model.mjs), which authenticates
// with its own stored credentials and needs no API key. The model id is
// therefore a FIRST-PARTY id, not an OmniRoute alias.
const anthropic = async (system, user) => {
  const { text } = callModelCli({
    prompt: user,
    system,
    model: process.env.FREETEXT_MODEL || 'claude-sonnet-5',
    timeout: Number(process.env.FREETEXT_TIMEOUT_MS || 300000),
  });
  return text;
};

const parseJson = (s) => {
  const clean = String(s).replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  return JSON.parse(start >= 0 ? clean.slice(start, end + 1) : clean);
};

// ------------------------------------------------------------------ 5a call
const answers = {};
const provenance = {};
const notes = [];

const uncached = [];
for (const f of mechanical) {
  const k = cacheKey(f);
  const hit = cache[k];
  // Cached values that came from the profile are re-read, not replayed, so a
  // profile edit propagates. Only the mapping decision is cached.
  if (hit && hit.path && hit.path.startsWith('profile.')) {
    const v = hit.path.split('.').slice(1).reduce((o, seg) => (o ?? {})[seg], profile);
    if (v !== undefined && v !== null && v !== '') {
      answers[f.name] = String(v);
      provenance[f.name] = `cache:${hit.path}`;
      continue;
    }
  }
  uncached.push(f);
}

if (uncached.length) {
  const prompt = [
    'You map job application form fields to a candidate profile.',
    '',
    'Rules:',
    '- Reply with ONLY a JSON object. No prose, no markdown fences.',
    '- Keys are field names exactly as given. Values are strings.',
    '- Omit any field you cannot fill from the profile. Do not guess.',
    '- Never invent facts that are not in the profile.',
    '- If a field has an options list, the value MUST be one of those options.',
    '',
    'PROFILE:',
    JSON.stringify(flatProfile, null, 2),
    '',
    'FIELDS:',
    JSON.stringify(uncached.map(slim), null, 2),
    '',
    'JSON:',
  ].join('\n');

  try {
    const out = parseJson(await ollama(prompt));
    const valid = new Set(uncached.map((f) => f.name));
    for (const [k, v] of Object.entries(out)) {
      // Reject any key the model invented. This is the guard that keeps a small
      // model honest: it can only fill fields that actually exist.
      if (!valid.has(k)) { notes.push(`dropped invented field: ${k}`); continue; }
      if (v === null || v === '') continue;
      const f = uncached.find((x) => x.name === k);
      if (f.options && f.options.length) {
        const ok = f.options.some((o) => o.text === v || o.value === v);
        if (!ok) { notes.push(`dropped out-of-range option for ${k}: ${v}`); continue; }
      }
      answers[k] = String(v);
      provenance[k] = 'model:mechanical';
    }
  } catch (e) {
    notes.push(`mechanical call failed: ${e.message}`);
  }
}

// ------------------------------------------------------------------ 5b call
if (freetext.length) {
  const jd = readText(JD_PATH);
  const cv = readText(CV_PATH);
  const system = [
    'You write job application answers in the candidate\'s own voice.',
    'Every factual claim must be supported by the CV. Never invent experience,',
    'employers, dates, or metrics. Tailor to what this posting actually asks for',
    'rather than reaching for the strongest project by default.',
    'Reply with ONLY a JSON object mapping field name to answer text.',
  ].join(' ');

  const user = [
    'QUESTIONS:',
    JSON.stringify(freetext.map(slim), null, 2),
    '',
    'JOB DESCRIPTION:',
    jd.slice(0, 12000) || '(not provided)',
    '',
    'CV:',
    cv.slice(0, 12000) || '(not provided)',
  ].join('\n');

  try {
    const out = parseJson(await anthropic(system, user));
    const valid = new Set(freetext.map((f) => f.name));
    for (const [k, v] of Object.entries(out)) {
      if (!valid.has(k)) { notes.push(`dropped invented field: ${k}`); continue; }
      if (!v) continue;
      answers[k] = String(v);
      provenance[k] = 'model:freetext';
    }
  } catch (e) {
    notes.push(`freetext call failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- assemble
const missingRequired = fields
  .filter((f) => f.required && f.name && !isFile(f) && !isCheck(f) && !(f.name in answers))
  .map((f) => f.name);

const result = {
  source: FIELDS_PATH,
  url: scrape.final_url || null,
  counts: {
    total: fields.length,
    mechanical: mechanical.length,
    freetext: freetext.length,
    script_handled: script_handled.length,
    answered: Object.keys(answers).length,
  },
  answers,
  provenance,
  script_handled,
  missing_required: missingRequired,
  notes,
};

// Persist mapping decisions that came straight from the profile, so the next
// posting with the same label skips the model entirely.
mkdirSync(dirname(CACHE_PATH), { recursive: true });
for (const f of mechanical) {
  if (!(f.name in answers)) continue;
  const v = answers[f.name];
  const path = Object.entries(flatProfile).find(([, pv]) => pv === v)?.[0];
  if (path) cache[cacheKey(f)] = { path: `profile.${path}`, label: f.label || f.name };
}
writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

const json = JSON.stringify(result, null, 2);
if (OUT_PATH) writeFileSync(OUT_PATH, json);
process.stdout.write(json + '\n');
process.exit(missingRequired.length ? 2 : 0);
