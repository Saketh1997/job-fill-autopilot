// ats_review.mjs — read the filled form back and correct it, once, before the
// completeness audit runs.
//
// WHY THIS EXISTS
//
// Every layer before this one answers questions in isolation. make_plan.py maps
// a question to a profile field by regex, the question pass sends a list of
// questions to a model that never sees the page, and each filler verifies only
// that the value it typed is the value the control now holds. All three can be
// individually correct and still produce a form that is wrong as a whole:
//
//   - DoorDash, 2026-08-11. "Please select and confirm your graduation date"
//     matched make_plan.py's `\bdate\b` rule and was answered "Immediately",
//     against a control offering three date ranges. "Do you have interest and
//     experience in a mobile role?" matched `phone|mobile` and was answered
//     with the phone number. Both fillers did their job; both answers were
//     nonsense, and nothing downstream was in a position to notice.
//
// The audit that runs after this one asks "is every required field non-empty?".
// That question cannot catch a wrong answer, only a missing one. This pass asks
// the other question — "is what the form now says true, and does it answer what
// was actually asked?" — with the whole form in view at once, which is also the
// only context in which a bare "Please specify" or an unlabelled select can be
// understood at all.
//
// SHAPE
//
//   scrape the whole form, with the answers now in it (no model)
//     -> ONE model call: the inventory, cv.md, profile.json, the JD, data/*.txt
//     -> validate every proposed correction against the control's own options
//     -> re-fill through the same verified fillers, reading each value back
//
// The model sees a text inventory, never the page, and never fills anything —
// same contract as the question pass. It runs once: a correction pass that
// re-ran until it was happy would be a model arguing with itself on an
// employer's form.
//
// WHAT IT WILL NOT DO
//
//   - It cannot overrule profile.json. A structured fact (contact, education,
//     EEO, work authorization) that already matches profile.json is refused as
//     a correction target and reported instead. The model's job here is to
//     catch a wrong answer, not to have an opinion about the candidate's email.
//   - It cannot invent an option. A correction to a control with options has to
//     be one of that control's own labels or it is dropped.
//   - It cannot make an answer disappear quietly. Every applied correction is
//     recorded in state.review.corrections with the old value, the new value
//     and the model's reason, and every refusal in state.review.refused.

import fs from 'node:fs';
import path from 'node:path';
import { BASE, norm, lc } from './ats_apply_common.mjs';
import {
  ANSWER_RULES, runModel, scrapeQuestions, resolveFromProfile,
  loadAnswerCache, saveAnswerCache, cacheStore,
} from './ats_questions.mjs';

const EEO = /gender|race|ethnic|veteran|disab|hispanic|latino/i;
const redact = (question, value) => (EEO.test(question || '')
  ? '•••'
  : String(Array.isArray(value) ? value.join(', ') : value).slice(0, 60));

// What the form currently says for a field, as a label a human would read.
const currentOf = (f) => (f.chosen?.length ? f.chosen.join(', ') : norm(f.value));

