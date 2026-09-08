#!/usr/bin/env python3
"""Regression check for verify_outreach.py.

The 70 messages Saketh approved by hand are the ground truth: a rule that
rejects them is too strict, and a verifier that rejects everything is as
useless as one that rejects nothing. Run this after editing the rules.
The submission-proof check is ignored here -- older sent records predate
the answers/{slug}.drive.json convention.
"""
import sys
sys.path.insert(0, "/home/hunter/projects/career-ops/Job_applicator")
import verify_outreach as v

sent = [r for r in v.load() if r.get("status") == "sent"]
dirty = 0
for r in sent:
    problems, _ = v.check(r)
    problems = [x for x in problems if "drive.json" not in x]
    if problems:
        dirty += 1
        print("DIRTY", r["slug"][:48])
        for x in problems[:2]:
            print("      -", x[:105])
print(f"{len(sent) - dirty}/{len(sent)} human-approved sent messages pass")
sys.exit(0)
