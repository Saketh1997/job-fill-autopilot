#!/bin/bash
# Shared model-call wrapper for the whole pipeline. Sourced by
# fill_application.sh / drive_application.sh / submit_application.sh /
# linkedin-draft.sh, and shelled into by cli_model.mjs, ats_questions.mjs,
# amazon_apply.mjs and make_plan.py.
#
# Usage: run_claude <logfile> <claude-CLI args...>
#
# Every model call in this repo goes through here, which is why the provider
# FALLBACK CHAIN lives here too and nothing else had to change:
#
#     claude CLI  ->  agy (Antigravity) Claude Sonnet  ->  agy Gemini
#
# When the Claude Code subscription quota is spent ("You've hit your session
# limit · resets 11pm (America/New_York)" is what that actually looks like in
# the logs), the call is re-issued through `agy --model claude-sonnet-4-6`, and
# when Antigravity's Sonnet quota is spent too, through
# `agy --model gemini-3.1-pro-high` — the Pro tier at high reasoning effort,
# which is the Antigravity model worth pointing at an agentic browser run; the
# flash tiers lose the plot on a 150-turn Workday form.
#
# The chain is one env var:
#   MODEL_CHAIN="claude,agy:claude-sonnet-4-6,agy:gemini-3.1-pro-high"
# Drop an entry to disable it, reorder to prefer a different provider, or set
# MODEL_CHAIN=claude for the old single-provider behaviour.
#
# How the fallback stays invisible to callers: every caller finds its answer by
# grepping the log for the newest '"type":"result"' line and reading .result /
# .is_error / .session_id off it. The agy adapter below appends a line in
# exactly that shape (plus "cr_provider"/"cr_model" so a --resume can be routed
# back to the provider that owns the session), so ats_questions.mjs,
# make_plan.py and the rest keep working with no idea who answered.
#
# Quota exhaustion is STICKY. A spent provider is written to
# ~/.career-ops/quota.state with the epoch it comes back (parsed out of "resets
# 11pm (America/New_York)" or "reset after 15m 2s" when the API says so, else
# QUOTA_COOLDOWN seconds), and every later call in the batch skips straight past
# it instead of re-paying the failure. That is the difference between a batch
# limping and a batch stalling: without it, all 18 postings each burn three
# attempts on a provider that is already known to be out.
#
# Two failure classes are still handled per provider, as before:
#
# 1. Transient API errors ("api_error_status":429/400/5xx with a short reset):
#    retry up to 3 times, sleeping past the reset when one is quoted. A 429 that
#    quotes a reset of 5 minutes or more is NOT treated as transient — falling
#    through to the next provider beats sleeping half an hour.
#
# 2. "error_max_turns": the task ran out of turns mid-flight. NOT transient —
#    restarting re-pays the whole run for the same outcome. Resume the same
#    session once (--resume <session_id>) so the model finishes with its
#    context. A second cap hit means the task genuinely doesn't fit.
#
# run_claude returns 0 as soon as any provider produces a clean result, 1 when
# the whole chain is exhausted.
#
# OmniRoute (localhost:20128) is gone. Default to the real API; the claude CLI
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

: "${CLAUDE_BIN:=/home/hunter/.local/bin/claude}"
: "${AGY_BIN:=/home/hunter/.local/bin/agy}"
: "${AGY_SONNET_MODEL:=claude-sonnet-4-6}"
: "${AGY_GEMINI_MODEL:=gemini-3.1-pro-high}"
: "${MODEL_CHAIN:=claude,agy:${AGY_SONNET_MODEL},agy:${AGY_GEMINI_MODEL}}"
: "${QUOTA_STATE_FILE:=${HOME}/.career-ops/quota.state}"
: "${QUOTA_COOLDOWN:=3600}"
: "${QUOTA_COOLDOWN_MAX:=21600}"
# agy's print mode gives up after 5m by default, which is nothing next to a
# 150-turn drive_application run.
: "${AGY_PRINT_TIMEOUT:=90m}"
: "${PLAYWRIGHT_MCP_BIN:=/home/hunter/.nvm/versions/node/v20.20.2/bin/playwright-mcp}"
: "${PLAYWRIGHT_CDP:=http://localhost:9226}"
# Exported so a run-level override reaches the children that re-source this file
# for themselves (make_plan.py, map_fields.mjs, ats_questions.mjs): one
# `MODEL_CHAIN=... ./run_all_phases.sh` then governs the whole batch.
export MODEL_CHAIN AGY_SONNET_MODEL AGY_GEMINI_MODEL AGY_PRINT_TIMEOUT \
       QUOTA_STATE_FILE QUOTA_COOLDOWN QUOTA_COOLDOWN_MAX

