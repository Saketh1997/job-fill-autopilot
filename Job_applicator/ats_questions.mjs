// ats_questions.mjs — the "everything the plan could not answer" layer for the
// greenhouse / lever / ashby drivers.
//
// The split is the same one amazon_apply.mjs uses, and for the same reason:
//
//   scrape the questions off the DOM (no model)
//     -> answer from cache/{ats}-answers.json (no model)
//     -> ONE text-only model call for whatever is left, which never sees the page
//     -> fill from the DOM and read every value back (no model)
//
// The model is asked once per run, with every unanswered question in a single
// message together with the CV, profile.json, the JD and the candidate's own
// background files. It never sees the browser and it never fills anything.
//
// The cache is per ATS and is the reason the second application to the same
// board is nearly free. Scoping is the rule make_plan.py already established:
// a question that is genuinely the same everywhere ("Additional information",
// "How did you hear about us") is cached globally; anything else is cached
// under the company, because replaying "Why do you want to work here?" from one
// employer into another's form would be worse than leaving it blank.
//
// An answer the model declines to give stays blank and blocks the run if the
// field is required. Abstentions are never cached: a blank must be re-asked,
// not made permanent.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE, norm, lc, fileHasBytes, sameValue, matchSelfId as matchSelfIdLabel,
  openMenuOptions,
} from './ats_apply_common.mjs';

// ------------------------------------------------------------------ scraping
// Portal-agnostic. Identity is a data-atsq marker written onto the live
// element, so a control with no name and no id fills like any other.
export async function scrapeQuestions(page, formSel, { skip = [] } = {}) {
  return page.evaluate(({ formSel: sel, skip: skipKeys }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector(sel) || document;

    const boxed = (n) => !!(n && n.getBoundingClientRect && n.getBoundingClientRect().width > 0);
    const isVisible = (el) => {
      if (boxed(el)) return true;
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (boxed(l)) return true;
      }
      let e = el.parentElement;
      for (let i = 0; i < 4 && e; i++, e = e.parentElement) if (boxed(e)) return true;
      return false;
    };

    const questionFor = (el) => {
      // Lever nests each radio option in its own <li> inside the question's
      // <li>, so closest('li') returns the OPTION and the question comes back
      // as "Yes". The question always lives in .application-label.
      const card = el.closest('.application-question');
      const lever = card?.querySelector('.application-label .text, .application-label');
      if (lever && clean(lever.textContent)) return clean(lever.textContent).replace(/✱/g, '').slice(0, 300);
      // Ashby: one entry per question, its <label> is the question, and the
      // control's own label is nothing at all.
      const ashby = el.closest('[data-field-path]')?.querySelector('label');
      if (ashby && clean(ashby.textContent)) return clean(ashby.textContent).slice(0, 300);
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent).slice(0, 300);
      }
      const byLabelledBy = el.getAttribute('aria-labelledby');
      if (byLabelledBy) {
        const t = byLabelledBy.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent))
          .filter(Boolean).join(' ');
        if (t) return t.slice(0, 300);
      }
      const box = el.closest('.question, .application-question, [class*="field"], .form-group, fieldset, li');
      if (box) {
        const own = clean(box.querySelector('label, legend, [class*="label"]')?.textContent);
        if (own) return own.slice(0, 300);
        const first = (box.innerText || '').split('\n').map((s) => s.trim())
          .filter((s) => s.length > 3)[0];
        if (first) return first.slice(0, 300);
      }
      // Greenhouse's education block is the case this exists for: the visible
      // label belongs to a hidden input, and react-select's own input is a
      // sibling with no label pointing at it, so a required control came back
      // as "(unlabelled field)" three times on one form and the model rightly
      // refused to answer a question it could not read. The nearest label-ish
      // node ABOVE the control in document order is that question.
      let scan = el;
      for (let hop = 0; hop < 4 && scan; hop++) {
        for (let sib = scan.previousElementSibling; sib; sib = sib.previousElementSibling) {
          const t = clean(sib.matches('label, legend, h1, h2, h3, h4, [class*="label"]')
            ? sib.textContent
            : sib.querySelector?.('label, legend, [class*="label"]')?.textContent);
          if (t && t.length > 2) return t.slice(0, 300);
        }
        scan = scan.parentElement;
      }
      return clean(el.getAttribute('aria-label')) || clean(el.name) || '(unlabelled field)';
    };

    // The help text under a question carries the qualifier that changes the
    // answer — "At this moment, we're unable to provide visa support." is what
    // makes the sponsorship question answerable one way rather than the other.
    const descriptionFor = (el) => {
      const entry = el.closest('[data-field-path], .application-question, .form-group');
      const d = entry?.querySelector(
        '[class*="description"], .application-question-description, .help-text, small',
      );
      return d ? clean(d.textContent).slice(0, 300) : '';
    };

    const optionLabel = (input) => {
      if (input.id) {
        const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      return clean(input.closest('label')?.textContent) || clean(input.value);
    };

    // Seed the counter past every marker ALREADY on the page. A second pass
    // that restarts at q1 hands an existing id to a different element, and
    // `[data-atsq="q1"]` then matches two controls — that is how the CC-305
    // signature fields "did not take the answer" while the value went into the
    // Pronouns checkbox instead.
    let marker = 0;
    for (const el of document.querySelectorAll('[data-atsq]')) {
      const n = parseInt((el.getAttribute('data-atsq') || '').slice(1), 10);
      if (n > marker) marker = n;
    }
    const mark = (el) => {
      if (!el.getAttribute('data-atsq')) el.setAttribute('data-atsq', `q${++marker}`);
      return el.getAttribute('data-atsq');
    };

    // A marker attribute is the fallback, not the first choice. React re-renders
    // the form after every answer and the replacement nodes carry no data-atsq,
    // so a marker-based selector from an earlier pass points at nothing — that
    // is the "control vanished before it could be filled" on fields that were
    // sitting right there. Anything the framework itself keys the field by
    // survives a re-render; prefer it.
    const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');
    const stableSel = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name && document.querySelectorAll(`[name="${cssEscape(el.name)}"]`).length === 1) {
        return `[name="${cssEscape(el.name)}"]`;
      }
      const entry = el.closest('[data-field-path]');
      if (entry) {
        const path = entry.getAttribute('data-field-path');
        const tag = el.tagName.toLowerCase();
        const sibs = [...entry.querySelectorAll(tag)];
        const idx = sibs.indexOf(el);
        return sibs.length === 1
          ? `[data-field-path="${cssEscape(path)}"] ${tag}`
          : `[data-field-path="${cssEscape(path)}"] ${tag}:nth-of-type(${idx + 1})`;
      }
      return `[data-atsq="${mark(el)}"]`;
    };

    // react-select keeps its choice in a sibling node, not in the input — and a
    // MULTI select keeps one chip per choice with no single-value node at all,
    // which is how an answered "How did you hear about us?" came back unanswered
    // on the next pass and was filled a second time.
    const shownValue = (el) => {
      const shell = el.closest('.select__container, [class*="select-shell"], [class*="Select"]');
      const shown = shell?.querySelectorAll(
        '.select__single-value, [class*="singleValue"], .select__multi-value, [class*="multiValue"]',
      );
      return shown?.length
        ? [...shown].map((n) => clean(n.textContent)).filter(Boolean).join(', ') : '';
    };

    const out = [];
    const seenGroup = new Set();

    for (const el of root.querySelectorAll('input, select, textarea')) {
      const type = (el.type || '').toLowerCase();
      if (el.disabled) continue;
      if (['hidden', 'submit', 'button', 'file', 'image', 'reset', 'search'].includes(type)) continue;
      if (!isVisible(el)) continue;
      if (skipKeys.includes(el.name) || skipKeys.includes(el.id)) continue;

      const required = !!(el.required || el.getAttribute('aria-required') === 'true'
        || /\*/.test(clean(document.querySelector(`label[for="${CSS.escape(el.id || '_')}"]`)?.textContent || '')));

      // Ashby's Yes/No question is a pair of <button>s next to a proxy
      // checkbox that NEVER changes state. Reading the checkbox reports the
      // question as unanswered forever, and the checkbox carries no label, so
      // the model was being offered a single option called "on" — it could not
      // tell what checking it would assert. The buttons are the real control.
      const yesno = el.closest('[class*="yesno"], [class*="_container_1svni"]');
      if (type === 'checkbox' && yesno && yesno.querySelector('button')) {
        const buttons = [...yesno.querySelectorAll('button')];
        const active = buttons.find((b) => /_active|selected/i.test(b.className));
        out.push({
          key: mark(el),
          kind: 'buttongroup',
          question: questionFor(el),
          description: descriptionFor(el),
          required,
          selector: stableSel(el),
          value: active ? clean(active.textContent) : '',
          chosen: active ? [clean(active.textContent)] : [],
          options: buttons.map((b) => ({
            label: clean(b.textContent), selector: stableSel(b),
          })),
        });
        continue;
      }

      if (type === 'radio' || type === 'checkbox') {
        const groupKey = el.name || questionFor(el);
        if (seenGroup.has(groupKey)) continue;
        seenGroup.add(groupKey);
        const group = el.name
          ? [...root.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
        out.push({
          key: mark(el), kind: type, question: questionFor(el),
          description: descriptionFor(el),
          required: required || group.some((g) => g.required),
          selector: stableSel(el),
          value: group.some((g) => g.checked) ? 'answered' : '',
          // "answered" is enough to decide whether to fill it; it is not enough
          // to decide whether the answer is RIGHT. The review pass needs the
          // labels themselves, so carry them alongside rather than in place.
          chosen: group.filter((g) => g.checked).map((g) => optionLabel(g)),
          options: group.map((g) => ({ label: optionLabel(g), selector: stableSel(g) })),
        });
        continue;
      }

      if (el.tagName === 'SELECT') {
        out.push({
          key: mark(el), kind: 'select', question: questionFor(el),
          description: descriptionFor(el), required,
          selector: stableSel(el), value: el.value || '',
          // el.value is the option's VALUE ("2"); the review pass compares
          // labels, which is what the model was given and what a human reads.
          chosen: el.value && el.selectedIndex >= 0
            ? [clean(el.options[el.selectedIndex].textContent)] : [],
          options: [...el.options].filter((o) => o.value !== '')
            .map((o) => ({ label: clean(o.textContent), value: o.value })),
        });
        continue;
      }

      // A react-select input looks like a textbox but is a choice control. Its
      // options only exist in the DOM once opened, so they are harvested in a
      // second pass by the caller.
      // A react-select is a choice control wearing a textbox's clothes, and it
      // does not always say so on the input itself: Greenhouse's School control
      // carries neither role=combobox nor .select__input on some boards, so it
      // was filled with fill(), react-select dropped the text on blur, and the
      // run reported "School* did not take the answer" for a field that was
      // never a text field. The container is the reliable tell.
      const combo = el.getAttribute('role') === 'combobox'
        || /select__input/.test(el.className || '')
        || /^react-select/.test(el.id || '')
        || !!el.closest('.select__control, .select__container, [class*="select-shell"]')
        || (el.getAttribute('aria-autocomplete') === 'list'
          && el.getAttribute('aria-haspopup') === 'listbox');
      out.push({
        key: mark(el),
        kind: combo ? 'combobox' : (el.tagName === 'TEXTAREA' ? 'textarea' : 'text'),
        question: questionFor(el),
        description: descriptionFor(el),
        required,
        selector: stableSel(el),
        value: el.value || shownValue(el),
        chosen: [],
        options: [],
        maxlength: el.maxLength > 0 ? el.maxLength : undefined,
      });
    }
    // "If yes, where?" is not a question anyone can answer on its own. Read
    // alone it invites an answer to the wrong thing — this form's "If yes,
    // where?" follows "Do you have experience working as an Infrastructure
    // Engineer?", and it came back answered with relocation preferences. Carry
    // the question it depends on so the model can see what "yes" referred to,
    // and so it can leave the field blank when the answer was no.
    for (let i = 1; i < out.length; i++) {
      if (!/^if (yes|so|applicable|any|selected)/i.test(out[i].question)) continue;
      out[i].depends_on = out[out.length > i ? i - 1 : i].question;
      out[i].question = `[follow-up to "${out[i - 1].question}"] ${out[i].question}`;
    }

    return out;
  }, { formSel, skip });
}

