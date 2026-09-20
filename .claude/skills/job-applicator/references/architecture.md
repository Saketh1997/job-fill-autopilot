# What runs, in order

Five stages. "Run the pipeline" means all five.

| # | Stage | Entry point | Model calls | What it does |
| --- | --- | --- | --- | --- |
| 1 | Scan | `run_scan.sh` → `scan.mjs` | none | 60 provider modules → rows in `data/pipeline.csv`. The only stage that adds work. Cron-safe. |
| 2 | Tailor | `tailor_resume.sh` | ~1/posting | JD + `content-bank.yml` → `resumes/{slug}.pdf`. `tailor_resume_local.mjs` does it with none. |
| 3 | Fill | `run_ats_batch.mjs`, or `agy_step.sh` via `run_agy_fill.sh` | 1–2/posting | Per-ATS driver fills the form, reads every field back off the live page, leaves the tab open. Never clicks Submit. |
| 4 | Submit | `ats_submit.mjs` | none | The only thing in the repo that clicks Submit. Re-audits the live page first. |
| 5 | Outreach | `run_outreach.sh` → `linkedin_send.py` | 1/contact | Finds a contact, drafts, verifies, sends. |

## The refusal list

Stage 4 refuses, rather than submitting, when:

- the tab holding the filled form is gone
- a required field is empty, or a validation error is showing
- the attached resume is the generic one where a tailored one was expected
- a value had to be guessed during the run
- an account was created this session and nothing has been verified
- the slug was already submitted
- `config/consent.json` does not grant `submit_when_clean` (then it asks instead)

This list is the product. The filling is the easy part.

## ATS drivers

`greenhouse_apply.mjs`, `lever_apply.mjs`, `ashby_apply.mjs`, `workday_apply.mjs`,
`amazon_apply.mjs`, plus `drive_application.sh` as an agentic fallback for
account-walled portals. Shared machinery lives in `ats_apply_common.mjs`.

Workday is the awkward one: per-tenant accounts, a multi-step wizard where a
readback only sees the current step, and a tab-reuse bug where priming a page
can resume a *different* employer's wizard. One Workday posting at a time.

## The new config layer

| File | Purpose |
| --- | --- |
| `Job_applicator/lib/paths.{mjs,py,sh}` | Resolve the checkout root. Replaces hardcoded paths. |
| `Job_applicator/lib/identity.mjs` | Name and contact details from `profile.json`, for prompts and forms. |
| `Job_applicator/lib/consent.mjs` | Standing authorizations. Absent file = nothing authorized. |
| `Job_applicator/config/profile.schema.json` | What `profile.json` must contain. |
| `Job_applicator/config/consent.example.json` | The grants, all off. |
| `Job_applicator/validate_setup.mjs` | Readiness check. Run it before any unattended batch. |
| `tools/audit_portability.mjs` | What still hardcodes a path, a person or this machine. |
| `setup/install_browser_stack.sh` | The three systemd user units. |

## Model providers

Two chains, not one:

- `MODEL_CHAIN` (`claude_retry.sh`) — general calls: the question pass, the
  review pass, `make_plan.py`, free text. Default
  `claude, agy:claude-sonnet-4-6, agy:gemini-3.1-pro-high`.
- `AGY_CHAIN` (`agy_step.sh`) — the browser-driving fill. Default
  `agy:gemini-3.7-flash-high, agy:gemini-3.6-flash-high, agy:claude-sonnet-4-6`.
  It stays inside agy on purpose: falling back out to claude mid-fill would put a
  different driver on a half-filled form.

`agy` is required, not a nicety — it drives the fill. A spent quota is sticky,
recorded in `~/.career-ops/quota.state` with the epoch the provider returns.

## State

`data/pipeline.csv` is the tracker: one row per posting, with `applied` and
`processed` flags. Everything else is keyed by slug — `jd/`, `schema/`, `plans/`,
`resumes/`, `answers/`, `logs/`. `logs/ats-batch-ledger.json` is the resumable
run record.