export async function reviewFilled({
  page, formSel, ats, company, slug, jdPath, profile, state, log, fill,
}) {
  const all = await scrapeQuestions(page, formSel);
  if (!all.length) {
    log('review: no fields readable on the form — skipping');
    return;
  }

  // NOTE: comboboxes are deliberately NOT harvested here, and their options are
  // deliberately not used to validate a correction. A Greenhouse typeahead
  // (School, Location) loads nothing until you type, so a cold read returns an
  // alphabetical first page — and validating against it rejected a correct
  // "Oregon State University" as "not one of that control's options" on the
  // first run of this pass. fillScraped's combobox path already types to
  // filter and then proves the control committed the intended value, which is
  // a stronger check than any list read in advance.

  const read = (p, cap = 8000) => { try { return fs.readFileSync(p, 'utf8').slice(0, cap); } catch { return ''; } };
  const dataDir = path.join(BASE, 'data');
  const background = ['about_me.txt', 'work_experience.txt', 'technical_skills.txt',
    'education.txt', 'strengths.txt', 'career_goals.txt', 'current_projects.txt',
    'suitability_swe.txt', 'suitability_ml.txt']
    .map((f) => { const t = read(path.join(dataDir, f), 4500); return t ? `--- data/${f} ---\n${t}` : ''; })
    .filter(Boolean).join('\n\n');

  const safeProfile = JSON.parse(JSON.stringify(profile));
  for (const k of Object.keys(safeProfile)) if (/password|secret|token|credential/i.test(k)) delete safeProfile[k];

  const inventory = all.map((f) => ({
    key: f.key,
    question: f.question,
    description: f.description || undefined,
    kind: f.kind,
    required: f.required,
    options: f.options.map((o) => o.label),
    maxlength: f.maxlength,
    current_answer: currentOf(f) || null,
  }));

  const prompt = `You are reviewing a job application form for Saketh Metta that has ALREADY been filled in. Every field below is shown with the answer currently sitting in it. Your job is to find the answers that are wrong and to say what they should be instead. Return JSON only.

FOR EACH FIELD, DECIDE
- The current answer is truthful and answers the question that was asked -> leave it alone. Say nothing about it.
- The current answer is wrong: it answers a different question, contradicts the sources, is a value that was clearly meant for another field, is not a legal option for this control, or breaks a rule below -> return a correction.
- The field is blank and you can now answer it truthfully -> return a correction with the answer. You can see the WHOLE form, so a field that was unanswerable on its own ("Please specify", an unlabelled select) may be obvious from the question above it. Use that context; do not guess when it is still not clear.
- The field is blank and still cannot be answered truthfully from the sources -> list it in still_unanswerable.

THE MOST IMPORTANT CASE
A control that offers options has been answered with something that is not one of them, or with a value that belongs to a different question. Real examples from this pipeline: "Please select and confirm your graduation date" (options: date ranges) answered "Immediately", and "Do you have interest and experience in a mobile role?" (options: Yes/No) answered with the candidate's phone number. Both came from a keyword rule that matched the wrong question. Fix these.

RULES (an answer that breaks one of these is wrong even when it reads well)
${ANSWER_RULES}

DO NOT
- Do not rewrite an answer you merely find plain, short, or differently phrased than you would put it. A correction is for a WRONG answer, not a style preference.
- Do not change an answer that already matches profile.json.
- Do not fill an optional free-text field just because it is empty.
- Do not answer a [follow-up to "..."] field when the question it depends on is answered No.

FORM AS IT NOW STANDS
${JSON.stringify(inventory, null, 2)}

RESUME BEING ATTACHED (cv.md)
${read(path.join(BASE, 'cv.md'), 12000) || read(path.join(BASE, '..', 'cv.md'), 12000)}

PROFILE (profile.json)
${JSON.stringify(safeProfile, null, 2)}

JOB DESCRIPTION (jd/${slug}.txt)
${read(jdPath, 12000)}

CANDIDATE BACKGROUND
${background}

OUTPUT
Reply with the JSON as your message text. Do not call any tool, do not run any command — just write it.
A single JSON object, nothing else:
{"corrections": [{"key": "<key>", "value": <option label | array of option labels | free text>, "why": "<one line: what is wrong with the current answer>"}],
 "still_unanswerable": [{"key": "<key>", "why": "<one line>"}]}`;

  log(`review: checking ${inventory.length} filled field(s) in one call `
    + `(${Math.round(prompt.length / 1024)}KB prompt on stdin, no tools, no browser)`);

  const out = runModel({ prompt, slug, logName: 'review', state, log, what: 'review' });
  if (!out) return;

  const corrections = Array.isArray(out.corrections) ? out.corrections : [];
  const review = {
    checked: inventory.length, corrections: [], refused: [], unanswerable: [],
  };
  state.review = review;

  const cache = loadAnswerCache(ats);
  let cacheDirty = false;

  for (const c of corrections) {
    const f = all.find((x) => x.key === c.key);
    const why = String(c.why || '').slice(0, 160);
    if (!f) {
      review.refused.push(`unknown field key ${c.key}`);
      continue;
    }
    const current = currentOf(f);
    const value = c.value;
    if (value === undefined || value === null || (!Array.isArray(value) && !norm(value))) {
      // "Clear this field" is not a correction this pass performs. A field that
      // should be empty is a conditional one, and answerRemaining already
      // clears those from the parent answer.
      review.refused.push(`${f.question.slice(0, 60)}: empty correction ignored`);
      continue;
    }

    // Same answer, differently spelled. react-select shows "United States +1"
    // for a control whose option label is "United States"; re-filling that is
    // pure risk for no change.
    const same = Array.isArray(value)
      ? lc(value.join(', ')) === lc(current)
      : (lc(value) === lc(current)
        || (!!current && (lc(current).includes(lc(value)) || lc(value).includes(lc(current)))
          && f.kind !== 'textarea' && f.kind !== 'text'));
    if (same) continue;

    // profile.json outranks the model on structured facts. If the field already
    // holds what profile.json says, a correction is a disagreement with the
    // source of truth, not a fix — report it and move on.
    const fromProfile = resolveFromProfile(f.question, profile, f.description || '');
    if (fromProfile && current && lc(current).includes(lc(fromProfile))) {
      review.refused.push(
        `${f.question.slice(0, 60)}: refused — current answer comes from profile.json`,
      );
      continue;
    }

    // The control decides what is a legal answer, exactly as in the question
    // pass. A correction that is not on the menu is a hallucinated option.
    // Comboboxes are exempt: see the note above — their option list is whatever
    // happened to be loaded, not what the control accepts.
    if (f.options.length && f.kind !== 'combobox') {
      const legal = f.options.map((o) => lc(o.label));
      const bad = (Array.isArray(value) ? value : [value]).filter((x) => !legal.includes(lc(x)));
      if (bad.length) {
        review.refused.push(
          `${f.question.slice(0, 60)}: ${JSON.stringify(bad).slice(0, 60)} is not one of that control's options`,
        );
        continue;
      }
    }
    const capped = !Array.isArray(value) && f.maxlength && String(value).length > f.maxlength
      ? String(value).slice(0, f.maxlength) : value;

    // A checkbox group keeps every box that is already ticked: fillScraped only
    // ticks, it never unticks. Correcting one without clearing the old choice
    // would leave the form asserting both.
    if (f.kind === 'checkbox' && f.chosen?.length) {
      const keep = (Array.isArray(capped) ? capped : [capped]).map((x) => lc(x));
      for (const o of f.options) {
        if (keep.includes(lc(o.label))) continue;
        const box = page.locator(o.selector).first();
        if (!(await box.isChecked().catch(() => false))) continue;
        await box.uncheck({ timeout: 8000 }).catch(() => box.click({ force: true, timeout: 8000 }));
      }
    }

    const before = state.blocked_on.length + state.left_for_human.length;
    const ok = await fill(page, f, capped);
    if (ok === false || state.blocked_on.length + state.left_for_human.length > before) {
      review.refused.push(`${f.question.slice(0, 60)}: correction did not stick`);
      continue;
    }
    // An earlier pass may have reported this very field as blank or
    // unanswerable. It is answered now, and leaving those lines in the report
    // sends the human to review a field that no longer needs them.
    const stale = f.question.slice(0, 40);
    const notStale = (m) => !(m.includes(stale)
      && /left blank|unanswered|is still empty|did not take|no option/i.test(m));
    state.left_for_human = state.left_for_human.filter(notStale);
    state.blocked_on = state.blocked_on.filter(notStale);

    review.corrections.push({
      question: f.question.slice(0, 90),
      from: current ? redact(f.question, current) : '(blank)',
      to: redact(f.question, capped),
      why,
    });
    log(`review: fixed "${f.question.slice(0, 55)}" `
      + `${current ? `${redact(f.question, current)} -> ` : ''}${redact(f.question, capped)} (${why})`);

    // The next run should not have to be corrected in the same place. A
    // correction is a better answer to the same question, so it replaces the
    // cached one under the same scoping rules.
    if (!fromProfile) {
      cacheStore(cache, company, f.question, {
        answer: capped,
        question: f.question,
        kind: f.kind,
        source: `model-review:${process.env.ATS_Q_MODEL || 'claude-sonnet-5'}`,
        saved_at: new Date().toISOString().slice(0, 10),
      });
      cacheDirty = true;
    }
  }

  for (const u of (Array.isArray(out.still_unanswerable) ? out.still_unanswerable : [])) {
    const f = all.find((x) => x.key === u.key);
    if (f && currentOf(f)) continue;                   // it got answered anyway
    review.unanswerable.push(`${(f?.question || u.key).slice(0, 80)} — ${String(u.why || '').slice(0, 120)}`);
  }

  if (cacheDirty) {
    saveAnswerCache(ats, cache);
    state.answer_cache_updated = true;
  }

  // Re-filling pushes the same key onto verified a second time; the count is
  // read as "fields on this form that hold a verified answer".
  state.verified = [...new Set(state.verified)];

  log(`review: ${review.corrections.length} corrected, ${review.refused.length} refused, `
    + `${review.unanswerable.length} still unanswerable`);
}
