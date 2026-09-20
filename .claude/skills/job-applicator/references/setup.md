# Setup path

Get the pipeline working for someone who did not build it. Three things are
fused together in this repo and you need to keep them apart:

| Layer | What it is | Where it lives |
| --- | --- | --- |
| **Engine** | Scrapers, ATS drivers, the readback/refusal logic. Same for everyone. | `Job_applicator/*_apply.mjs`, `providers/`, `scan.mjs` |
| **Config** | Who the person is and what they have authorized. Different for everyone. | `Job_applicator/profile.json`, `config/consent.json`, `portals.yml` |
| **Machine** | A headless Chrome with a debugging port, holding portal logins. | `setup/install_browser_stack.sh` |

Setup is: build the machine, write the config, prove it works on one application
without submitting it. Re-run `node Job_applicator/validate_setup.mjs` between
phases — a setup that dies halfway should leave real progress behind.

## Phase 0 — the machine

```bash
bash setup/install_browser_stack.sh --check     # report only
bash setup/install_browser_stack.sh             # install + start
```

Needs Google Chrome **stable** — not snap chromium (its CDP handshake never
completes from outside the snap confinement) and not Playwright's bundled
chromium (some portals render fewer controls for Chrome for Testing).

When it comes up, the person has to log in **once, by hand**, to LinkedIn and
any job boards they use, inside that browser. Tell them how: tunnel the VNC port
with `ssh -L 5900:localhost:5900 <host>` and point a VNC client at
`localhost:5900`. Then tell them to back up the Chrome profile directory — every
portal session the pipeline has lives in it.

Do not try to log in on their behalf. Do not ask them for portal passwords in
chat; those go in `Job_applicator/login.env` (mode 0600), which they write.

## Phase 1 — bootstrap the profile from documents

Do **not** interview from a blank page. `profile.json` has 40 top-level keys and
75 application questions; asking all of them cold is how a setup gets abandoned.

Ask for a resume PDF and a LinkedIn URL. Read the resume, then write a draft
`profile.json` covering name, contact, address, education, and work history.
Start from `Job_applicator/config/profile.schema.json` — it defines what is
required and documents the fields whose purpose is not obvious.

Then show the person only what you could not fill, plus anything you inferred
that you are less than sure about. That turns roughly a hundred questions into
about fifteen.

Two fields deserve explicit attention because the code used to hardcode them:

- `legal_name` — the full legal name, when it differs from first + last. Forms
  that ask for "full legal name" use it.
- `resume_path` — the generic, untailored resume. Keep it inside the checkout.

## Phase 2 — the questions nobody can infer

These are in `references/setup-questions.md`. Ask them in that order, in small
groups, not as one wall of questions. They cover work authorization, the
sponsorship branch, the salary floor, relocation, start dates and the optional
self-identification fields.

Two rules while you do this:

- **Never invent an answer.** A guessed value here becomes a false statement on a
  real job application. If the person does not know, leave the field out and let
  `validate_setup.mjs` keep reporting it.
- **Self-identification (race, gender, veteran, disability) is optional and it is
  theirs.** Offer "decline to self-identify" as a first-class answer, take it
  without comment, and do not ask twice.

## Phase 3 — the authorization contract

This is the phase that makes the pipeline safe to hand to someone who did not
build it. Copy `Job_applicator/config/consent.example.json` to `consent.json`,
then go through the grants with the person one at a time.

**Everything ships off.** With no grants, the pipeline scans, tailors, fills and
stops — the person clicks Submit themselves. That is the right default and you
should recommend keeping it for the first week.

Two grants need you to say the trade-off out loud before they answer:

- `submit_when_clean` — lets a run click Submit with nobody watching. Some ATS
  terms of service prohibit automated submission. Say so plainly, once, and let
  them decide; it is their call to make, not yours to make for them or to refuse
  on their behalf. Turning it on does not mean "always submit": the run still
  refuses on a guessed value, an empty required field, a showing validation
  error, a generic resume where a tailored one was expected, or an account
  created that session.
- `outreach_auto_send` — sends LinkedIn messages unattended. This is the fastest
  route to a restricted LinkedIn account, and the existing safety net
  (`verify_outreach.py`) is a list of claims that are false about *the original
  author*, not about the new person. Recommend leaving it off until they have
  rewritten those rules for themselves. `outreach_draft` alone is safe: it
  writes drafts and never sends.

Record a real date in `granted_on` for anything they turn on. That date lands in
the run log, which is what makes an unattended submit explainable months later.

## Phase 4 — what to search for

`portals.yml` holds the search: titles, locations, experience ceiling, salary
floor, and which of the 60 providers to use. Set it from what the person
actually wants, and start narrow — a wide first scan produces hundreds of rows
nobody triages.

## Phase 5 — prove it on one application

Never let the first run be an unattended batch.

```bash
export CDP_ENDPOINT=http://localhost:9226
./run_scan.sh                              # stage 1, no model calls, adds rows
node Job_applicator/run_ats_batch.mjs --days 7 --limit 1
node Job_applicator/ats_submit.mjs --list  # what is filled and waiting
node Job_applicator/ats_submit.mjs <slug> --dry-run
```

Then walk them through the filled form in the open tab, field by field, and let
them press Submit themselves. Do not submit on their behalf on the first one,
even if `submit_when_clean` is granted.

Finish by re-running `node Job_applicator/validate_setup.mjs` and showing them
the result.

## Things that will bite you

- **A readback that looks clean is not a promise the ATS will accept it.** The
  readback reads the DOM; Ashby and Greenhouse validate framework state, and some
  fields must be re-entered with real events.
- **Record by-hand applications immediately.** The pipeline cannot know about an
  application the person sent themselves, and it will happily send a second one.

Next: `references/running.md` once they are set up.