# ---------------------------------------------------------------- quota state

_cr_now() { date +%s; }

# Epoch at which <chain entry> is expected back, or 0.
_cr_cooldown_until() {
  local v=""
  [ -f "$QUOTA_STATE_FILE" ] || { echo 0; return 0; }
  v=$(grep -F "$1=" "$QUOTA_STATE_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2-)
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}

_cr_mark_exhausted() {
  local entry="$1" until="$2" tmp=""
  mkdir -p "$(dirname "$QUOTA_STATE_FILE")" 2>/dev/null
  tmp="${QUOTA_STATE_FILE}.$$"
  { [ -f "$QUOTA_STATE_FILE" ] && grep -vF "$entry=" "$QUOTA_STATE_FILE" 2>/dev/null
    printf '%s=%s\n' "$entry" "$until"; } > "$tmp" 2>/dev/null
  mv -f "$tmp" "$QUOTA_STATE_FILE" 2>/dev/null
}

# Clear a cooldown by hand: `_cr_clear_quota agy:gemini-3.1-pro-high`, or with
# no argument to clear all of them.
_cr_clear_quota() {
  if [ -z "${1:-}" ]; then rm -f "$QUOTA_STATE_FILE"; return 0; fi
  local tmp="${QUOTA_STATE_FILE}.$$"
  [ -f "$QUOTA_STATE_FILE" ] || return 0
  grep -vF "$1=" "$QUOTA_STATE_FILE" > "$tmp" 2>/dev/null
  mv -f "$tmp" "$QUOTA_STATE_FILE"
}

# Turn whatever reset hint the provider gave us into an epoch. Understands the
# three shapes seen in the logs: "resets 11pm (America/New_York)",
# "reset after 15m 2s", and "usage limit reached|1755820000".
_cr_reset_epoch() {
  python3 - "$1" "$QUOTA_COOLDOWN" "$QUOTA_COOLDOWN_MAX" <<'PY' 2>/dev/null
import re, sys, time
msg, default, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = int(time.time())
until = 0

m = re.search(r'(?:usage limit reached|limit reached)\|(\d{10,13})', msg)
if m:
    v = int(m.group(1))
    until = v // 1000 if v > 10 ** 11 else v

if not until:
    m = re.search(r'reset(?:s|ting)? after\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?', msg, re.I)
    if m and any(m.groups()):
        h, mi, s = (int(g or 0) for g in m.groups())
        until = now + h * 3600 + mi * 60 + s + 60

if not until:
    m = re.search(r'resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?', msg, re.I)
    if m:
        hour, minute = int(m.group(1)), int(m.group(2) or 0)
        ampm, tzname = m.group(3).lower(), m.group(4)
        hour = hour % 12 + (12 if ampm == 'pm' else 0)
        tz = None
        if tzname:
            try:
                from zoneinfo import ZoneInfo
                tz = ZoneInfo(tzname.strip())
            except Exception:
                tz = None
        from datetime import datetime, timedelta
        base = datetime.now(tz)
        target = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= base:
            target += timedelta(days=1)
        until = int(target.timestamp()) + 60

if not until:
    until = now + default
# Never park a provider for less than a minute or longer than the cap: a bad
# parse must not take a working provider out of the chain for the whole day.
print(max(now + 60, min(until, now + cap)))
PY
}

# Is this result a spent quota (switch providers) rather than a blip (retry)?
_cr_is_quota() {
  printf '%s' "$1" | grep -qiE \
    "hit your (session|usage|weekly|monthly|daily) limit|usage limit reached|limit reached\|[0-9]{10}|out of (credits|quota)|credit balance is too low|insufficient (credits|quota|balance)|quota (exceeded|exhausted)|resource[_ ]exhausted|\"api_error_status\":40[12]" \
    && return 0
  # A 429 that quotes a long reset is a spent window, not a blip: falling
  # through to the next provider beats sleeping past it.
  case "$1" in
    *429*)
      printf '%s' "$1" | grep -qiE 'reset(s|ting)? after +([0-9]+ *h|[0-9]{2,} *m|[5-9] *m)' && return 0 ;;
  esac
  return 1
}

# ------------------------------------------------------- argument translation

