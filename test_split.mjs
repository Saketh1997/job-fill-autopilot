import { readFileSync } from 'fs';
import { extractJdSkills, classifySkillGaps, skillMentionedInText } from '/home/hunter/projects/career-ops/jd-skill-gap.mjs';

const cvText = readFileSync('/home/hunter/projects/career-ops/cv.md', 'utf8');

// The original splitSkillsSection function
const SKILLS_HEADING_RE = /^#{1,4}\s*Skills\s*$/i;
const ANY_HEADING_RE = /^#{1,4}\s/;

function splitSkillsSection(cvText) {
  const lines = cvText.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SKILLS_HEADING_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return { namedSkillsText: '', proseText: cvText };
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const namedSkillsText = lines.slice(start, end).join('\n');
  const proseText = lines.slice(0, start - 1).concat(lines.slice(end)).join('\n');
  return { namedSkillsText, proseText };
}

const split = splitSkillsSection(cvText);
console.log("NAMED:", JSON.stringify(split.namedSkillsText));
