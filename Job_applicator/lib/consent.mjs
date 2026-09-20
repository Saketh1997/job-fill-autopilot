// consent.mjs -- read standing authorizations from config/consent.json.
//
// The rule this encodes: an absent or unreadable consent file means NOTHING is
// authorized. A fresh checkout therefore fills forms and stops, which is the
// behaviour a stranger should get by default.

import fs from 'node:fs';
import { FILES } from './paths.mjs';

export const KNOWN = [
  'submit_when_clean',
  'accept_arbitration',
  'create_accounts',
  'outreach_draft',
  'outreach_auto_send',
  'attach_resume_to_followups',
  'tailor_resume_with_model',
];

let _cache = null;

function load() {
  if (_cache) return _cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(FILES.consent, 'utf8'));
  } catch {
    _cache = { version: 1, granted_by: null, grants: {}, _missing: true };
    return _cache;
  }
  _cache = raw;
  return _cache;
}

/** True only for a grant that is explicitly allowed AND dated. */
export function allows(name) {
  if (!KNOWN.includes(name)) throw new Error(`unknown consent grant: ${name}`);
  const g = load().grants?.[name];
  return Boolean(g && g.allowed === true && /^\d{4}-\d{2}-\d{2}$/.test(g.granted_on || ''));
}

/** One line for the run log, so a submit months later is explainable. */
export function provenance(name) {
  const g = load().grants?.[name];
  if (!allows(name)) return `${name}: NOT GRANTED`;
  return `${name}: granted by ${load().granted_by || 'unknown'} on ${g.granted_on}`;
}

/**
 * Throw unless the grant is present. Call this at the top of anything that acts
 * on the person's behalf without asking.
 */
export function require_(name) {
  if (allows(name)) return true;
  const where = load()._missing ? `no consent file at ${FILES.consent}` : `not granted in ${FILES.consent}`;
  throw new Error(
    `"${name}" is not authorized (${where}). ` +
    `Run the job-applicator skill, or set grants.${name} = {"allowed": true, "granted_on": "YYYY-MM-DD"}.`);
}

export function summary() {
  return KNOWN.map(n => ({ grant: n, allowed: allows(n) }));
}

export function reload() { _cache = null; }

export default { allows, provenance, require_, summary, reload, KNOWN };
