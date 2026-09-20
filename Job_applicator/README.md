# Job_applicator

The ATS automation inside **career-ops**. It finds job postings, tailors a resume
for each one, fills the application form, submits it, and sends follow-up
outreach.

To date it has submitted **982 applications to 537 companies**, from a tracker of
2,001 postings, through **60 job-board providers** and **6 ATS drivers**
(Greenhouse, Lever, Ashby, Workday, Amazon, plus an agentic fallback).

> **Two names, one checkout.** The repository is `career-ops`, an open-source job
> search framework with its own `/career-ops` router skill, modes, plugins and
> scoring. `Job_applicator/` is the application-filling pipeline that lives inside
> it. This README covers Job_applicator. The framework's own docs are `AGENTS.md`
> and the root `README.md`.

---

## Table of contents

- [What it does](#what-it-does)
- [The refusal list](#the-refusal-list)
- [Quick start](#quick-start)
- [Architecture: engine, config, machine](#architecture-engine-config-machine)
- [The config layer](#the-config-layer)
  - [Path resolution](#path-resolution)
  - [Identity](#identity)
  - [Consent — standing authorizations](#consent--standing-authorizations)
  - [Profile schema](#profile-schema)
- [Tooling](#tooling)
  - [validate_setup.mjs](#validate_setupmjs)
  - [tools/audit_portability.mjs](#toolsaudit_portabilitymjs)
  - [setup/install_browser_stack.sh](#setupinstall_browser_stacksh)
- [The `job-applicator` skill](#the-job-applicator-skill)
- [State and artefacts](#state-and-artefacts)
- [Known gaps](#known-gaps)
- [Generalization status](#generalization-status)

---

## What it does

Five stages. "Run the pipeline" means all five — outreach is not optional.

| # | Stage | Entry point | Model calls | What it does |
| --- | --- | --- | --- | --- |
| 1 | **Scan** | `../run_scan.sh` → `../scan.mjs` | none | 60 provider modules → rows in `../data/pipeline.csv`. The only stage that adds work. Cron-safe. |
| 2 | **Tailor** | `tailor_resume.sh` | ~1 per posting | JD + `content-bank.yml` → `resumes/{slug}.pdf`. `tailor_resume_local.mjs` does the same selection with zero model calls. |
| 3 | **Fill** | `run_ats_batch.mjs` | 1–2 per posting | The per-ATS driver fills the form, reads **every field back off the live page**, and leaves the tab open. It never clicks Submit. |
| 4 | **Submit** | `ats_submit.mjs` | none | The only thing in the repo that clicks Submit. Re-audits the live page first. |
| 5 | **Outreach** | `run_outreach.sh` → `linkedin_send.py` | 1 per contact | Finds a contact, drafts, verifies, sends. |

The split between 3 and 4 is deliberate: **a filled form is reviewable and a
submitted one is not.** It also makes human edits first-class — anything corrected
by hand in the open tab is picked up at submit time, because the audit reads the
live page rather than replaying what the filler thought it wrote.

## The refusal list

This is the product. Filling a form is the easy part; knowing when *not* to
submit is the whole value.

`ats_submit.mjs` refuses, rather than submitting, when:

- the tab holding the filled form is gone (the form went with it)
- a required field is empty, or the form is showing a validation error
- the attached resume is the generic one where a tailored one was expected
- **a value had to be guessed during the run**
- an account was created this session and nothing has been verified
- the slug was already submitted
- `config/consent.json` does not grant `submit_when_clean` — then it reviews as
  normal and asks interactively instead of refusing outright

A correction applied by the review pass is *not* a guess: it was validated against
the control's own options and read back off the page, and it is listed with its
reason in `answers/{slug}.drive.json` → `review.corrections`. A value the run
could not source and filled anyway still blocks.

`--force` overrides the audit. It never overrides the already-submitted check.

## Quick start

```bash
# 0. preflight
node Job_applicator/validate_setup.mjs          # what is missing, what is authorized
bash setup/install_browser_stack.sh --check     # is the browser up
export CDP_ENDPOINT=http://localhost:9226
source Job_applicator/lib/paths.sh && co_activate_venv

# 1-5
./run_scan.sh                                   # scan
node Job_applicator/run_ats_batch.mjs --days 7  # tailor + fill
node Job_applicator/ats_submit.mjs --list       # what is filled and waiting
node Job_applicator/ats_submit.mjs <slug>       # submit one
./Job_applicator/run_outreach.sh --days 7       # outreach
```

Everything serially in one command: `node batch-ats-fill.mjs --submit`.

**Before any fill or submit, run `already_applied.py`.** Applying twice to the
same posting has happened, and it reads as careless to the employer.

---

## Architecture: engine, config, machine

Three things used to be fused together in this directory. Keeping them apart is
what makes the pipeline runnable by someone who did not build it.

| Layer | What it is | Where it lives |
| --- | --- | --- |
| **Engine** | Scrapers, ATS drivers, readback and refusal logic. Identical for everyone. | `*_apply.mjs`, `ats_apply_common.mjs`, `../providers/`, `../scan.mjs` |
| **Config** | Who the person is, and what they have authorized. Different for everyone. | `profile.json`, `config/consent.json`, `../portals.yml`, `login.env` |
| **Machine** | A headless Chrome with a debugging port, holding every portal login. | `setup/install_browser_stack.sh`, three systemd user units |

---

## The config layer

### Path resolution

`lib/paths.mjs`, `lib/paths.py`, `lib/paths.sh` — three twins of the same logic,
one per language used in the pipeline.

Resolution order, first hit wins:

1. `CAREER_OPS_ROOT` environment variable
2. Walk up from the module's own file until a directory contains **both**
   `Job_applicator/` and `package.json`

There is deliberately **no hardcoded fallback**. A wrong guess sends a run at
someone else's data directory, and a clear exception is cheaper than that. The
two-marker root test matters: a stray directory named `Job_applicator` upstream
of the checkout would otherwise capture the walk.

```js
import { ROOT, APP, DIRS, FILES, ensureDirs, slugPath } from './lib/paths.mjs';
slugPath('jd', 'acme-swe');   // <app>/jd/acme-swe.txt
```

```python
from lib.paths import ROOT, APP, DIRS, FILES, ensure_dirs, slug_path
```

```bash
source "$(dirname "$0")/lib/paths.sh"   # exports ROOT APP DATA VENV PROFILE CONSENT
co_activate_venv                        # the venv that actually has `mcp` in it
cd "$APP"
```

`co_activate_venv` exists because a bare `python3` is the cause of the recurring
`ModuleNotFoundError: No module named 'mcp'` — the package is in
`../.venv-jobspy`, not system Python.

### Identity

`lib/identity.mjs` reads the candidate's name and contact details from
`profile.json`.

```js
import { displayName, legalName, preferredName, contact, genericResumePath }
  from './lib/identity.mjs';
```

| Function | Returns |
| --- | --- |
| `displayName()` | `first last` — what a model prompt or byline should say |
| `legalName()` | `profile.legal_name`, falling back to `displayName()` |
| `preferredName()` | `profile.preferred_name`, else the cached "preferred name" answer, else `first_name` |
| `contact()` | first, last, email, phone, linkedin, github, website |
| `genericResumePath()` | the untailored resume, **re-anchored by basename** onto this checkout when the stored absolute path does not exist |

This exists because three live model prompts (`ats_review.mjs`,
`ats_questions.mjs`, `amazon_apply.mjs`) and two form fillers used to open with a
hardcoded name. On anyone else's checkout, each of those is a wrong answer
submitted to a real employer.

### Consent — standing authorizations

`config/consent.json`, read by `lib/consent.mjs`. This is the part that makes the
pipeline safe to hand to someone who did not build it.

```js
import { allows, require_, provenance, summary } from './lib/consent.mjs';

allows('submit_when_clean');      // false unless explicitly granted AND dated
provenance('submit_when_clean');  // "granted by <name> on 2026-08-08"
```

**A missing or unreadable consent file means nothing is authorized.** A fresh
checkout therefore scans, tailors, fills and **stops**, and the person clicks
Submit themselves. A grant only counts when `allowed` is `true` *and*
`granted_on` is a real ISO date — the date lands in the run record, which is what
makes an unattended submit explainable months later.

| Grant | What it permits |
| --- | --- |
| `submit_when_clean` | Click Submit unattended, subject to the entire refusal list |
| `accept_arbitration` | Acknowledge arbitration and privacy notices — **those only**, never a general licence to accept any legal term a form presents |
| `create_accounts` | Sign up when a portal has no existing account (submit is still withheld on an account created this session) |
| `outreach_draft` | Write LinkedIn drafts. Never sends. |
| `outreach_auto_send` | Send drafts unattended |
| `attach_resume_to_followups` | Attach a resume to follow-up messages |
| `tailor_resume_with_model` | Spend model quota tailoring resumes (~$0.02 each) |

`config/consent.example.json` ships with **every grant off** and an inline readme
explaining the trade-offs. `config/consent.json` is gitignored — it is personal,
dated and specific to one person, the same class of file as `profile.json`.

**Why this file exists.** The framework's `AGENTS.md` says *"NEVER submit an
application without the user reviewing it first."* The pipeline's owner has a
standing authorization that overrides it. Rather than leaving two rules files
contradicting each other, the override is recorded here explicitly — per person,
per grant, with a date.

`ats_submit.mjs` consults it. Without `submit_when_clean`, `--yes` and `--all`
**degrade to an interactive prompt** rather than failing: the review work is still
worth doing, only the clicking waits for a human. Each submit records
`state.authorized_by`.

### Profile schema

`config/profile.schema.json` documents `profile.json` — 9 required fields, and
prose on the ones whose purpose is not obvious:

- `address.typeahead_city` — what to **type** into a city autocomplete, which is
  often not the mailing city. A suburb may not exist as an option where the
  nearest metro does.
- `work_authorization` — free text on purpose. Forms phrase this a dozen ways and
  the model needs the underlying fact, not a checkbox.
- `require_sponsorship_now_or_future` vs
  `require_sponsorship_when_employer_cannot_sponsor` — genuinely different
  questions, frequently with opposite answers. See [Known gaps](#known-gaps).
- `how_did_you_hear_about_us.preference_order` — only answers that are **true**
  belong here. An aspirational list makes the pipeline assert something false on
  every form that asks.
- `job_account_password` — deprecated in this file. A password in `profile.json`
  ends up inside model prompts, because the whole profile is pasted into them.
  It belongs in `login.env` (gitignored, mode 0600).

---

## Tooling

### `validate_setup.mjs`

```bash
node Job_applicator/validate_setup.mjs            # human-readable report
node Job_applicator/validate_setup.mjs --json     # for the setup skill
node Job_applicator/validate_setup.mjs --strict   # exit 1 on warnings too
```

Two jobs. For a new person it is the completeness check the setup wizard runs
between phases, so the interview asks only for what is actually missing. For an
existing checkout it is a pre-flight.

Every check exists because the corresponding failure has happened. It verifies:
required profile fields; a complete address and education block; that
`resume_path` resolves to a real file; that attached documents exist **and are
not truncated** (a PDF with no `%%EOF` trailer still gets uploaded to an
employer); that no password sits in `profile.json`; that the two sponsorship
answers do not silently disagree; that "how did you hear about us" contains only
defensible answers; that consent is internally consistent
(`outreach_auto_send` without `outreach_draft` is a send with nothing to verify);
that `login.env` is mode 0600; and that a CDP browser and the venv are reachable.

Exit 0 ready · 1 blocking problems.

### `tools/audit_portability.mjs`

```bash
node tools/audit_portability.mjs           # grouped report
node tools/audit_portability.mjs --hits    # every occurrence, file:line
node tools/audit_portability.mjs --json
```

Read-only. Answers "what still stops someone else from running this?" in three
classes, in the order they should be fixed:

| Class | Meaning | Fix |
| --- | --- | --- |
| `PATH` | A hardcoded checkout path | `lib/paths.{mjs,py,sh}` |
| `IDENTITY` | A person's name or contact detail baked into code | `lib/identity.mjs` |
| `MACHINE` | An assumption about this box — pinned interpreter paths, ports, binaries | belongs in setup, not a driver |

It reads the candidate's identity out of `profile.json`, so the tool has no name
hardcoded in it either. It distinguishes **code** from **prose** (a name in a
comment explains a decision; a name in a live prompt answers a question wrongly),
skips backup files and data directories, and ignores a literal that is already
the fallback behind an environment variable — `process.env.CDP_ENDPOINT || '…'`
is the fix, not the defect. Identity findings are only reported in executable
files: identity in a config or data file is what that file is *for*.

### `setup/install_browser_stack.sh`

```bash
bash setup/install_browser_stack.sh --check   # report only, changes nothing
bash setup/install_browser_stack.sh           # install and start
```

Writes and starts three **systemd user** units: `Xvfb` (virtual display),
`job-browser` (Chrome with CDP open on it), and `x11vnc` (so a human can watch a
run or clear a CAPTCHA). Parameterized via `CAREER_OPS_DISPLAY`,
`CAREER_OPS_CDP_PORT`, `CAREER_OPS_VNC_PORT`, `CAREER_OPS_CHROME_PROFILE`.

Each constraint below cost a failed run before it was settled:

- **Google Chrome stable specifically.** Not snap chromium: it serves
  `/json/version` but never completes a CDP handshake from outside its
  confinement, so every `connectOverCDP` hangs 30s and times out. Not
  Playwright's bundled chromium: that is Chrome for Testing, and some career
  portals render fewer controls for it.
- **`--no-sandbox` is deliberately absent.** Chrome stable does not need it.
  Playwright's chromium does, because Ubuntu 23.10+ AppArmor restricts
  unprivileged user namespaces — one more reason to use Chrome stable.
- **x11vnc is `-localhost -nopw` on purpose.** No password, bound to 127.0.0.1
  only. Reach it with `ssh -L 5900:localhost:5900 <host>`, never by opening the
  port.
- **The CDP port takes ~10s to bind.** The script polls it; a single `sleep`
  either wastes time or reports a false failure.

**Back up the Chrome profile directory.** Every portal session the pipeline has —
LinkedIn, the job boards, every ATS account — lives in it.

---

## The `job-applicator` skill

`.claude/skills/job-applicator/` — one skill that handles both setting the
pipeline up and running it, routing on the validator's verdict rather than
guessing at intent.

```
job-applicator/
├── SKILL.md                  routing + what holds on both paths
└── references/
    ├── setup.md              the setup path, Phases 0-5
    ├── setup-questions.md    the ~16 questions nobody can infer
    ├── running.md            the run path
    └── architecture.md       stages, refusal list, state
```

| Validator says | Path |
| --- | --- |
| `FAIL` on profile, consent, work-auth or search | Setup |
| `Ready.` or warnings only, and they want to apply | Run |
| They explicitly asked to set up or reconfigure | Setup, regardless |
| `Ready.` and they asked to set up | Say so; offer the Phase 5 dry run |

The setup path does **not** interview from a blank page — `profile.json` has 40
top-level keys and 75 application questions, and asking all of them cold is how a
setup gets abandoned. It reads a resume PDF, drafts a profile, then asks only
about what it could not fill: roughly a hundred questions reduced to about
sixteen. Phase 5 never lets the first run be an unattended batch.

> This is **not** the `career-ops` router skill at `.claude/skills/career-ops/`.
> That slot belongs to the framework and is shared byte-for-byte with
> `.agents/skills/career-ops/SKILL.md`. See [Known gaps](#known-gaps).

---

## State and artefacts

`../data/pipeline.csv` is the tracker — one row per posting, with `applied` and
`processed` flags. Everything else is keyed by slug:

| Directory | Holds |
| --- | --- |
| `jd/{slug}.txt` | Job descriptions, cached forever |
| `schema/{slug}.json` | Form field inventories |
| `plans/{slug}.json` | Field → value, plus `.blocked.json` |
| `resumes/{slug}.pdf` | Tailored resumes, plus `.html` / `.draft.json` / `.changes.txt` |
| `answers/{slug}.drive.json` | Per-run result record, including `review.corrections` |
| `cache/{ats}.json` | Portal mechanics and selectors. **Read before driving.** |
| `logs/ats-batch-ledger.json` | The resumable run record |

`open-questions.md` is the candidate's inbox of questions the profile could not
answer. `collect_questions.py` refreshes it; `apply_answers.py` folds the answers
back into `profile.json`.

---

## Known gaps

Honest list. Each of these is a real limitation, not a TODO someone forgot.

- **The sponsorship branch is not chosen automatically.** `profile.json` holds
  both answers and nothing picks between them per form, so a form asking the
  employer-cannot-sponsor phrasing can receive the wrong one. `validate_setup.mjs`
  warns when the two disagree. Confirm on the live form before submitting.
- **A clean readback is not a promise the ATS will accept it.** The readback reads
  the DOM; Ashby and Greenhouse validate framework state. Some fields must be
  re-entered with real events.
- **The fix pass has been observed ticking unrelated boxes** while reporting it
  touched nothing else. Diff a post-fix readback against a pre-fix snapshot before
  submitting.
- **Two truthfulness gaps the refusal list cannot catch**, because they are facts
  about the world rather than about the form: skills overstated on the resume
  (a tool used once in a tutorial reads as experience, and free-text answers are
  written from the resume), and describing a demo as live when it is not.
- **No confirmation email is not evidence of no submission.** Known-submitted
  Greenhouse applications show no mail in `get_code.py`'s inbox.
- **Workday**: per-tenant accounts, a wizard where a readback sees only the
  current step, and a tab-reuse bug where priming a page can resume a *different*
  employer's wizard. One Workday posting at a time.
- **The framework's skill router is empty.** `.agents/skills/career-ops/SKILL.md`
  and `.claude/skills/career-ops/SKILL.md` are both committed as zero-byte files
  from the 2026-08-20 NFS recovery, and the `.opencode/`, `.qwen/` and `.grok/`
  copies that should symlink to the canonical one are missing. `node test-all.mjs`
  therefore fails **21 checks on a clean tree** — measure against 21, not zero,
  before blaming a change. `test-all.mjs` requires the `.claude/` copy to be
  byte-identical to the `.agents/` canonical, so editing one alone adds two more
  failures. Restoring it means rebuilding its mode registrations in the canonical
  file and re-linking the four copies.

## Generalization status

`node tools/audit_portability.mjs` currently reports **184 occurrences** that
would stop another person running this checkout, down from 192:

| Class | In code | Notes |
| --- | --- | --- |
| `PATH` | 69 | Mostly `cd /home/...` at the top of shell scripts. `lib/paths.sh` replaces them. |
| `IDENTITY` | 22 | Remaining hits are one-off scratch fillers (`fill_verkada.mjs`, `scratch_adp_*`), not live drivers. |
| `MACHINE` | 93 | Pinned Node paths, the CDP port, the Chrome binary. |

Already done: the three live model prompts and the form fillers now read from
`lib/identity.mjs`; `profile.json` gained the `legal_name` it had been
compensating for with a hardcoded literal; `ats_submit.mjs` consults consent.

Still to do, roughly in order: convert the shell scripts to `source lib/paths.sh`;
move pinned interpreter paths into setup; rewrite `verify_outreach.py`'s rule list,
which is currently a set of claims that are false about *one specific person* and
means nothing on anyone else's checkout.

**Two defaults recommended for any public version.** Default to fill-and-stop:
many ATS terms of service prohibit automated submission, and that decision should
be made deliberately by each person rather than inherited from an example file.
And leave `outreach_auto_send` off: it is the fastest route to a restricted
LinkedIn account, and the existing safety net does not transfer between people.

---

## Deeper

`PIPELINE.md` — the full operator's manual. Machine state, model routing and the
provider fallback chain, per-portal mechanics, recovery checklists.
`CLAUDE.md` — the rules file, authoritative on policy.