# Pull the pieces the agy path needs out of a claude-CLI argv.
_cr_parse_args() {
  CR_PROMPT=""; CR_HAVE_PROMPT=0; CR_MODEL=""; CR_TOOLS=""; CR_RESUME=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -p|--print)
        # `-p "<prompt>"` carries the prompt inline; a bare `-p` means it
        # arrives on stdin through CLAUDE_PROMPT_FILE.
        if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then CR_PROMPT="$2"; CR_HAVE_PROMPT=1; shift; fi ;;
      --model)        CR_MODEL="${2:-}"; shift ;;
      --allowedTools) CR_TOOLS="${2:-}"; shift ;;
      --resume)       CR_RESUME="${2:-}"; shift ;;
      --disallowedTools|--max-turns|--output-format|--mcp-config|--permission-mode)
                      shift ;;
      *) ;;
    esac
    shift
  done
}

# Which provider owns a session id, so a caller's --resume nudge goes back to
# the one that actually ran it. Claude's own result lines carry no cr_provider.
_cr_owner() {
  local log="$1" sid="$2" line=""
  [ -f "$log" ] || { echo claude; return 0; }
  line=$(grep -F "\"session_id\":\"$sid\"" "$log" 2>/dev/null | tail -n 1)
  case "$line" in
    *'"cr_provider":"agy"'*)
      printf 'agy:%s\n' "$(printf '%s' "$line" | grep -oE '"cr_model":"[^"]*"' | tail -n 1 | cut -d'"' -f4)" ;;
    *) echo claude ;;
  esac
}

# ------------------------------------------------------------ claude provider
# 0 clean result, 1 hard failure, 2 quota spent (the chain should move on).

_cr_claude() {
  local log="$1"; shift
  local attempt result wait mins sid resumed=0
  local -a extra=()
  for attempt in 1 2 3; do
    # CLAUDE_PROMPT_FILE feeds the prompt on stdin instead of argv. A question
    # pass carrying the CV, the JD, nine background files and 31 questions is
    # ~130KB, which is past the kernel's per-argument limit: the Palantir run
    # died with "spawnSync bash E2BIG" before claude was ever reached. Re-opened
    # inside the loop so a retry does not read an exhausted fd.
    if [ -n "${CLAUDE_PROMPT_FILE:-}" ]; then
      "$CLAUDE_BIN" "${extra[@]}" "$@" < "$CLAUDE_PROMPT_FILE" >> "$log" 2>&1
    else
      "$CLAUDE_BIN" "${extra[@]}" "$@" >> "$log" 2>&1
    fi
    # Find the newest result JSON line rather than blindly trusting the last
    # log line — a crashed claude process leaves stray stderr text at the
    # tail, which must not be mistaken for a successful result.
    result=$(tail -n 20 "$log" | grep '"type":"result"' | tail -n 1)
    if [ -z "$result" ]; then
      echo "RETRY: no result line from claude on attempt $attempt (process died?)" >> "$log"
      [ "$attempt" -eq 3 ] && break
      sleep $((attempt * 90))
      continue
    fi
    case "$result" in
      *'"is_error":true'*) ;;
      *) return 0 ;;
    esac

    if _cr_is_quota "$result"; then
      echo "QUOTA: the claude CLI is out of quota, handing off to the next provider" >> "$log"
      return 2
    fi

    if printf '%s' "$result" | grep -q '"subtype":"error_max_turns"'; then
      if [ "$resumed" -eq 1 ]; then
        echo "MAX_TURNS: still unfinished after one resume, giving up" >> "$log"
        return 1
      fi
      sid=$(printf '%s' "$result" | grep -oE '"session_id":"[a-f0-9-]+"' | head -1 | cut -d'"' -f4)
      if [ -z "$sid" ]; then
        echo "MAX_TURNS: no session_id in result, cannot resume" >> "$log"
        return 1
      fi
      resumed=1
      extra=(--resume "$sid")
      echo "RESUME: max turns hit, resuming session $sid to finish the task" >> "$log"
      continue
    fi

    [ "$attempt" -eq 3 ] && break
    wait=$((attempt * 90))
    mins=$(printf '%s' "$result" | grep -oE 'reset after [0-9]+m' | grep -oE '[0-9]+' | head -1)
    if [ -n "$mins" ]; then
      wait=$(( (mins + 1) * 60 ))
    fi
    [ "$wait" -gt 1800 ] && wait=1800
    echo "RETRY: api error on attempt $attempt, sleeping ${wait}s before retrying" >> "$log"
    sleep "$wait"
  done
  echo "RETRY_EXHAUSTED: api error persisted across 3 attempts" >> "$log"
  return 1
}

# --------------------------------------------------------------- agy provider

