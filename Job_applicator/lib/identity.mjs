// identity.mjs -- the candidate's name and contact details, read from profile.json.
//
// Model prompts in amazon_apply.mjs, ats_review.mjs and ats_questions.mjs each
// open with a hardcoded "Saketh Metta", and open_tabs.mjs / fill_embed_greenhouse.mjs
// type a hardcoded legal name into forms. Every one of those is a wrong answer on
// anyone else's checkout. Import from here instead.

import fs from 'node:fs';
import path from 'node:path';
import { FILES, ROOT } from './paths.mjs';

let _cache = null;

export function profile() {
  if (_cache) return _cache;
  if (!fs.existsSync(FILES.profile)) {
    throw new Error(
      `No profile at ${FILES.profile}. Run the job-applicator skill first ` +
      `(/job-applicator), or copy config/profile.example.json.`);
  }
  _cache = JSON.parse(fs.readFileSync(FILES.profile, 'utf8'));
  return _cache;
}

const req = (p, k) => {
  const v = p[k];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`profile.json is missing required field "${k}"`);
  }
  return v;
};

/** "Saketh Metta" -- what a prompt or a byline should say. */
export function displayName() {
  const p = profile();
  return `${req(p, 'first_name')} ${req(p, 'last_name')}`.trim();
}

/** Full legal name for forms that ask for it; falls back to the display name. */
export function legalName() {
  const p = profile();
  return (p.legal_name && String(p.legal_name).trim()) || displayName();
}

/** What the candidate is actually called -- forms with a "preferred name" field. */
export function preferredName() {
  const p = profile();
  const cached = p.cached_answers?.['job:what is your preferred name']?.answer;
  return (p.preferred_name && String(p.preferred_name).trim())
      || (cached && String(cached).trim())
      || req(p, 'first_name');
}

export function contact() {
  const p = profile();
  return {
    firstName: req(p, 'first_name'),
    lastName:  req(p, 'last_name'),
    email:     req(p, 'email'),
    phone:     p.phone ?? '',
    linkedin:  p.linkedin ?? '',
    github:    p.github ?? '',
    website:   p.website ?? '',
  };
}

/**
 * The generic resume. profile.json stores this as an absolute path, which is one
 * more thing that breaks on a different checkout, so a path under the old root is
 * re-anchored onto this one by basename.
 */
export function genericResumePath() {
  const p = profile();
  const raw = p.resume_path;
  if (!raw) throw new Error('profile.json has no resume_path');
  if (fs.existsSync(raw)) return raw;
  const here = path.join(ROOT, path.basename(raw));
  if (fs.existsSync(here)) return here;
  throw new Error(
    `resume_path ${raw} does not exist, and no ${path.basename(raw)} at ${ROOT}`);
}

/** Reset the memoised profile -- used by the setup wizard after it writes one. */
export function reload() { _cache = null; }

export default { profile, displayName, legalName, preferredName, contact, genericResumePath, reload };
