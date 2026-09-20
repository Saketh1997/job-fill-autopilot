---
name: job-applicator
description: Set up or run the Job_applicator job application pipeline — scan job boards, tailor a resume per posting, fill the ATS form, submit, and send follow-up outreach. Use when asked to run the pipeline, apply to a posting or a batch of postings, check what is filled and waiting, or handle a blocked application; and when setting the pipeline up for a new person or a new machine, or on a "not authorized" / "missing profile" / "no CDP browser" error. Not the career-ops framework router (/career-ops).
---

# Job_applicator

Finds job postings, tailors a resume for each, fills the application form, submits
it, and sends follow-up outreach. Five stages: **Scan, Tailor, Fill, Submit,
Outreach.** "Run the pipeline" means all five — outreach is not optional.

Two names, one checkout: the repository is **career-ops**, an open-source job
search framework with its own `/career-ops` router skill. **Job_applicator** is
the ATS automation inside it, and it is what this skill covers. Leave the
framework's router alone.

## Which path

Always start here. One command answers it:

```bash
node Job_applicator/validate_setup.mjs
```

| What you see | Do this |
| --- | --- |
| `FAIL` on profile, consent, work-auth or search | **Setup.** Read `references/setup.md` and work through the phases. |
| `Ready.` or warnings only, and the person wants to apply | **Run.** Read `references/running.md`. |
| The person explicitly asked to set up, onboard, or reconfigure | **Setup**, whatever the check says. |
| `Ready.` and the person asked to set up | Say it is already set up, then offer the Phase 5 dry run rather than re-interviewing them. |

Read the validator's output before asking anyone anything — it tells you what is
already done, so you only ask for the rest. Every `FAIL` is a blocker; every
`WARN` is worth one mention, then move on.

## Holds on both paths

**Never invent an answer to an application question.** A guessed value is not a
bad default — it becomes a false statement on a real job application sent under
someone's name. If a value cannot be sourced, it blocks. That is a correct
outcome, not a failure.

**Check `config/consent.json` before anything unattended.** It records what the
person has authorized, per grant and dated. No grant means fill and stop.

```bash
node -e "import('./Job_applicator/lib/consent.mjs').then(m=>console.table(m.summary()))"
```

A fresh checkout is fill-and-stop by default. That is deliberate: some ATS terms
of service prohibit automated submission, so granting `submit_when_clean` is a
decision the person makes for themselves, explicitly.

**Run `already_applied.py` before any fill or submit.** Applying twice to the same
posting has happened and it reads as careless to the employer.

**Paths and the venv.** Use `lib/paths.{mjs,py,sh}`; about 70 hardcoded paths
remain in older scripts (`node tools/audit_portability.mjs` lists them). A bare
`python3` gives `No module named 'mcp'` — the package is in `.venv-jobspy`:

```bash
source Job_applicator/lib/paths.sh && co_activate_venv
export CDP_ENDPOINT=http://localhost:9226
```

**Orchestrate; do not drive the browser by hand.** The drivers read every field
back off the live page, which beats your reading of a screenshot and costs a
fraction as much.

## Reference

| File | When |
| --- | --- |
| `references/setup.md` | The setup path: machine, profile, the authorization contract, first dry run. |
| `references/setup-questions.md` | The interview — the ~16 questions nobody can infer, in order, with why. |
| `references/running.md` | The run path: the five stages, submitting, what to do when something blocks. |
| `references/architecture.md` | What runs in what order, the refusal list, where state lives. |
| `Job_applicator/PIPELINE.md` | The full operator's manual. Point people here once they are running. |