# The browser stages ask for mcp__playwright__*; agy keeps MCP servers in its
# own global config, so register the same CDP-attached server the repo's
# .mcp.json gives claude. Idempotent, and only reached on a browser stage.
_cr_ensure_agy_playwright() {
  local log="$1"
  "$AGY_BIN" mcp list 2>/dev/null | grep -qi playwright && return 0
  echo "AGY: registering the playwright MCP server (cdp $PLAYWRIGHT_CDP)" >> "$log"
  "$AGY_BIN" mcp add playwright -- "$PLAYWRIGHT_MCP_BIN" --cdp-endpoint "$PLAYWRIGHT_CDP" >> "$log" 2>&1
}

# Rewrite agy's own result JSON into the claude-shaped result line every caller
# in this repo greps for. Prints OK / ERR / PARSE.
_cr_agy_adapt() {
  python3 - "$1" "$2" "$3" <<'PY' 2>>"$1"
import json, sys
log, raw, model = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(raw, encoding='utf-8', errors='replace').read()

obj = None
try:
    obj = json.loads(text)
except Exception:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith('{') and '"response"' in line:
            try:
                obj = json.loads(line)
                break
            except Exception:
                continue
if not isinstance(obj, dict):
    obj = None

status = str((obj or {}).get('status', '')).upper()
ok = bool(obj) and status in ('SUCCESS', 'COMPLETED', 'OK', 'DONE')
response = (obj or {}).get('response')
if not ok and not response:
    # No parsable envelope: hand the tail of what agy actually printed to the
    # caller, which is what makes a chain failure debuggable at all.
    response = text.strip()[-2000:] or 'no output from agy'

out = {
    "type": "result",
    "subtype": "success" if ok else "error",
    "is_error": not ok,
    "result": response,
    "session_id": (obj or {}).get('conversation_id', ''),
    "num_turns": (obj or {}).get('num_turns', 0),
    "duration_ms": int(float((obj or {}).get('duration_seconds', 0) or 0) * 1000),
    "total_cost_usd": 0,
    "usage": (obj or {}).get('usage', {}),
    "cr_provider": "agy",
    "cr_model": model,
}
# separators matter: every caller greps for the literal '"type":"result"'.
with open(log, 'a', encoding='utf-8') as fh:
    fh.write(json.dumps(out, separators=(',', ':')) + "\n")
print("OK" if ok else ("ERR" if obj else "PARSE"))
PY
}

# 0 clean result, 1 hard failure, 2 quota spent.
_cr_agy() {
  local log="$1" model="$2"; shift 2
  _cr_parse_args "$@"

  local work prompt_file raw size status rc body
  work=$(mktemp -d "${TMPDIR:-/tmp}/agy-call-XXXXXX") || return 1
  prompt_file="$work/prompt.txt"
  raw="$work/raw.json"

  if [ "$CR_HAVE_PROMPT" -eq 1 ]; then
    printf '%s' "$CR_PROMPT" > "$prompt_file"
  elif [ -n "${CLAUDE_PROMPT_FILE:-}" ] && [ -s "${CLAUDE_PROMPT_FILE:-/nonexistent}" ]; then
    cat "$CLAUDE_PROMPT_FILE" > "$prompt_file"
  else
    echo "AGY: no prompt to send (neither -p <text> nor CLAUDE_PROMPT_FILE)" >> "$log"
    rm -rf "$work"; return 1
  fi

  local -a argv=()
  local big=0
  size=$(wc -c < "$prompt_file" | tr -d ' ')
  [ "${size:-0}" -gt 100000 ] && big=1
  if [ "$big" -eq 1 ]; then
    # agy takes its prompt on argv only — a bare `-p` with the text on stdin is
    # silently ignored and the model answers something else entirely (verified
    # 2026-08-21). Past MAX_ARG_STRLEN (128KB) argv is not an option either, so
    # the big ones are handed over as a file to read. Same E2BIG wall the claude
    # path hit, different way around it.
    argv=(-p "Read the file $prompt_file and follow the instructions in it exactly. Use no tool other than reading that one file, and reply with only the output those instructions ask for." --add-dir "$work")
  elif [ -z "$CR_TOOLS" ]; then
    # The no-tool callers (questions, plan, review, map_fields) disable tools on
    # the claude side with --allowedTools ""; agy has no equivalent flag, so it
    # has to be said in the prompt instead.
    { echo "Answer using only the text of this prompt. Do not use any tools."; echo; cat "$prompt_file"; } > "$work/wrapped.txt"
    argv=(-p "$(cat "$work/wrapped.txt")")
  else
    argv=(-p "$(cat "$prompt_file")")
  fi

  case "$CR_TOOLS" in
    *mcp__playwright*) _cr_ensure_agy_playwright "$log" ;;
  esac

  argv+=(--model "$model" --output-format json --print-timeout "$AGY_PRINT_TIMEOUT" --disable-slash-commands)
  # Headless agy cannot prompt for a tool permission and auto-denies it, which
  # ends the run with no output at all. Every caller already decided which tools
  # claude may use, and these runs happen in a throwaway cwd.
  if [ -n "$CR_TOOLS" ] || [ "$big" -eq 1 ]; then
    argv+=(--dangerously-skip-permissions)
  fi
  [ -n "$CR_RESUME" ] && argv+=(--conversation "$CR_RESUME")

  if [ -n "$CR_TOOLS" ]; then
    echo "AGY: calling agy --model $model (tools: $CR_TOOLS, prompt ${size}B)" >> "$log"
  else
    echo "AGY: calling agy --model $model (no tools, prompt ${size}B)" >> "$log"
  fi
  "$AGY_BIN" "${argv[@]}" > "$raw" 2>>"$log"
  rc=$?
  status=$(_cr_agy_adapt "$log" "$raw" "$model")

  if [ "$status" = "OK" ]; then
    rm -rf "$work"
    return 0
  fi

  body="$(tail -c 4000 "$raw" 2>/dev/null)$(tail -n 5 "$log" 2>/dev/null)"
  rm -rf "$work"
  if _cr_is_quota "$body"; then
    echo "QUOTA: agy/$model is out of quota, handing off to the next provider" >> "$log"
    return 2
  fi
  echo "AGY_FAILED: agy/$model returned no usable result (exit $rc, adapt $status)" >> "$log"
  return 1
}

