#!/bin/bash
set -uo pipefail

# Tailors a resume for jd/$SLUG.txt. Output contract is unchanged:
# resumes/$SLUG.pdf, and "TAILOR_OK: <path>" on success, so fill_application.sh
# needs no edits.
#
#   1. jd-skill-gap.mjs        — zero-LLM skill buckets (informational)
#   2. tailor_resume_local.mjs — zero-LLM selection from content-bank.yml
#   3. review_resume_patch.mjs — ONE single-shot LLM call, patch-only, fail-open
#   4. build-cv-html.mjs       — deterministic render (owns all markup)
#   5. verify-cv-facts.mjs     — hard gate against invented metrics
#   6. generate-pdf.mjs        — Playwright HTML->PDF
#
# The previous agent-loop implementation is kept at tailor_resume_agent.sh.bak.
# It cost ~$2.58 and ~248k input tokens per resume; this path costs ~$0.02 and
# ~5k, because step 2 does the work that step 3 used to redo from scratch.

SLUG="${1:-}"

cd /home/hunter/projects/career-ops/Job_applicator
export PATH="/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:$PATH"

# Route through OmniRoute, same as fill_application.sh / submit_application.sh.
# OmniRoute (localhost:20128) is gone. Default to the real API; the CLI
# authenticates with its own stored credentials, and the token guard below
# withholds the OmniRoute token unless someone points this back at 20128.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
# Only OmniRoute takes the OmniRoute token. When a caller points the pipeline at
# api.anthropic.com instead, this token must NOT be sent: the real API rejects
# it with 401 "Invalid bearer token" on every call, and the CLI's own stored
# credentials are what should be used there.
case "$ANTHROPIC_BASE_URL" in
  *20128*) export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:?OmniRoute requires ANTHROPIC_AUTH_TOKEN in the environment}" ;;
esac

export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# OmniRoute routes by alias, not by first-party model ID. Override with
# REVIEW_MODEL=claude-opus-5 when pointing at api.anthropic.com directly.
export REVIEW_MODEL="${REVIEW_MODEL:-claude-sonnet-5}"

if [ -z "$SLUG" ]; then
  echo "usage: tailor_resume.sh <slug> [swe|ml|robotics]" >&2
  exit 1
fi

CAREER_OPS="/home/hunter/projects/career-ops"
JOBAPP="$CAREER_OPS/Job_applicator"
JD_FILE="$JOBAPP/jd/$SLUG.txt"
SKILLGAP_FILE="$JOBAPP/resumes/$SLUG.skillgap.json"
PAYLOAD_FILE="$JOBAPP/resumes/$SLUG.payload.json"
DRAFT_FILE="$JOBAPP/resumes/$SLUG.draft.json"
HTML_FILE="$JOBAPP/resumes/$SLUG.html"
PDF_FILE="$JOBAPP/resumes/$SLUG.pdf"
CHANGES_FILE="$JOBAPP/resumes/$SLUG.changes.txt"
LOG_FILE="$JOBAPP/logs/$SLUG-tailor.log"
REVIEW_LOG="$JOBAPP/logs/review-patches.jsonl"

if [ ! -s "$JD_FILE" ]; then
  echo "TAILOR_FAILED: missing or empty $JD_FILE" >&2
  exit 1
fi
if [ ! -s "$CAREER_OPS/cv.md" ]; then
  echo "TAILOR_FAILED: missing $CAREER_OPS/cv.md (source of truth)" >&2
  exit 1
fi

mkdir -p "$JOBAPP/logs"
# Clear stale output so a failed run can never pass on a previous run's PDF.
rm -f "$SKILLGAP_FILE" "$PAYLOAD_FILE" "$DRAFT_FILE" "$HTML_FILE" "$PDF_FILE" "$CHANGES_FILE"
: > "$LOG_FILE"

# --- 1. Skill buckets (informational; not on the critical path) -------------
(cd "$CAREER_OPS" && node jd-skill-gap.mjs "$JD_FILE" > "$SKILLGAP_FILE" 2>>"$LOG_FILE") || true

# --- 2. Deterministic tailoring --------------------------------------------
node tailor_resume_local.mjs "$JD_FILE" --out "$PAYLOAD_FILE" --changes "$CHANGES_FILE" >>"$LOG_FILE" 2>&1
if [ ! -s "$PAYLOAD_FILE" ]; then
  echo "TAILOR_FAILED: tailor_resume_local.mjs produced no payload, check $LOG_FILE" >&2
  exit 1
