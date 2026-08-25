# NOTICE

This project is a derivative work built on **career-ops**.

## Upstream

- **Project:** career-ops — AI-Powered Job Search Pipeline
- **Author:** Santiago Fernández de Valderrama (<https://santifer.io>)
- **Source:** <https://github.com/santifer/career-ops>
- **License:** MIT (see [`LICENSE`](LICENSE))
- **Version this fork is based on:** 1.19.0

The MIT license text and copyright notice from the upstream project are retained
in [`LICENSE`](LICENSE), alongside a second copyright line covering the
additions made in this repository. The original upstream README is preserved at
[`README.career-ops.md`](README.career-ops.md), along with its translations
(`README.*.md`) and project documents (`AGENTS.md`, `ARCHITECTURE.md`,
`CONTRIBUTING.md`, `GOVERNANCE.md`, `CONTRIBUTORS.md`, and others).

The majority of the files in this repository are upstream work. Credit for the
scan/evaluate/tailor core, the mode system, the plugin architecture, and the
documentation belongs to Santiago Fernández de Valderrama and the career-ops
contributors listed in [`CONTRIBUTORS.md`](CONTRIBUTORS.md).

## Trademark

"career-ops" and its branding belong to the upstream project. See
[`TRADEMARK.md`](TRADEMARK.md). This repository is named `job-fill-autopilot`
and is **not** endorsed by, affiliated with, or supported by the upstream
project. Please do not file issues here against upstream, or upstream against
this fork.

## Additions in this repository

The following are original work by Saketh Srinivasa Rao Metta, added on top of
upstream and not present in any upstream revision:

| Area | Paths |
|---|---|
| ATS auto-fill & submission | `Job_applicator/` |
| LinkedIn outreach & alumni referrals | `Job_applicator/linkedin_*`, `Job_applicator/*outreach*`, `alumni-referrals.mjs`, `run_alumni.sh` |
| Listing ingestion (JobRight, JobSpy, SpeedyApply, LinkedIn) | `jobright*.py`, `jobspy*.py`, `speedyapply_scan_parser.py`, `linkedin_*.py`, `Webscrapper/` |
| Pipeline plumbing | `dedup_pipeline.py`, `experience_gate.py`, `jd_extract.py`, `scan_ats.py`, `scan_common.py`, `post_scan_normalize.py`, `sync_pipeline_csv.py`, `batch-ats-fill.mjs`, `run_*.sh` |

These additions are released under the same MIT license.
