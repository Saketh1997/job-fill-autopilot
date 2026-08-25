#!/bin/bash
SLUG="$1"
cd /home/hunter/projects/career-ops/Job_applicator/resumes
if pdflatex -interaction=nonstopmode -halt-on-error "$SLUG.tex" > "$SLUG.buildlog" 2>&1 \
   && [ -f "$SLUG.pdf" ]; then
  rm -f "$SLUG.aux" "$SLUG.log" "$SLUG.out"
  echo "COMPILE_OK"
else
  grep -A3 '^!' "$SLUG.buildlog" | head -30 > "$SLUG.err"
  echo "COMPILE_FAILED"
fi
