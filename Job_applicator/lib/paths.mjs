// paths.mjs -- where everything lives, resolved instead of hardcoded.
//
// 41 files in this repo hardcode /home/hunter/projects/career-ops, which is the
// single largest reason nobody else can run the pipeline. This module is the
// replacement. Resolution order, first hit wins:
//
//   1. CAREER_OPS_ROOT env var          -- explicit, what CI and the skill set
//   2. walk up from this file           -- correct for any checkout location
//
// There is deliberately no hardcoded fallback: a wrong guess sends a run at
// someone else's data directory, and a clear throw is cheaper than that.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A checkout is identified by the two things that must both exist at the root.
// Job_applicator alone is not enough: a stray directory of that name upstream of
// the checkout would capture the walk.
function isRoot(dir) {
  return fs.existsSync(path.join(dir, 'Job_applicator')) &&
         fs.existsSync(path.join(dir, 'package.json'));
}

function walkUp(from) {
  let dir = from;
  for (;;) {
    if (isRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function resolveRoot() {
  const env = process.env.CAREER_OPS_ROOT;
  if (env) {
    const abs = path.resolve(env);
    if (!isRoot(abs)) {
      throw new Error(
        `CAREER_OPS_ROOT=${env} does not look like a career-ops checkout ` +
        `(expected Job_applicator/ and package.json inside it)`);
    }
    return abs;
  }
  const found = walkUp(HERE);
  if (!found) {
    throw new Error(
      'Could not locate the career-ops checkout by walking up from ' + HERE +
      '. Set CAREER_OPS_ROOT to the checkout root.');
  }
  return found;
}

export const ROOT = resolveRoot();
export const APP = path.join(ROOT, 'Job_applicator');

// Artefact directories, all keyed by slug. Created on demand: a fresh checkout
// has none of them, and every stage that writes one expects it to exist.
export const DIRS = {
  jd:       path.join(APP, 'jd'),
  schema:   path.join(APP, 'schema'),
  plans:    path.join(APP, 'plans'),
  resumes:  path.join(APP, 'resumes'),
  answers:  path.join(APP, 'answers'),
  cache:    path.join(APP, 'cache'),
  logs:     path.join(APP, 'logs'),
  data:     path.join(ROOT, 'data'),
  config:   path.join(APP, 'config'),
};

export const FILES = {
  profile:     path.join(APP, 'profile.json'),
  consent:     path.join(APP, 'config', 'consent.json'),
  loginEnv:    path.join(APP, 'login.env'),
  contentBank: path.join(APP, 'content-bank.yml'),
  portals:     path.join(ROOT, 'portals.yml'),
  pipelineCsv: path.join(ROOT, 'data', 'pipeline.csv'),
  pipelineMd:  path.join(ROOT, 'data', 'pipeline.md'),
  cv:          path.join(ROOT, 'cv.md'),
  venv:        path.join(ROOT, '.venv-jobspy'),
};

export function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

// slugPath('jd', 'acme-swe') -> <app>/jd/acme-swe.txt
const SLUG_EXT = { jd: '.txt', schema: '.json', plans: '.json', resumes: '.pdf', answers: '.json' };
export function slugPath(kind, slug, ext) {
  const dir = DIRS[kind];
  if (!dir) throw new Error(`unknown artefact kind: ${kind}`);
  return path.join(dir, slug + (ext ?? SLUG_EXT[kind] ?? ''));
}

export default { ROOT, APP, DIRS, FILES, ensureDirs, slugPath };