// A combobox's legal answers are only in the DOM while it is open. Harvest them
// before the model is asked, so the model is choosing from the form's own list
// rather than being asked to guess the phrasing.
export async function harvestOptions(page, field) {
  const el = page.locator(field.selector).first();
  if (!(await el.count())) return [];
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 8000 }).catch(() => el.click({ force: true, timeout: 8000 }));
  await page.waitForTimeout(500);
  // Scoped to the menu this control owns. A global option sweep here reads the
  // phone widget's 244 hidden countries instead of the question's own answers,
  // and then hands that list to the model as the legal choices.
  let { texts } = await openMenuOptions(page, el);

  // Ashby's combobox renders NOTHING on a click into the input — it says "Start
  // typing..." and means it. Its own chevron opens the full list, and without
  // that the model was handed "How did you hear about us?" with no options at
  // all, answered it in prose, and the field stayed empty: Applied Intuition
  // refused the submit with "Missing entry for required field: How did you hear
  // about us?", and Notion failed the same way this morning.
  if (!texts.length) {
    const toggle = el.locator('xpath=following-sibling::button').first();
    if (await toggle.count().catch(() => 0)) {
      await toggle.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      ({ texts } = await openMenuOptions(page, el));
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return [...new Set(texts.map(([, t]) => t))].map((label) => ({ label }));
}

// ------------------------------------------------- deterministic first pass
// The same principle make_plan.py's pass 1 encodes: a structured fact is read
// off profile.json, never asked of a model. These are only the fields whose
// answer is a fact about the candidate rather than a judgement about the role,
// so nothing here can be "answered" wrongly by paraphrase.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// profile.json stores education dates as ISO (YYYY-MM-DD); forms ask for the
// month and the year as separate controls.
const monthName = (iso) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return m ? MONTHS[Number(m[2]) - 1] : undefined;
};
const yearOf = (iso) => {
  const m = /^(\d{4})/.exec(String(iso || ''));
  return m ? m[1] : undefined;
};

