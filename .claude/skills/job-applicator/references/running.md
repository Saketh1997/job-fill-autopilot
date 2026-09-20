# Run path

Five stages, in order. "Run the pipeline" means all five — outreach is never
optional. Preflight and the holds that apply to every run are in the skill body;
this file is the procedure.

## The five stages

```bash
./run_scan.sh                                          # 1. scan  (no model calls)
node Job_applicator/run_ats_batch.mjs --days 7         # 2+3. tailor + fill
node Job_applicator/ats_submit.mjs --list              # 4. what is waiting
node Job_applicator/ats_submit.mjs <slug>              #    submit one
./Job_applicator/run_outreach.sh --days 7              # 5. outreach
```

Everything serially, in one command: `node batch-ats-fill.mjs --submit`.

## Submitting

`ats_submit.mjs` is the only thing that clicks Submit. It re-audits the live page
and refuses on: a missing tab, an empty required field, a showing validation
error, a generic resume where a tailored one was expected, a value that had to be
guessed, an account created this session, or an already-submitted slug.

Those refusals are the point. When one fires, fix the cause — do not reach for
`--force`, which overrides the audit.

Two gaps the refusal list does **not** catch, so check them yourself before an
unattended submit:

- **Overstated skills.** Tools used once in a tutorial read as experience on a
  resume, and free-text answers are written from the resume. `cv.md` is the
  anti-overstatement gate; it is not a complete fact inventory, so never
  overwrite a specific technical detail just because `cv.md` disagrees — ask.
- **Demo framing.** Do not describe a project as live unless it is. Probe it.

## When something blocks

Record it in `blocked_on` and move on to the next posting; do not improvise
around a gate.

- **CAPTCHA or verification challenge** — stop. `captcha_relay.mjs` puts a human's
  eyes on it. Nothing here solves one.
- **A required cover letter** — write it and paste it. This does not block a
  submit; use `generate-cover-letter.mjs`.
- **A question the profile cannot answer** — `collect_questions.py` puts it in
  `open-questions.md` for the person. A blocked question is a correct outcome.
- **"How did you hear about us"** with no truthful option — block. Asserting a
  referral that does not exist is not a workaround.
- **Workday** — one posting at a time, no other Workday tab open. Priming a page
  can resume a different employer's wizard in a reused tab.

## Notes that save a run

- `#country` on Greenhouse is a dial-code field. `+1` is correct; a readback
  complaining it is not "United States" is a false positive.
- A clean readback is not a promise the ATS will accept it. The readback reads the
  DOM; Ashby and Greenhouse validate framework state, and some fields need
  re-entry with real events.
- The fix pass has been observed ticking unrelated boxes while reporting it
  touched nothing else. Diff a post-fix readback against a pre-fix snapshot
  before submitting.
- `get_code.py` finding no confirmation email is not evidence an application was
  not submitted. Known-submitted Greenhouse applications show no mail in it.
- `profile.json` and its dated `_note` keys beat any prose in `CLAUDE.md`.

Deeper: `Job_applicator/PIPELINE.md` — machine state, model routing and
fallback, per-portal mechanics, recovery checklists.
