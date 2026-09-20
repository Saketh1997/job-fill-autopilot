# The interview

Everything here is something no resume, LinkedIn profile or repository can tell
you. Ask in these groups, in this order. Stop between groups and write what you
have into `profile.json` — a setup that dies halfway should leave real progress
behind.

Never guess an answer in this file. A guessed value here is not a bad default,
it is a false statement on a real job application, sent to a real employer,
under the person's name.

---

## Group 1 — work authorization (4 questions, all blocking)

Every US application asks these and phrases them four different ways.

1. **Are you legally authorized to work in the US?** → `application_questions.legally_authorized_to_work`
2. **What is your status, in plain words?** e.g. "US citizen", "green card",
   "F-1 OPT with EAD, authorized about 3 years", "H-1B transfer needed".
   → `work_authorization`. Free text on purpose: the model needs the underlying
   fact, because forms ask about it in ways no checkbox covers.
3. **Will you now or in the future require sponsorship?** → `require_sponsorship_now_or_future`
4. **Would you require sponsorship if the employer cannot sponsor?** →
   `require_sponsorship_when_employer_cannot_sponsor`

3 and 4 are genuinely different questions and often have opposite answers. The
pipeline stores both and **nothing currently chooses between them per form** —
`validate_setup.mjs` warns about this. Tell the person: on a form that asks the
employer-cannot-sponsor phrasing, the answer has to be checked by a human before
submitting. It is an open gap, not a solved problem.

## Group 2 — money and timing (4 questions)

5. **Minimum annual salary you would accept**, a number. → `application_questions.minimum_annual_salary`
   Required fields on some forms, so leaving it empty blocks those applications.
6. **What number do you put when a form demands an expectation?** → `salary_expectation.default`
7. **Earliest start date.** → `available_start_date`
8. **Notice period**, if currently employed. → `notice_period`

## Group 3 — location (3 questions)

9. **Mailing address** — street, city, state, ZIP, country. Partial addresses
    get rejected.
10. **Open to relocation?** And if yes, where to. → `open_to_relocation`
11. **What do you type into a city autocomplete?** → `address.typeahead_city`.
    Often not the mailing city: a suburb may not exist as an option where the
    nearest metro does. Worth one question because it silently breaks fills.

## Group 4 — education (already drafted, confirm only)

You filled these from the resume in Phase 1. Read them back and let the person
correct them rather than asking again.

12. Degree, school, graduation date, GPA. GPA is optional — some people decline
    to give it, and that is a complete answer.

## Group 5 — self-identification (optional, ask once)

Say before you ask: these are the EEO questions US employers attach to
applications, every one is optional, and "decline to self-identify" is a normal
answer the forms accept.

13. Gender, race/ethnicity, veteran status, disability status, and on some forms
    sexual orientation, transgender status, age bracket.

Take a decline without comment and move on. Do not ask a second time, do not ask
them to reconsider, and do not infer any of these from a name, a photo, a school
or anything else.

## Group 6 — truthfulness traps (2 questions)

These exist because the honest answer is narrower than the tempting one.

14. **"How did you hear about us?"** — which options can they actually back up?
    Usually only "Other", "Job board" or "Online search". A "Referral" or
    "Career fair" they cannot name a person or event for is a false statement on
    an application, and it is the kind that gets checked. Put only true options
    in `how_did_you_hear_about_us.preference_order`.
15. **Anything on the resume they would not defend in an interview?** Tools used
    once in a tutorial sit on a resume looking like experience. The pipeline
    writes free-text answers from the resume, so an overstatement there becomes
    an overstatement in a cover letter. Record the real depth in `cv.md` so the
    fact-check gate can see it.

## Group 7 — accounts (1 question, no passwords in chat)

16. **Which email do portal accounts use?** → `job_account_email`.

The password and the Gmail IMAP app password (for reading verification codes)
go in `Job_applicator/login.env`, mode 0600, written by the person. Never ask for
a password in conversation, and never write one into `profile.json` — the whole
profile gets pasted into model prompts.