const PROFILE_RULES = [
  [/^preferred (first )?name|^nickname/i, (p) => p.first_name],
  [/^first name/i, (p) => p.first_name],
  [/^last name|surname/i, (p) => p.last_name],
  [/^(full |legal )?name$|^your name/i, (p) => `${p.first_name} ${p.last_name}`],
  [/e-?mail/i, (p) => p.email],
  [/phone|mobile|telephone/i, (p) => p.phone],
  [/linkedin/i, (p) => p.linkedin],
  [/github/i, (p) => p.github],
  [/website|portfolio|personal site|personal url/i, (p) => p.website],
  // The phone-country control on Greenhouse labels itself "Country*" and its
  // options read "United States +1"; the prefix match in answerRemaining maps
  // the plain profile value onto that.
  [/^country/i, (p) => p.address?.country || p.country],
  // "Where do you currently reside?" is a COUNTRY control on some boards and a
  // city control on others, and the wording alone does not say which. KAYAK's
  // (Ashby) offers "UNITED STATES OF AMERICA" next to "UNITED STATES MINOR
  // OUTLYING ISLANDS"; nothing was answered at all and the submit came back
  // "Missing entry for required field" twice (2026-08-12). Answer it with the
  // country: matchCountry maps the plain profile value onto whatever the control
  // calls it, and on a genuine city control the answer simply finds no option
  // and falls through to fallbackCity rather than committing something wrong.
  [/where do you (currently )?(reside|live)|country of residence|^residence/i,
    (p) => p.address?.country || p.country],
  // Asked verbatim by DMC Engineering, and the honest answer is a fact about the
  // candidate that no other rule carries.
  [/reliable vehicle|access to a (car|vehicle)|own a (car|vehicle)|valid driver'?s? licen[cs]e/i,
    (p) => p.application_questions?.has_reliable_vehicle_for_work_travel],
  // Education. Greenhouse's education block asks School / Degree / Discipline as
  // separate typeaheads; Degree and Discipline resolved from the plan but School
  // had no rule at all and blocked the AEG run on a fact sitting in profile.json.
  // Education dates. Greenhouse's education block labels these "Start date
  // month/year" and "End date month/year", and with no rule for them the model
  // read "start date" as employment availability and answered August 2026 — the
  // candidate's availability date — against an end date of June 2026, so the
  // board rejected the submit with "End date must be after start date." These
  // are enrolment dates and they come from profile.json, never from a model.
  [/^start date month|start month/i, (p) => monthName(p.education?.started)],
  [/^start date year|start year/i, (p) => yearOf(p.education?.started)],
  [/^end date month|end month|graduation month/i, (p) => monthName(p.education?.graduated)],
  [/^end date year|end year|graduation year/i, (p) => yearOf(p.education?.graduated)],

  // High school before the generic school rule: "High School Name" contains
  // "school" and would otherwise collect the university. Palantir requires both.
  [/high ?school name|name of.*high ?school/i, (p) => p.education?.high_school],
  [/(year|date).*high ?school|high ?school.*(graduat|year)/i,
    (p) => p.education?.high_school_graduated],
  // GPA. Undergraduate first — "GPA (Undergraduate)" contains "GPA" and would
  // otherwise collect the master's figure. profile.json carries both.
  [/(undergrad|bachelor|b\.?tech|b\.?s\b).{0,25}gpa|gpa.{0,25}(undergrad|bachelor|b\.?tech)/i,
    (p) => p.education?.undergraduate_GPA],
  [/\bgpa\b|grade point/i, (p) => p.education?.GPA],
  [/^school|university|college|institution/i, (p) => p.education?.school],
  [/^degree/i, (p) => p.education?.degree],
  [/^discipline|^major|field of study/i, (p) => p.education?.minor && p.education?.degree
    ? p.education.degree.replace(/^(ms|bs|ba|ma|phd)\s+/i, '') : undefined],
  // The CC-305 voluntary self-ID block signs itself with the candidate's own
  // name and today's date. Both are facts, not judgements, so neither goes to a
  // model — but they ARE a signature on a disclosure form, so the run log names
  // them explicitly rather than burying them among the other filled fields.
  [/^date$|signature date|today'?s date/i, () => {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  }],
  // Voluntary self-ID the candidate has NOT recorded, and which must therefore
  // resolve to an explicit decline rather than fall through to a model that
  // improvises one. On 2026-08-29 a single batch asserted "Heterosexual" on
  // three forms (Together AI, Luma, Vercel) and "Under 30" on a fourth; none of
  // it was sourced from anywhere, and each was a claim about a real person on
  // an employer's form. CLAUDE.md is explicit that a question with no truthful
  // answer in profile.json/cv.md/data must not be answered.
  //
  // ORDER MATTERS: /gender/ is unanchored and matches the substring inside
  // "transgender", so before this rule existed "Do you identify as
  // transgender?" was answered from profile.gender ("Male") — a wrong answer
  // to a different question, not merely a readback artefact.
  [/transgender/i, (p) => p.transgender_status],
  [/sexual orientation|how do you identify your sexuality|\blgbtq?\b/i, (p) => p.sexual_orientation],
  [/what is your (current )?age\b|\bage (range|bracket|group|band)\b/i, (p) => p.age_bracket],
  // Provenance. The scanner found the posting on a job board; anything naming a
  // person or an event is a fabrication. See the note beside the profile key.
  [/how did you (first )?hear|how did you (first )?discover|where did you (first )?hear|referral source/i,
    (p) => p.application_questions?.how_did_you_hear_about_this_role],
  [/gender|what is your sex/i, (p) => p.gender],
  [/hispanic|latino/i, (p) => (/hispanic|latino/i.test(p.race_ethnicity || '') ? 'Yes' : 'No')],
  [/race|ethnic/i, (p) => p.race_ethnicity],
  [/veteran/i, (p) => p.veteran_status],
  [/disab/i, (p) => p.disability_status],
];

// "Do you require sponsorship?" has two truthful answers depending on what is
// being asked, and profile.json holds both (set by the candidate 2026-08-10):
//   - employer sponsors, or says nothing  -> Yes. F-1 OPT, H1B needed eventually.
//   - employer states it CANNOT sponsor   -> No. OPT + STEM OPT authorize ~3
//     years with no sponsorship at all, which is what that employer is actually
//     asking about.
// The switch is the employer's own words on the page (the question text or the
// help text under it), never an assumption about the company.
const CANNOT_SPONSOR = /(unable|not able|cannot|can't|do not|don't|no ability)\b[^.]{0,40}\b(sponsor|visa support|sponsorship)|(sponsorship|visa support)\b[^.]{0,30}\b(not available|is not offered|unavailable)/i;

function sponsorshipAnswer(profile, context) {
  const aq = profile.application_questions || {};
  return CANNOT_SPONSOR.test(context || '')
    ? (aq.require_sponsorship_when_employer_cannot_sponsor || 'No')
    : (aq.require_sponsorship_now_or_future || 'Yes');
}

export function resolveFromProfile(question, profile, context = '') {
  if (/require.*(visa|employment)?.*sponsor|sponsorship/i.test(question || '')) {
    return sponsorshipAnswer(profile, `${question} ${context}`);
  }
  for (const [re, fn] of PROFILE_RULES) {
    if (!re.test(question || '')) continue;
    const v = fn(profile);
    if (v) return String(v);
  }
  return null;
}

// ------------------------------------------------------------------- cache
// cache/{ats}-answers.json. Written on every new answer, read before every
// model call, and safe to hand-edit: an entry added by hand is indistinguishable
// from one the model produced, which makes it the manual-answer channel too.
// ONLY questions whose answer is a fact about the candidate that does not
// change between employers. Open-ended prompts ("Anything else you'd like us to
// know?", "Additional information", "Questions for us?") are deliberately NOT
// here: their answers get written about THIS role, and one of them was already
// caught naming "Infrastructure Engineer" while cached globally — one step from
// being replayed into an unrelated company's form.
const GENERIC = [
  /how did you hear/i,
  /^pronouns/i,
  /^website|^portfolio|^linkedin|^github|^country|^phone/i,
  /notice period|earliest start|when can you start/i,
  /require.*sponsor|sponsorship/i,
  /authoriz(ed|ation) to work|right to work/i,
  /willing to relocate|open to relocat/i,
  /salary|compensation expect|desired pay/i,
];

export function normalizeQuestion(q) {
  return lc(q).replace(/\(optional\)|\(required\)|\*/g, ' ')
    .replace(/[^a-z0-9 ?]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Some questions LOOK generic and are not, because their meaning depends on
// which posting is asking. "Are you legally authorized to work in the country
// you are applying to?" is one question text with a different true answer per
// country, and caching it globally replayed Celonis's Copenhagen "No" as the
// answer to US postings — a self-rejection with no model call in the way.
// A question that names its country ("...in the United States?") is safe;
// one that says "that country" / "the country you are applying to" is not.
const COUNTRY_RELATIVE =
  /\b(that|this|the) country\b|country (you|for which|to which|in which|they)|country of (the )?(role|position|employment)/i;

export function isGeneric(q) {
  const n = normalizeQuestion(q);
  if (COUNTRY_RELATIVE.test(n)) return false;
  return GENERIC.some((re) => re.test(n));
}

export function cachePath(ats) {
  return path.join(BASE, 'cache', `${ats}-answers.json`);
}

export function loadAnswerCache(ats) {
  const p = cachePath(ats);
  if (!fileHasBytes(p)) return { global: {}, companies: {} };
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { global: c.global || {}, companies: c.companies || {} };
  } catch {
    return { global: {}, companies: {} };
  }
}

export function saveAnswerCache(ats, cache) {
  const p = cachePath(ats);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cache, null, 2)}\n`);
}

export function cacheLookup(cache, company, question) {
  const n = normalizeQuestion(question);
  if (isGeneric(question)) return cache.global[n];
  return (cache.companies[lc(company)] || {})[n];
}

export function cacheStore(cache, company, question, entry) {
  const n = normalizeQuestion(question);
  if (isGeneric(question)) {
    cache.global[n] = entry;
  } else {
    const key = lc(company);
    cache.companies[key] = cache.companies[key] || {};
    cache.companies[key][n] = entry;
  }
}

// -------------------------------------------------------------- model call
// ONE call. Every unanswered question in a single message, together with the
// CV, profile.json, the JD and the background files. No tools, no browser.
// The rules that make an answer legitimate. Exported because the review pass
// (ats_review.mjs) judges answers by exactly these — a second prompt with its
// own paraphrased copy would drift, and the drift would show up as the review
// pass "correcting" a correct answer into a rule violation.
export const ANSWER_RULES = `- Answer ONLY from the sources below. Never invent an experience, a metric, an employer, or a project.
- profile.json is authoritative for structured facts (contact, salary, dates, work authorization).
- Sponsorship: always Yes. F-1 OPT, EAD holder, will require H1B sponsorship in the future. Never state that sponsorship is not required.
- JURISDICTION. Work authorization and salary are facts about ONE country. The F-1 OPT EAD
  authorizes work in the United States and nowhere else, and the salary figure in profile.json
  is a US number. If this posting is outside the US (check the JD's location), "Are you legally
  authorized to work here?" CANNOT be answered from these sources — return null. Answering "Yes"
  because the candidate holds a US EAD is a false statement on a real application: it was nearly
  put on a Copenhagen posting (2026-08-11). make_plan.py blocks these deliberately for non-US
  roles; do not "fix" a blank it left.
- Experience questions mean PROFESSIONAL, non-internship experience unless the question says otherwise. Coursework, personal projects and research are not professional employment.
- Never claim the candidate built a tool, library or framework they only used. The open-source career-ops framework is not their work.
- Do not overstate: no deep computer vision work, beginner CUDA only, no terabyte-scale pipeline claims. The VLDB paper was submitted and is under revision. ROS2/Gazebo/Nav2/ESP32 exposure is coursework and self-study.
- Any personal or portfolio website field gets https://sakethmetta.org
- WHERE THE CANDIDATE IS. A question about where he lives, is based, or will be spending a
  period of time is a FACT, answered only from profile.json's address. If the options name
  specific places and none of them is where he actually is, pick "Other" when it is offered
  and otherwise return null. Never pick the most convenient-looking city: Palantir's "Where
  are you spending summer 2026?" was answered "New York City or somewhere nearby" for a
  candidate whose address is in Pennsylvania, which is simply untrue. Willingness to
  relocate is a different question and does not license a claim about present location.
- For a control WITH options you MUST return one of that control's option labels, copied verbatim (an array for checkbox groups). Never a value, never a paraphrase.
- BUCKETS. When the options are ranges or categories and the fact is a specific value, answer with the
  bucket that CONTAINS the fact — never the raw fact. profile.json says the earliest start date is
  2026-08-25, and a control offering "By end of September 2026 / Between September 2026 - December 2026 /
  After January 2027" is answered "By end of September 2026". Returning "August 25, 2026" there is not a
  more precise answer, it is an answer the form cannot accept. Same for a graduation-date control offering
  date ranges, and for a degree control offering "Master's Degree" when the fact is "MS Computer Science".
  If no bucket contains the fact, that is a null, not the nearest-looking bucket.
- Free text: natural, direct voice, no em dashes, 100-180 words unless the question asks otherwise. Respect maxlength when given.
- A question marked [follow-up to "..."] is CONDITIONAL on that other question. Answer it only if the truthful answer to the question it depends on is yes; otherwise return null. Never answer it as if it were about something else.`;

// Everything about talking to the model that is not the prompt: the sandbox,
// the prompt file, the retry wrapper, the result line, the cost.
//
// It is shared rather than copied because each piece of it is a bug that was
// already paid for once — the prompt goes in a FILE because a 130KB argv died
// with E2BIG, the call is routed through claude_retry.sh because "auto/best-coding" is
// an OmniRoute alias that 404s against api.anthropic.com, and it runs from an
// empty cwd with MCP off so career-ops's own CLAUDE.md is not loaded into a
// prompt that needs none of it.
export function runModel({ prompt, slug, logName, state, log, what, timeout = 900000 }) {
  const model = process.env.ATS_Q_MODEL || 'claude-sonnet-5';
  const qLog = path.join(BASE, 'logs', `${slug}-${logName}.log`);
  fs.mkdirSync(path.dirname(qLog), { recursive: true });

  const sandbox = fs.mkdtempSync('/tmp/ats-questions-');
  const promptFile = path.join(sandbox, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt);
  const script = 'source "$1" >/dev/null 2>&1 || exit 3; '
    + 'run_claude "$2" -p --model "$3" --output-format json '
    + '--allowedTools "" --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" '
    + '--max-turns 4 --strict-mcp-config --mcp-config \'{"mcpServers":{}}\'';

  try {
    execFileSync('bash', ['-c', script, 'atsq', path.join(BASE, 'claude_retry.sh'), qLog, model], {
      cwd: sandbox, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CLAUDE_PROMPT_FILE: promptFile },
    });
  } catch (e) {
    state.blocked_on.push(`the ${what} call failed (see logs/${path.basename(qLog)}): ${String(e.message || e).slice(0, 160)}`);
    return null;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  let text;
  try {
    const lines = fs.readFileSync(qLog, 'utf8').split('\n').filter((l) => l.includes('"type":"result"'));
    if (!lines.length) throw new Error('no result line in the log');
    const env = JSON.parse(lines[lines.length - 1]);
    if (env.is_error) throw new Error(String(env.result || 'model returned is_error').slice(0, 160));
    text = String(env.result || '');
    // Two calls per run now. Accumulate, or the review pass silently erases
    // what the question pass cost and every per-posting figure is wrong.
    state.model_cost_usd = Number(((state.model_cost_usd || 0) + (env.total_cost_usd || 0)).toFixed(6));
  } catch (e) {
    state.blocked_on.push(`could not read the model result from logs/${path.basename(qLog)}: ${String(e.message || e).slice(0, 200)}`);
    return null;
  }

  const json = text.match(/\{[\s\S]*\}/);
  const raw = json ? json[0] : text;
  try {
    return JSON.parse(raw);
  } catch {
    // A long free-text answer sometimes comes back one closing brace short —
    // the model's own formatting slip, not a truncated response. That cost a
    // whole $0.25 question pass and blocked the posting over a missing "}".
    // Only balance when the scan ends OUTSIDE a string: a response cut off
    // mid-answer ends inside one, and quietly closing that would invent an
    // answer rather than repair a delimiter.
    const repaired = balance(raw);
    if (repaired !== raw) {
      try {
        const out = JSON.parse(repaired);
        log(`${what}: repaired ${repaired.length - raw.length} missing closing bracket(s)`);
        return out;
      } catch { /* fall through to blocked_on */ }
    }
    state.blocked_on.push(`the ${what} call did not return JSON: ${text.slice(0, 200)}`);
    return null;
  }
}

// Append the closers an unbalanced-but-complete JSON body is missing. Returns
// the input unchanged when it ends inside a string or is already balanced.
function balance(s) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr || !stack.length) return s;
  return s + stack.reverse().join('');
}

export function askModel({ fields, slug, jdPath, profile, state, log }) {
  const read = (p, cap = 8000) => { try { return fs.readFileSync(p, 'utf8').slice(0, cap); } catch { return ''; } };
  const dataDir = path.join(BASE, 'data');
  const background = ['about_me.txt', 'work_experience.txt', 'technical_skills.txt',
    'education.txt', 'strengths.txt', 'career_goals.txt', 'current_projects.txt',
    'suitability_swe.txt', 'suitability_ml.txt']
    .map((f) => { const t = read(path.join(dataDir, f), 4500); return t ? `--- data/${f} ---\n${t}` : ''; })
    .filter(Boolean).join('\n\n');

  // Credentials never enter a prompt.
  const safeProfile = JSON.parse(JSON.stringify(profile));
  for (const k of Object.keys(safeProfile)) if (/password|secret|token|credential/i.test(k)) delete safeProfile[k];

  // The tailored resume is the CV that is actually being attached, so it is
  // what the answers must be consistent with.
  const resumeMd = read(path.join(BASE, 'cv.md'), 12000) || read(path.join(BASE, '..', 'cv.md'), 12000);

  const prompt = `You are answering the remaining questions on a job application for Saketh Metta. You are given the questions parsed off the form, the resume being attached, profile.json, the job description and the candidate's own background files. Return JSON only.

RULES
${ANSWER_RULES}
- If a question cannot be answered truthfully from these sources, set its answer to null and list it in "unanswerable". A blocked run is better than a wrong answer.
- Key every answer by the control's "key".

QUESTIONS
${JSON.stringify(fields.map((f) => ({
    key: f.key, question: f.question, kind: f.kind, required: f.required,
    options: f.options.map((o) => o.label), maxlength: f.maxlength,
  })), null, 2)}

RESUME BEING ATTACHED (cv.md)
${resumeMd}

PROFILE (profile.json)
${JSON.stringify(safeProfile, null, 2)}

JOB DESCRIPTION (jd/${slug}.txt)
${read(jdPath, 12000)}

CANDIDATE BACKGROUND
${background}

OUTPUT
Reply with the JSON as your message text. Do not call any tool, do not run any command — just write it.
A single JSON object, nothing else:
{"answers": {"<key>": <option label | array of option labels | free text | null>, ...},
 "unanswerable": [{"key": "<key>", "why": "<one line>"}]}`;

  log(`asking the model to answer ${fields.length} question(s) in one call `
    + `(model=${process.env.ATS_Q_MODEL || 'claude-sonnet-5'}, ${Math.round(prompt.length / 1024)}KB prompt on stdin, `
    + 'no tools, no browser)');
  const out = runModel({ prompt, slug, logName: 'questions', state, log, what: 'question' });
  if (!out) return null;
  out.answers = out.answers || {};
  out.unanswerable = out.unanswerable || [];

  // The form, not the model, decides what is a legal answer.
  //
  // ...but only where the form has actually told us what it accepts. A native
  // <select> ships its whole option set in the DOM, so an answer outside it is
  // provably wrong. An async typeahead does NOT: Greenhouse's School and
  // Location controls render one alphabetical page until something is typed, so
  // `f.options` is a first page, not a contract. Gating on it deleted correct
  // answers before the filler could type to filter them — "Oregon State
  // University" rejected against a cold list covering only schools starting
  // with A (Five Rings, Smartsheet, AEG), and "Chester Springs, PA" rejected
  // the same way on Location (6 postings).
  //
  // For a combobox the list is therefore advisory: keep the answer and let the
  // combobox filler try it, because that path types to filter, re-reads the
  // menu, and enforces a read-back post-condition that refuses whatever
  // react-select tried to commit on blur. A wrong answer still blocks there —
  // later, with the real option list in the message instead of the cold one.
  for (const f of fields) {
    const v = out.answers[f.key];
    if (v === undefined || v === null) continue;
    if (f.options.length) {
      const legal = f.options.map((o) => lc(o.label));
      const bad = (Array.isArray(v) ? v : [v]).filter((x) => !legal.includes(lc(x)));
      if (bad.length && f.kind === 'combobox') {
        state.notes.push(
          `"${f.question.slice(0, 60)}": ${JSON.stringify(bad)} is not on the control's `
          + 'cold option page — passing it to the typeahead to filter for',
        );
      } else if (bad.length) {
        state.blocked_on.push(
          `model answered "${f.question.slice(0, 80)}" with ${JSON.stringify(bad)}, `
          + `which is not one of that control's option labels`,
        );
        delete out.answers[f.key];
      }
    } else if (f.maxlength && String(v).length > f.maxlength) {
      out.answers[f.key] = String(v).slice(0, f.maxlength);
    }
  }
  return out;
}

