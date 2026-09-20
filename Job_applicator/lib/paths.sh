# paths.sh -- shell twin of lib/paths.mjs. Source it, do not execute it.
#
#   source "$(dirname "$0")/lib/paths.sh"
#   cd "$APP"
#
# Replaces the `cd /home/hunter/projects/career-ops/Job_applicator` line at the
# top of ~30 scripts. Resolution: CAREER_OPS_ROOT, else walk up from this file.

_co_is_root() { [ -d "$1/Job_applicator" ] && [ -f "$1/package.json" ]; }

_co_resolve_root() {
  if [ -n "${CAREER_OPS_ROOT:-}" ]; then
    if ! _co_is_root "$CAREER_OPS_ROOT"; then
      echo "CAREER_OPS_ROOT=$CAREER_OPS_ROOT is not a career-ops checkout" >&2
      return 1
    fi
    printf '%s\n' "$CAREER_OPS_ROOT"
    return 0
  fi
  # BASH_SOURCE[0] is this file even when sourced, which is the point.
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != "/" ]; do
    if _co_is_root "$d"; then printf '%s\n' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  echo "Could not locate the career-ops checkout; set CAREER_OPS_ROOT" >&2
  return 1
}

ROOT="$(_co_resolve_root)" || return 1
export CAREER_OPS_ROOT="$ROOT"
export ROOT
export APP="$ROOT/Job_applicator"
export DATA="$ROOT/data"
export VENV="$ROOT/.venv-jobspy"
export PROFILE="$APP/profile.json"
export CONSENT="$APP/config/consent.json"

# Activate the one venv that has `mcp` in it. A bare python3 here is the cause of
# the recurring ModuleNotFoundError: No module named 'mcp' (PIPELINE.md 2.2).
co_activate_venv() {
  if [ -f "$VENV/bin/activate" ]; then
    # shellcheck disable=SC1091
    . "$VENV/bin/activate"
  else
    echo "WARN: no venv at $VENV -- python stages will use system python3" >&2
  fi
}
