import { readFileSync } from 'fs';
import { extractJdSkills, skillMentionedInText } from '/home/hunter/projects/career-ops/jd-skill-gap.mjs';

const cvText = readFileSync('/home/hunter/projects/career-ops/cv.md', 'utf8');

function splitSkillsSection(cvText) {
  const lines = cvText.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{0,4}\s*Skills\s*$/i.test(lines[i])) { // matches "Skills" without ##
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return { namedSkillsText: '', proseText: cvText };
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{0,4}\s*(Experience|Projects|Education|Unrelated Experience)\s*$/i.test(lines[i])) {
      end = i;
      break;
    }
  }

  const namedSkillsText = lines.slice(start, end).join('\n');
  const proseText = lines.slice(0, start - 1).concat(lines.slice(end)).join('\n');
  return { namedSkillsText, proseText };
}


const jdText = readFileSync('/home/hunter/projects/career-ops/Job_applicator/jd/job-Stripe-Full_Stack_Engineer.txt', 'utf8');

const jdSkills = extractJdSkills(jdText);
const { namedSkillsText, proseText } = splitSkillsSection(cvText);

const existing = [];
const supportedByResume = [];
const gap = [];

for (const skill of jdSkills) {
  if (skillMentionedInText(skill, namedSkillsText)) {
    existing.push(skill);
  } else if (skillMentionedInText(skill, proseText)) {
    supportedByResume.push(skill);
  } else {
    gap.push(skill);
  }
}

const res = { existing, supportedByResume, gap };
console.log(JSON.stringify(res, null, 2));