// A place name written one way against a menu that writes it another.
// profile.json says "Chester Springs, PA"; Greenhouse's location typeahead
// offers "Chester Springs, Pennsylvania, United States". Exact and prefix
// matching both fail, and the run blocked on a field whose answer was sitting
// in the menu. Match on the locality plus a corroborating region, and only when
// exactly ONE option qualifies — two candidate cities is a guess, and a guess
// about where the candidate lives is precisely what this pipeline must not make.
const STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
};

// Some real addresses are simply absent from the gazetteers these controls
// search. Chester Springs is an unincorporated village: Greenhouse offers
// "Chesterfield, England" and "Chesterfield, Missouri" and nothing else, so
// matchPlace correctly returns undefined and the posting blocks. Six did in the
// 2026-08-11 run. profile.json's address.typeahead_city is the candidate's own
// answer to "what do I put when the box will not take my town" — a nearby city
// they have approved, used ONLY on a city lookup that has already rejected the
// real one, and never on a postal or street-address field.
let PROFILE_CACHE;
function profileAddress() {
  if (PROFILE_CACHE === undefined) {
    try {
      PROFILE_CACHE = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8')).address || {};
    } catch { PROFILE_CACHE = {}; }
  }
  return PROFILE_CACHE;
}

const CITY_CONTROL = /\b(location|city|where.*(live|reside|based)|current.*(location|city))\b/i;