fi
# Keep the pre-review draft: it is the fallback if a patched payload fails a gate.
cp "$PAYLOAD_FILE" "$DRAFT_FILE"

# --- 3. Mandatory review (fail-open) ----------------------------------------
node review_resume_patch.mjs --jd "$JD_FILE" --payload "$PAYLOAD_FILE" --log "$REVIEW_LOG" 2>&1 | tee -a "$LOG_FILE"

# pdfinfo (poppler-utils) is not installed on every box. An empty page count
# used to trip the ">2 pages" gate below and fail a perfectly good 2-page PDF,
# so fall back to pdfminer, which .venv-jobspy already has.
count_pages() {
  local pdf="$1" n=""
  if command -v pdfinfo >/dev/null 2>&1; then
    n=$(pdfinfo "$pdf" 2>>"$LOG_FILE" | awk '/^Pages:/{print $2}')
  fi
  if [ -z "$n" ] && [ -x "$CAREER_OPS/.venv-jobspy/bin/python" ]; then
    n=$("$CAREER_OPS/.venv-jobspy/bin/python" -c 'import sys
from pdfminer.pdfpage import PDFPage
with open(sys.argv[1], "rb") as fh:
    print(sum(1 for _ in PDFPage.get_pages(fh)))' "$pdf" 2>>"$LOG_FILE")
  fi
  printf '%s' "$n"
}

# --- 4-6. Render, verify, print. Retry once from the unpatched draft. --------
render_and_check() {
  node "$CAREER_OPS/build-cv-html.mjs" "$PAYLOAD_FILE" "$HTML_FILE" >>"$LOG_FILE" 2>&1 || return 1

  # The template always emits the Certifications header; cv.md lists none, so
  # drop the empty section rather than shipping a bare heading. Done here
  # because templates/ is system-layer and update-system.mjs would revert it.
  perl -0pi -e 's{<div class="section">\s*<div class="section-title">[^<]*</div>\s*<div class="cert-table"></div>\s*</div>}{}s' "$HTML_FILE"

  (cd "$CAREER_OPS" && node verify-cv-facts.mjs "$HTML_FILE") >>"$LOG_FILE" 2>&1 || return 2
  node "$CAREER_OPS/generate-pdf.mjs" "$HTML_FILE" "$PDF_FILE" --format=letter >>"$LOG_FILE" 2>&1 || return 3
  [ -s "$PDF_FILE" ] || return 3

  # 1 or 2 pages are both acceptable (owner decision 2026-07-21); 3+ means
  # runaway content.
  PAGES=$(count_pages "$PDF_FILE")
  if [ -z "$PAGES" ] || [ "${PAGES:-0}" -gt 2 ] 2>/dev/null; then
    echo "PDF is ${PAGES:-unknown} pages" >>"$LOG_FILE"
    return 4
  fi
  return 0
}

render_and_check
RC=$?

if [ $RC -ne 0 ] && ! cmp -s "$PAYLOAD_FILE" "$DRAFT_FILE"; then
  # A gate rejected the patched payload. The deterministic draft is built purely
  # from cv.md-backed strings, so it is the safe thing to fall back to.
  echo "TAILOR_WARN: gate failed on reviewed payload (rc=$RC), retrying with the unpatched draft" >&2
  echo "gate failure rc=$RC on reviewed payload; falling back to draft" >>"$LOG_FILE"
  cp "$DRAFT_FILE" "$PAYLOAD_FILE"
  rm -f "$PDF_FILE"
  render_and_check
  RC=$?
fi

case $RC in
  0) echo "TAILOR_OK: $PDF_FILE"; exit 0 ;;
  1) echo "TAILOR_FAILED: build-cv-html.mjs rejected the payload, check $LOG_FILE" >&2 ;;
  2) echo "TAILOR_FAILED: verify-cv-facts.mjs flagged invented metrics, check $LOG_FILE" >&2 ;;
  3) echo "TAILOR_FAILED: generate-pdf.mjs failed, check $LOG_FILE" >&2 ;;
  4) echo "TAILOR_FAILED: PDF exceeded 2 pages, check $LOG_FILE" >&2 ;;
  *) echo "TAILOR_FAILED: unknown error rc=$RC, check $LOG_FILE" >&2 ;;
esac
exit 1
