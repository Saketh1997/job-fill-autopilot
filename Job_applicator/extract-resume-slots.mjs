#!/usr/bin/env node

/**
 * extract-resume-slots.mjs — career-ops' extract-latex-content.mjs, plus one
 * extra slot for Resume.tex's Skills paragraph (a plain comma list, not an
 * itemize block, so career-ops' own extractor can't see it).
 *
 * Everything else (family detection, itemize-item slots, span math) comes
 * straight from career-ops' shared lib.mjs, unmodified.
 *
 * Usage:
 *   node extract-resume-slots.mjs <source.tex> [--out manifest.json]
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import { detectFamily, extractSlots, UNSUPPORTED_HINT } from '../lib/latex-content.mjs';

function extractSkillsSlot(tex) {
  const header = '\\section*{Skills}';
  const headerIdx = tex.indexOf(header);
  if (headerIdx === -1) return null;

  const contentStart = headerIdx + header.length;
  const nextSectionIdx = tex.indexOf('\\section*{', contentStart);
  if (nextSectionIdx === -1) return null;

  const raw = tex.slice(contentStart, nextSectionIdx);
  const tail = raw.match(/\\\\\s*\n\\vspace\{[^}]*\}\s*\n?$/);
  const bodyEnd = tail ? tail.index : raw.length;
  const body = raw.slice(0, bodyEnd);
  const leadingWs = body.match(/^\s*/)[0].length;
  const trailingWs = body.match(/\s*$/)[0].length;

  const start = contentStart + leadingWs;
  const end = contentStart + bodyEnd - trailingWs;
  if (end <= start) return null;

  return {
    id: 'skill-0',
    kind: 'skill',
    text: tex.slice(start, end),
    span: { start, end },
  };
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--help');
  const outIdx = args.indexOf('--out');
  let outPath = null;
  if (outIdx !== -1) {
    outPath = args[outIdx + 1];
    args.splice(outIdx, 2);
  }

  const sourcePath = args[0];
  if (!sourcePath) {
    console.error('Usage: node extract-resume-slots.mjs <source.tex> [--out manifest.json]');
    process.exit(1);
  }

  const absPath = resolve(sourcePath);
  if (!existsSync(absPath)) {
    console.error(`Source not found: ${absPath}`);
    process.exit(1);
  }

  const tex = await readFile(absPath, 'utf-8');
  const family = detectFamily(tex);

  let manifest;
  if (!family) {
    manifest = {
      supported: false,
      family: null,
      source: basename(absPath),
      slots: [],
      error: UNSUPPORTED_HINT,
    };
  } else {
    const slots = extractSlots(tex, family);
    const skillsSlot = extractSkillsSlot(tex);
    if (skillsSlot) slots.push(skillsSlot);
    manifest = { supported: true, family, source: basename(absPath), slots };
  }

  const json = JSON.stringify(manifest, null, 2);
  if (outPath) await writeFile(resolve(outPath), json, 'utf-8');
  console.log(json);
  process.exit(manifest.supported ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