export function fallbackCity(question) {
  if (!CITY_CONTROL.test(String(question || ''))) return '';
  const a = profileAddress();
  return a.typeahead_city || '';
}

// The same country under a different name. DV Trading's control offers "United
// States of America"; the answer was "United States", and exact match failed on
// a field whose answer was sitting in the menu (2026-08-12).
//
// Only names that denote the SAME sovereign state belong in a group. "England"
// is not a synonym for "United Kingdom" and is deliberately absent: picking one
// for the other on a residency question would be a guess about where the
// candidate lives, which is the thing this file must never do.
const COUNTRY_ALIASES = [
  ['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.',
    'united states (usa)', 'america'],
  ['united kingdom', 'united kingdom of great britain and northern ireland', 'uk', 'u.k.'],
  ['india', 'republic of india'],
  ['netherlands', 'the netherlands', 'holland'],
  ['south korea', 'korea, republic of', 'republic of korea'],
  ['united arab emirates', 'uae', 'u.a.e.'],
];

const countryKey = (s) => lc(String(s).replace(/[.’']/g, '').replace(/\s+/g, ' ').trim());

function countryGroup(name) {
  const k = countryKey(name);
  return COUNTRY_ALIASES.find((g) => g.some((a) => countryKey(a) === k));
}

// Same one-unambiguous-hit rule as matchPlace: two acceptable options is a
// guess, and this returns undefined rather than pick.
export function matchCountry(wanted, texts) {
  const group = countryGroup(wanted);
  if (!group) return undefined;
  const hits = texts.filter(([, t]) => group.some((a) => countryKey(a) === countryKey(t)));
  return hits.length === 1 ? hits[0] : undefined;
}

// A control that lists specific acceptable values and then offers "Other" has
// already told you what to do when yours is absent. DV Trading's "re-confirm the
// university you currently attend" enumerates 194 schools — Oregon State is not
// among them — and ends with "Other" (2026-08-12). Selecting it is not a guess
// and not a fabrication: it is the option the form provides for exactly this
// case, and it asserts nothing false.
//
// Deliberately NOT applied where "Other" would misstate a fact about the
// candidate rather than describe an absent list entry. EEO and work-authorization
// answers come from profile.json and must match a real option or block, because
// "Other" on a race or sponsorship control is a different claim, not a fallback.
// "reside"/"country" are here for the same reason as the EEO terms: on a
// residence control "Other" asserts the candidate lives somewhere outside the
// listed countries, which is false. matchCountry is the correct resolver there.
const NEVER_OTHER = /gender|race|ethnic|veteran|disab|pronoun|sponsor|authoriz|visa|citizen|salary|compensation|clearance|reside|residence|^country|country of/i;

export function matchOther(question, texts) {
  if (NEVER_OTHER.test(String(question || ''))) return undefined;
  const hits = texts.filter(([, t]) => /^other\b(\s*\(.*\))?$/i.test(String(t).trim()));
  return hits.length === 1 ? hits[0] : undefined;
}

export function matchPlace(wanted, texts) {
  const parts = String(wanted).split(',').map((s) => lc(s)).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [city, region] = parts;
  const regionFull = STATES[region] || region;
  const hits = texts.filter(([, t]) => {
    const o = lc(t);
    return o.startsWith(`${city},`) && (o.includes(regionFull) || o.includes(`, ${region},`));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

// -------------------------------------------------------------- filling back
// Deterministic, selector-keyed, and read back. Shared by all three drivers so
// "the model answered it" and "the form holds it" can never drift apart.
export async function fillScraped(page, field, value, state) {
  // A failure on an OPTIONAL control is not a reason to stop the run. Only a
  // required field that will not hold its answer blocks; the rest are reported
  // for the human and the application still goes out complete.
  const stop = (msg) => {
    (field.required ? state.blocked_on : state.left_for_human).push(msg);
    return false;
  };

  let el = page.locator(field.selector).first();

  // React re-renders the form after each answer and the replacement node keeps
  // neither the marker attribute nor, on Greenhouse's education block, the same
  // react-select id — so a selector recorded during the scrape can point at
  // nothing by the time its turn comes. That is what "control vanished before
  // it could be filled: Degree*" was: not a missing field, a renamed one. Find
  // it again the way a person would, by the question next to it.
  if (!(await el.count())) {
    const found = await page.evaluate((q) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = clean(q).replace(/\*+$/, '');
      // One marker at a time, or the selector below matches the control this
      // re-find left behind on the previous field as well as the new one.
      for (const old of document.querySelectorAll('[data-atsq-refound]')) {
        old.removeAttribute('data-atsq-refound');
      }
      for (const lab of document.querySelectorAll('label, legend, [class*="label"]')) {
        if (!clean(lab.textContent).replace(/\*+$/, '').startsWith(want.slice(0, 40))) continue;
        const scope = lab.closest('.question, .application-question, [class*="field"], .form-group, fieldset, div');
        const ctl = scope?.querySelector('input:not([type="hidden"]), select, textarea');
        if (!ctl) continue;
        ctl.setAttribute('data-atsq-refound', '1');
        return true;
      }
      return false;
    }, field.question).catch(() => false);
    if (found) {
      el = page.locator('[data-atsq-refound="1"]').first();
      field.selector = '[data-atsq-refound="1"]';
    }
  }
  if (!(await el.count())) {
    return stop(`control vanished before it could be filled: "${field.question.slice(0, 80)}"`);
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});

  const wanted = Array.isArray(value) ? value : [value];

  if (field.kind === 'buttongroup') {
    const opt = field.options.find((o) => lc(o.label) === lc(wanted[0]));
    if (!opt) {
      return stop(`"${String(wanted[0]).slice(0, 40)}" is not one of [${field.options.map((o) => o.label).join(' | ')}] on "${field.question.slice(0, 60)}"`);
    }
    const btn = page.locator(opt.selector).first();
    await btn.click({ timeout: 8000 }).catch(() => btn.click({ force: true, timeout: 8000 }));
    await page.waitForTimeout(400);
    // Selection shows up as an _active_ class on the chosen button; the proxy
    // checkbox stays unchecked either way, so it is not evidence of anything.
    const ok = await btn.evaluate((el) => /_active|selected/i.test(el.className)).catch(() => false);
    if (!ok) return stop(`clicked "${opt.label}" but "${field.question.slice(0, 60)}" did not select it`);
    state.filled.push(`${field.question.slice(0, 50)} = ${redactQ(field.question, opt.label)}`);
    state.verified.push(field.key);
    return true;
  }

  if (field.kind === 'radio' || field.kind === 'checkbox') {
    let hit = false;
    for (const want of wanted) {
      const opt = field.options.find((o) => lc(o.label) === lc(want));
      if (!opt) continue;
      const box = page.locator(opt.selector).first();
      await box.check({ timeout: 8000 }).catch(() => box.click({ force: true, timeout: 8000 }));
      if (await box.isChecked().catch(() => false)) hit = true;
    }
    if (!hit) {
      return stop(`could not check any option for "${field.question.slice(0, 80)}"`);
    }
  } else if (field.kind === 'select') {
    let opt = field.options.find((o) => lc(o.label) === lc(wanted[0]));
    if (!opt) {
      // Same country, different name — see matchCountry.
      const texts = field.options.map((o, i) => [i, o.label]);
      const alt = matchCountry(wanted[0], texts) || matchOther(field.question, texts);
      if (alt) {
        opt = field.options[alt[0]];
        state.notes.push(`"${field.question.slice(0, 60)}": answered "${wanted[0]}",`
          + ` matched the control's own label "${opt.label}"`);
      }
    }
    if (!opt) {
      return stop(`"${String(wanted[0]).slice(0, 40)}" is not an option of "${field.question.slice(0, 60)}"`);
    }
    await page.selectOption(field.selector, opt.value !== undefined ? { value: opt.value } : { label: opt.label })
      .catch(() => {});
    if (!norm(await el.inputValue().catch(() => ''))) {
      return stop(`selected "${opt.label}" but "${field.question.slice(0, 60)}" is still empty`);
    }
  } else if (field.kind === 'combobox') {
    await el.click({ timeout: 8000 }).catch(() => el.click({ force: true, timeout: 8000 }));
    await page.waitForTimeout(500);
    let { sel, texts } = await openMenuOptions(page, el);
    let match = texts.find(([, t]) => lc(t) === lc(wanted[0]));

    // TYPEAHEAD. Greenhouse's School and Location controls load nothing until
    // you type: read cold, the menu is an alphabetical first page, and the AEG
    // run reported "Oregon State University is not present in the given options
    // list (list only covers schools starting with A)". It was right to refuse
    // — the answer genuinely was not on offer yet. Type to filter, then look
    // again, and fall back to the first word for controls that match on prefix.
    // Ashby: the input renders no menu on click ("Start typing..."), but its
    // own chevron opens the whole list. Try that before typing — typing into a
    // control whose menu never opened is what left "How did you hear about us?"
    // empty and blocked Applied Intuition's submit.
    if (!match) {
      const toggle = el.locator('xpath=following-sibling::button').first();
      if (await toggle.count().catch(() => 0)) {
        await toggle.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(800);
        ({ sel, texts } = await openMenuOptions(page, el));
        match = texts.find(([, t]) => lc(t) === lc(wanted[0]));
      }
    }

    if (!match) {
      for (const probe of [String(wanted[0]).slice(0, 40), String(wanted[0]).split(/\s+/)[0]]) {
        // Real key events, not fill(). react-select's async loader listens for
        // the keystroke chain; a fill() sets the value and the menu never
        // refetches, which is why the School typeahead stayed on its cold
        // A-list even after the "type to filter" pass was added.
        await el.fill('').catch(() => {});
        await el.type(probe, { delay: 35 }).catch(() => {});
        await page.waitForTimeout(1200);
        ({ sel, texts } = await openMenuOptions(page, el));
        match = texts.find(([, t]) => lc(t) === lc(wanted[0]))
          || texts.find(([, t]) => lc(t).startsWith(lc(wanted[0])))
          || matchPlace(wanted[0], texts)
          || matchCountry(wanted[0], texts);
        if (match) break;
      }
    }

    // Last resort on a city lookup that does not carry the real town. Same
    // one-unambiguous-hit discipline as matchPlace: a menu offering two
    // Philadelphias is still a guess, and this must not guess.
    // A control the schema calls SELECT can render as a react-select typeahead,
    // so it lands here rather than in the select branch above. DV Trading's
    // university list is exactly that: 195 options ending in "Other", matched
    // by the select branch and missed here until this line existed.
    if (!match) {
      const other = matchOther(field.question, texts);
      if (other) {
        match = other;
        state.notes.push(`"${field.question.slice(0, 60)}": "${wanted[0]}" is not on the`
          + ' control\'s list, selected its own "Other" option');
      }
    }

    if (!match) {
      const alt = fallbackCity(field.question);
      if (alt) {
        await el.fill('').catch(() => {});
        await el.type(String(alt).split(',')[0], { delay: 35 }).catch(() => {});
        await page.waitForTimeout(1200);
        ({ sel, texts } = await openMenuOptions(page, el));
        match = texts.find(([, t]) => lc(t) === lc(alt)) || matchPlace(alt, texts);
        if (match) {
          state.notes.push(`"${field.question.slice(0, 60)}": the form's city list has no`
            + ` "${wanted[0]}", used profile address.typeahead_city "${alt}" instead`);
        }
      }
    }

    let clicked = false;
    if (match) {
      await page.locator(sel).nth(match[0]).click({ timeout: 8000 }).catch(() => {});
      clicked = true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);

    // POST-CONDITION: the control must hold the answer we chose, and nothing
    // else. react-select commits its HIGHLIGHTED option on blur, so a failed
    // match followed by Escape silently accepted whatever was at the top of the
    // cold list — the AEG form ended up asserting "Arizona State University"
    // for a candidate who attends Oregon State. Non-empty is not correct, and
    // that is the one error an audit of empty-vs-filled can never catch.
    const shown = await el.evaluate((n) => {
      const shell = n.closest('.select__container, [class*="select-shell"], [class*="Select"]');
      const v = shell?.querySelectorAll(
        '.select__single-value, [class*="singleValue"], .select__multi-value, [class*="multiValue"]',
      );
      return v && v.length
        ? [...v].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(', ') : '';
    }).catch(() => '');
    // Judge the readback against the option that was actually CLICKED, not
    // against the string we asked for. They differ whenever the match was a
    // prefix: asking for "United States" clicks the option "United States +1",
    // and Greenhouse's phone-country control then renders "+1" beside a flag.
    // Comparing that to "United States" finds no overlap and condemns a
    // perfectly good answer — it blocked the DoorDash run on a field that was
    // correctly set. greenhouse_apply.mjs's own select filler has always
    // compared against the chosen option for this reason.
    const intended = String(wanted[0]);
    const committed = match ? String(match[1]) : intended;
    const ok = clicked && shown && (lc(shown) === lc(committed)
      || lc(shown).includes(lc(committed)) || lc(committed).includes(lc(shown))
      || lc(shown).includes(lc(intended)) || lc(intended).includes(lc(shown)));
    if (!ok) {
      if (shown) {
        // Something was committed that we did not pick. Take it back out rather
        // than leave a false statement on the form.
        const cleared = await el.evaluate((n) => {
          const shell = n.closest('.select__container, [class*="select-shell"], [class*="Select"]');
          const x = shell?.querySelector('.select__clear-indicator, [class*="clearIndicator"]');
          if (x) { x.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; }
          return false;
        }).catch(() => false);
        return stop(`"${field.question.slice(0, 60)}": wanted ${JSON.stringify(intended)} but the control `
          + `committed ${JSON.stringify(shown)}${cleared ? ' (cleared)' : ' — CLEAR IT BY HAND'}`);
      }
      // Say what the control DOES offer. "no option Hindi" is unactionable;
      // "no option Hindi (nearest: Hindustani)" tells a human, or the next
      // run's model, exactly what the form calls the thing.
      const near = texts.map(([, t]) => t)
        .filter((t) => lc(t).slice(0, 4) === lc(intended).slice(0, 4)
          || lc(intended).includes(lc(t)) || lc(t).includes(lc(intended)))
        .slice(0, 4);
      return stop(`no option ${JSON.stringify(intended)} on "${field.question.slice(0, 60)}"`
        + (near.length ? ` — the form offers ${near.map((t) => JSON.stringify(t)).join(', ')}` : ''));
    }
  } else {
    await el.fill('').catch(() => {});
    await el.fill(String(value), { timeout: 10000 }).catch(() => {});
    if (!sameValue(await el.inputValue().catch(() => ''), value)) {
      return stop(`"${field.question.slice(0, 60)}" did not take the answer`);
    }
  }

  state.filled.push(`${field.question.slice(0, 50)} = ${redactQ(field.question, value)}`);
  state.verified.push(field.key);
  return true;
}

// Privacy rule: EEO answers are filled and cached like any other field, but
// their values stay out of run logs that get pasted elsewhere.
function redactQ(question, value) {
  return /gender|race|ethnic|veteran|disab|hispanic|latino/i.test(question || '')
    ? '•••' : String(Array.isArray(value) ? value.join(', ') : value).slice(0, 60);
}

// ------------------------------------------------------------------ the pass
// Cache first, model once for the rest, fill deterministically, verify, then
// write the new answers back to the cache.
export async function answerRemaining({
  page, formSel, ats, company, slug, jdPath, profile, state, log, fill, skip = [],
  pass = 1,
}) {
  // Markers from an EARLIER run are still stamped on a tab this driver reuses,
  // and mark() keeps whatever is already there — so q1 could belong to two
  // different controls before this run even started, and the fill went into the
  // wrong one. Clear them once per run; from here every marker is this run's.
  if (pass === 1) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-atsq]')) el.removeAttribute('data-atsq');
    }).catch(() => {});
  }

  // The JD counts as the employer's own words for questions whose answer turns
  // on what the employer says it can offer (sponsorship).
  let jdText = '';
  try { jdText = fs.readFileSync(jdPath, 'utf8').slice(0, 20000); } catch { /* stage 1 guarantees it */ }

  const all = await scrapeQuestions(page, formSel, { skip });

  // Clear a conditional field whose condition turned out false. Skipping
  // non-empty fields is right in general, but it meant an "If yes, where?"
  // answered on an earlier pass survived after its parent question was answered
  // "No" — and the run still reported ready_to_submit, because nothing
  // re-examines a field that already has text in it. A contradiction left on
  // the form is worse than a blank.
  for (const f of all) {
    if (!f.depends_on || !norm(f.value)) continue;
    const parent = all.find((p) => p.question === f.depends_on
      || f.question.includes(`[follow-up to "${p.question}"]`));
    if (!parent || !/^(no|false)$/i.test(norm(parent.value))) continue;
    const el = page.locator(f.selector).first();
    await el.fill('').catch(() => {});
    if (norm(await el.inputValue().catch(() => ''))) {
      state.blocked_on.push(
        `"${f.question.slice(0, 70)}" still holds an answer even though "${parent.question.slice(0, 50)}" is No — clear it by hand`,
      );
    } else {
      log(`cleared "${f.question.slice(0, 60)}": its condition is answered No`);
      state.cleared = (state.cleared || []).concat(f.question.slice(0, 70));
      f.value = '';
    }
  }

  let fields = all.filter((f) => !norm(f.value));  // already answered, leave it alone
  if (!fields.length) return;

  for (const f of fields) {
    if (f.kind === 'combobox' && !f.options.length) f.options = await harvestOptions(page, f);
  }

  // A choice control whose options read only "on" / "true" / "" is one whose
  // meaning cannot be recovered from the page. Asking a model to pick from that
  // list is asking it to guess what it is asserting — which is how a "Yes" gets
  // put against "Do you have experience as an Infrastructure Engineer?". Refuse
  // it here rather than answer it blind.
  const opaque = (f) => f.options.length
    && f.options.every((o) => !norm(o.label) || /^(on|true|false|1|0)$/i.test(norm(o.label)));
  fields = fields.filter((f) => {
    if (!opaque(f)) return true;
    const msg = `cannot read the options for "${f.question.slice(0, 80)}" (the control exposes no readable labels) — answer it by hand`;
    if (f.required) state.blocked_on.push(msg); else state.left_for_human.push(msg);
    return false;
  });

  const cache = loadAnswerCache(ats);
  const answers = {};
  const askFor = [];

  for (const f of fields) {
    // profile.json first. A structured fact is never routed through a model,
    // and an option control still has to accept the value or it falls through.
    const fromProfile = resolveFromProfile(f.question, profile, `${f.description || ''} ${jdText}`);
    if (fromProfile) {
      const legalHere = !f.options.length
        || f.options.some((o) => lc(o.label) === lc(fromProfile));
      if (legalHere) {
        answers[f.key] = fromProfile;
        state.from_profile = (state.from_profile || []).concat(f.question.slice(0, 60));
        continue;
      }
      let mapped = f.options.map((o) => o.label)
        .find((o) => lc(o).startsWith(lc(fromProfile)) || lc(fromProfile).startsWith(lc(o)))
        || matchSelfIdLabel(fromProfile, f.options.map((o) => o.label));
      // A known fact that the control does not offer is what "Other" is FOR.
      // Palantir's "Year of High School Graduation" lists 2020-2030 and Other;
      // this candidate finished in 2012, so Other is the truthful pick and the
      // only one available. Never applied to self-ID questions, where "Other"
      // is a substantive answer about the person rather than a fallback.
      // Never fall back to "Other" when the options are BUCKETS. A GPA of 3.0
      // against "3.4 - 3.70 / 3.71 - 4.0 / Other" is not an "Other" GPA — the
      // honest outcomes are the bucket that contains it or a blank for the
      // model to resolve, and "Other" here asserts something false about the
      // candidate. Same shape as the Degree control that answered "Other" for
      // an MS in Computer Science.
      const bucketed = f.options.some((o) => /\b(before|after|by end of|or later|or more|or less|between|under|over)\b|\d\s*[-–]\s*\d/i.test(o.label || ''));
      if (!mapped && !bucketed && !/gender|race|ethnic|veteran|disab|hispanic|latino/i.test(f.question || '')) {
        mapped = f.options.map((o) => o.label).find((o) => /^other\b/i.test(norm(o)));
        if (mapped) {
          log(`"${f.question.slice(0, 50)}": ${JSON.stringify(fromProfile)} is not offered — answering "${mapped}"`);
        }
      }
      if (mapped) {
        answers[f.key] = mapped;
        state.from_profile = (state.from_profile || []).concat(f.question.slice(0, 60));
        continue;
      }
    }
    const hit = cacheLookup(cache, company, f.question);
    const cached = hit && (Array.isArray(hit.answer) ? hit.answer.length : norm(hit.answer));
    // A cached answer still has to be legal on THIS form: the same question can
    // offer different option strings at different companies.
    const legal = !f.options.length || (hit && (Array.isArray(hit.answer) ? hit.answer : [hit.answer])
      .every((a) => f.options.some((o) => lc(o.label) === lc(a))));
    if (cached && legal) {
      answers[f.key] = hit.answer;
      state.from_cache = (state.from_cache || []).concat(f.question.slice(0, 60));
    } else {
      askFor.push(f);
    }
  }

  if (askFor.length) {
    const res = askModel({ fields: askFor, slug, jdPath, profile, state, log });
    if (res) {
      for (const f of askFor) {
        const v = res.answers[f.key];
        if (v === undefined || v === null || (!Array.isArray(v) && !norm(v))) continue;
        answers[f.key] = v;
        cacheStore(cache, company, f.question, {
          answer: v,
          question: f.question,
          kind: f.kind,
          source: `model:${process.env.ATS_Q_MODEL || 'claude-sonnet-5'}`,
          saved_at: new Date().toISOString().slice(0, 10),
        });
      }
      for (const u of res.unanswerable) {
        const f = askFor.find((x) => x.key === u.key);
        state.left_for_human.push(`unanswered: ${(f?.question || u.key).slice(0, 90)} — ${u.why}`);
      }
      saveAnswerCache(ats, cache);
      state.answer_cache_updated = true;
    }
  }

  const unanswered = [];
  for (const f of fields) {
    const v = answers[f.key];
    if (v === undefined) {
      unanswered.push(f);
      continue;
    }
    await fill(page, f, v);
  }

  // Answering a question can REVEAL new required ones: Lever's CC-305 block
  // only renders its "Name" and "Date" signature fields once a disability
  // status is chosen, so a single pass can never see them and the run blocked
  // on fields that did not exist when it looked. Read the form again.
  if (pass < 3) {
    await page.waitForTimeout(800);
    const answeredKeys = fields.map((f) => f.key);
    const after = (await scrapeQuestions(page, formSel, { skip }))
      .filter((f) => !norm(f.value) && !answeredKeys.includes(f.key));
    if (after.length) {
      log(`pass ${pass} revealed ${after.length} more field(s); reading the form again`);
      await answerRemaining({
        page, formSel, ats, company, slug, jdPath, profile, state, log, fill, skip,
        pass: pass + 1,
      });
    }
  }

  // Only report a blank once the form has stopped changing under us.
  for (const f of unanswered) {
    if (norm(await page.locator(f.selector).first().inputValue().catch(() => ''))) continue;
    const msg = `question left blank: "${f.question.slice(0, 90)}"`;
    if (f.required) state.blocked_on.push(msg);
    else state.left_for_human.push(msg);
  }
}
