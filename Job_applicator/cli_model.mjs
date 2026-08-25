// cli_model.mjs — one model call through the `claude` CLI instead of the HTTP
// API, for the two callers that used to talk to OmniRoute directly.
//
// Why this exists: OmniRoute (localhost:20128) served every model call in this
// pipeline behind an alias ("auto/best-coding"). It is gone, and the paths that
// spoke raw HTTP/SDK to it need an API key to reach api.anthropic.com — while
// the CLI already authenticates with its own stored credentials. Routing these
// two through the CLI means the whole pipeline needs no key at all.
//
// This is the same mechanism ats_questions.mjs uses for the question and review
// passes, and each piece of it is a bug already paid for once:
//   - the prompt goes in a FILE, because a 130KB argv died with E2BIG;
//   - the call is wrapped by claude_retry.sh, which owns the retry/backoff and
//     the base-URL/token decision;
//   - it runs from an empty cwd with MCP and tools off, so career-ops's own
//     CLAUDE.md is not loaded into a prompt that needs none of it.
//
// Throws on failure. Callers decide whether that is fatal — review_resume_patch
// fails open to the deterministic draft, map_fields falls back to blocked_on.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = path.dirname(fileURLToPath(import.meta.url));

export function callModelCli({ prompt, model, logPath = '', timeout = 300000, system = '' }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-model-'));
  const promptFile = path.join(sandbox, 'prompt.txt');
  // The CLI has no system-prompt flag in this invocation shape, so a system
  // message is prepended. Both callers' "system" text is instructions, not a
  // separate trust domain, so folding it in changes nothing about the result.
  fs.writeFileSync(promptFile, system ? `${system}\n\n${prompt}` : prompt);

  const log = logPath || path.join(sandbox, 'out.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });

  const script = 'source "$1" >/dev/null 2>&1 || exit 3; '
    + 'run_claude "$2" -p --model "$3" --output-format json '
    + '--allowedTools "" --disallowedTools "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" '
    + '--max-turns 4 --strict-mcp-config --mcp-config \'{"mcpServers":{}}\'';

  try {
    execFileSync('bash', ['-c', script, 'clim', path.join(BASE, 'claude_retry.sh'), log, model], {
      cwd: sandbox,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, CLAUDE_PROMPT_FILE: promptFile },
    });

    // Find the newest result line rather than trusting the tail: a crashed
    // process leaves stray stderr after it that must not be read as a result.
    const lines = fs.readFileSync(log, 'utf8').split('\n')
      .filter((l) => l.includes('"type":"result"'));
    if (!lines.length) throw new Error('no result line from the claude CLI');
    const env = JSON.parse(lines[lines.length - 1]);
    if (env.is_error) {
      throw new Error(String(env.result || 'model returned is_error').slice(0, 200));
    }
    return {
      text: String(env.result || ''),
      cost_usd: Number(env.total_cost_usd || 0),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
