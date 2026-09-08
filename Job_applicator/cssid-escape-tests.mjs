/*
 * cssid-escape-tests.mjs — regression tests for numeric-id CSS escaping.
 *
 * A CSS identifier may not begin with a digit. Greenhouse demographic question
 * ids are pure numbers, so `#${id}` yields '#4005246007', which Playwright
 * rejects with "SyntaxError: '#4005246007' is not a valid selector" out of
 * locator.count(). On 2026-08-29 that aborted the Energy Solutions fill and
 * left all 29 required fields empty.
 *
 * The correct form is the hex escape '\34 005246007' — the same form
 * readback.mjs already emits and feeds back to Playwright successfully
 * (#\34 012867007), which is the evidence that this shape works live.
 *
 * The two implementations under test are byte-identical by intent:
 *   greenhouse_apply.mjs  cssId()
 *   ats_submit.mjs        cssEscapeId()
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = dirname(fileURLToPath(import.meta.url));

// Pull each implementation out of its file so the test exercises the shipped
// source rather than a copy that can drift away from it.
function extract(file, name) {
  const src = readFileSync(join(BASE, file), 'utf8');
  const i = src.indexOf(name);
  if (i < 0) throw new Error(`${name} not found in ${file}`);
  const body = src.slice(i);
  const end = body.indexOf('\n};') >= 0 && body.indexOf('\n};') < body.indexOf('\n}')
    ? body.indexOf('\n};') + 3 : body.indexOf('\n}') + 2;
  return body.slice(0, end);
}

const mk = (file, name, decl) =>
  new Function(`${decl}; return ${name};`)();

const cssId = mk('greenhouse_apply.mjs', 'cssId', extract('greenhouse_apply.mjs', 'function cssId(id) {'));
const cssEscapeId = mk('ats_submit.mjs', 'cssEscapeId', extract('ats_submit.mjs', 'const cssEscapeId = (id) =>'));

let pass = 0, fail = 0;
const t = (name, got, want) => {
  if (got === want) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); fail++; }
};

console.log('numeric-id CSS escaping');
for (const [label, fn] of [['greenhouse_apply.cssId', cssId], ['ats_submit.cssEscapeId', cssEscapeId]]) {
  t(`${label}: pure-numeric id gets a hex first char`, fn('4005246007'), '\\34 005246007');
  t(`${label}: the id from the live Together AI form`, fn('4012867007'), '\\34 012867007');
  t(`${label}: leading digit other than 4`, fn('9012345'), '\\39 012345');
  t(`${label}: ordinary word id is untouched`, fn('first_name'), 'first_name');
  t(`${label}: greenhouse question_ id is untouched`, fn('question_12774804007'), 'question_12774804007');
  t(`${label}: hyphens survive`, fn('candidate-location'), 'candidate-location');
  t(`${label}: non-word chars still escaped`, fn('a.b:c'), 'a\\.b\\:c');
  t(`${label}: digit-leading with a dot`, fn('4a.b'), '\\34 a\\.b');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
