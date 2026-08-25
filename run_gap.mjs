import { readFileSync, writeFileSync } from 'fs';
import { extractJdSkills, classifySkillGaps } from '/home/hunter/projects/career-ops/jd-skill-gap.mjs';

const jdPath = process.argv[2];
const cvPath = process.argv[3];
const outPath = process.argv[4];

const jdText = readFileSync(jdPath, 'utf8');
const cvText = readFileSync(cvPath, 'utf8');

const jdSkills = extractJdSkills(jdText);
const result = classifySkillGaps(jdSkills, cvText);

writeFileSync(outPath, JSON.stringify(result, null, 2));
