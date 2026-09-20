"""paths.py -- Python twin of lib/paths.mjs. Same resolution order, same errors.

Resolution: CAREER_OPS_ROOT, else walk up from this file. No hardcoded fallback --
a wrong guess points a run at someone else's data directory.
"""

import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _is_root(d: Path) -> bool:
    # Both markers, not just Job_applicator/: a stray directory of that name
    # upstream of the checkout would otherwise capture the walk.
    return (d / "Job_applicator").is_dir() and (d / "package.json").is_file()


def _walk_up(start: Path):
    for d in [start, *start.parents]:
        if _is_root(d):
            return d
    return None


def _resolve_root() -> Path:
    env = os.environ.get("CAREER_OPS_ROOT")
    if env:
        abs_ = Path(env).expanduser().resolve()
        if not _is_root(abs_):
            raise RuntimeError(
                f"CAREER_OPS_ROOT={env} does not look like a career-ops checkout "
                f"(expected Job_applicator/ and package.json inside it)")
        return abs_
    found = _walk_up(_HERE)
    if found is None:
        raise RuntimeError(
            f"Could not locate the career-ops checkout by walking up from {_HERE}. "
            f"Set CAREER_OPS_ROOT to the checkout root.")
    return found


ROOT = _resolve_root()
APP = ROOT / "Job_applicator"

DIRS = {
    "jd":      APP / "jd",
    "schema":  APP / "schema",
    "plans":   APP / "plans",
    "resumes": APP / "resumes",
    "answers": APP / "answers",
    "cache":   APP / "cache",
    "logs":    APP / "logs",
    "data":    ROOT / "data",
    "config":  APP / "config",
}

FILES = {
    "profile":      APP / "profile.json",
    "consent":      APP / "config" / "consent.json",
    "login_env":    APP / "login.env",
    "content_bank": APP / "content-bank.yml",
    "portals":      ROOT / "portals.yml",
    "pipeline_csv": ROOT / "data" / "pipeline.csv",
    "pipeline_md":  ROOT / "data" / "pipeline.md",
    "cv":           ROOT / "cv.md",
    "venv":         ROOT / ".venv-jobspy",
}

_SLUG_EXT = {"jd": ".txt", "schema": ".json", "plans": ".json",
             "resumes": ".pdf", "answers": ".json"}


def ensure_dirs() -> None:
    for d in DIRS.values():
        d.mkdir(parents=True, exist_ok=True)


def slug_path(kind: str, slug: str, ext: str | None = None) -> Path:
    if kind not in DIRS:
        raise ValueError(f"unknown artefact kind: {kind}")
    return DIRS[kind] / (slug + (ext if ext is not None else _SLUG_EXT.get(kind, "")))


if __name__ == "__main__":
    print("ROOT   ", ROOT)
    print("APP    ", APP)
    print("profile", FILES["profile"])
    print("slug   ", slug_path("jd", "acme-swe"))