# ------------------------------------------------------------------ dispatcher

run_claude() {
  local log="$1"; shift
  local -a args=("$@")
  mkdir -p "$(dirname "$log")" 2>/dev/null

  _cr_parse_args "${args[@]}"

  local -a chain=()
  local IFS_SAVE="$IFS"
  IFS=','; read -r -a chain <<< "$MODEL_CHAIN"; IFS="$IFS_SAVE"

  # A --resume only means anything to the provider that owns the session, so a
  # resume runs on that provider alone instead of walking the chain.
  if [ -n "$CR_RESUME" ]; then
    chain=("$(_cr_owner "$log" "$CR_RESUME")")
  fi

  local entry provider model until now rc=1 ran=0
  for entry in "${chain[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"; entry="${entry%"${entry##*[![:space:]]}"}"
    [ -n "$entry" ] || continue
    provider="${entry%%:*}"
    model="${entry#*:}"; [ "$model" = "$entry" ] && model=""

    until=$(_cr_cooldown_until "$entry"); now=$(_cr_now)
    if [ "$until" -gt "$now" ] && [ -z "$CR_RESUME" ]; then
      echo "SKIP: $entry is out of quota for another $(( (until - now + 59) / 60 ))m, trying the next provider" >> "$log"
      continue
    fi

    ran=1
    # Remember where this provider's own output starts, so the reset hint that
    # sets its cooldown is read from ITS lines and not from the message the
    # provider above it left in the same log.
    local mark=0
    [ -f "$log" ] && mark=$(wc -l < "$log" 2>/dev/null | tr -d ' ')
    case "$provider" in
      claude) _cr_claude "$log" "${args[@]}"; rc=$? ;;
      agy)    _cr_agy "$log" "${model:-$AGY_SONNET_MODEL}" "${args[@]}"; rc=$? ;;
      *)      echo "CHAIN: unknown provider '$provider' in MODEL_CHAIN, skipping" >> "$log"; continue ;;
    esac

    [ "$rc" -eq 0 ] && return 0

    if [ "$rc" -eq 2 ]; then
      _cr_mark_exhausted "$entry" \
        "$(_cr_reset_epoch "$(tail -n +$((mark + 1)) "$log" 2>/dev/null | tail -n 20)")"
    fi
    echo "FALLBACK: $entry did not answer (rc=$rc), moving down the chain" >> "$log"
  done

  if [ "$ran" -eq 0 ]; then
    echo "CHAIN_COLD: every provider in MODEL_CHAIN is in quota cooldown; nothing was called" >> "$log"
  else
    echo "CHAIN_EXHAUSTED: no provider in MODEL_CHAIN produced a result" >> "$log"
  fi
  return 1
}

# Pull the session_id out of the newest result line in a log, for callers
# that want to nudge an incomplete-but-"successful" session to finish
# (e.g. the model ended its turn without writing the required output file).
last_session_id() {
  grep -oE '"session_id":"[a-zA-Z0-9-]+"' "$1" | tail -1 | cut -d'"' -f4
}
