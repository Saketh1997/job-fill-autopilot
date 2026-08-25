import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = '/home/hunter/projects/career-ops/Job_applicator';
const PROFILE = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8'));

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findGreenhouseFrame(page) {
  for (const f of page.frames()) {
    try {
      const hasForm = await f.$('#application-form, form[action*="greenhouse"], input#first_name, input[name*="first_name"]');
      if (hasForm) return f;
    } catch (e) {
      // cross-origin or navigation
    }
  }
  return page.mainFrame();
}

async function fillReactSelect(frame, container, targetText) {
  try {
    const control = await container.$('.select__control, [class*="-control"]');
    if (!control) return false;
    await control.click();
    await sleep(400);
    const options = await frame.$$('[id^="react-select-"][id*="-option-"], .select__option, [class*="-option"]');
    for (const opt of options) {
      const txt = (await opt.innerText()).trim();
      if (txt.toLowerCase() === targetText.toLowerCase() || txt.toLowerCase().includes(targetText.toLowerCase())) {
        await opt.click();
        await sleep(300);
        return true;
      }
    }
    // If not found, try typeahead if input exists
    const input = await container.$('input');
    if (input) {
      await input.fill(targetText);
      await sleep(500);
      const filtered = await frame.$$('[id^="react-select-"][id*="-option-"], .select__option, [class*="-option"]');
      if (filtered.length > 0) {
        await filtered[0].click();
        await sleep(300);
        return true;
      }
    }
    // close if still open
    await frame.keyboard.press('Escape').catch(() => {});
  } catch (err) {
    console.error('react-select error:', err.message);
  }
  return false;
}

async function fillOldMission(page) {
  console.log('=== Filling Old Mission ===');
  const frame = await findGreenhouseFrame(page);
  console.log('Using frame:', frame.url());

  const resumePath = path.join(BASE, 'resumes/job-Old_Mission-Software_Engineer___2027_Graduate_Program__August_Start_.pdf');
  
  // 1. Resume upload
  const resumeInput = await frame.$('input[type="file"]#resume, input[type="file"]');
  if (resumeInput) {
    console.log('Uploading tailored resume...');
    await resumeInput.setInputFiles(resumePath);
    await sleep(2000); // wait for parse
  }

  // 2. Personal info
  const fills = [
    { sel: 'input#first_name, input[id*="first_name"]', val: PROFILE.first_name },
    { sel: 'input#last_name, input[id*="last_name"]', val: PROFILE.last_name },
    { sel: 'input#email, input[id*="email"]', val: PROFILE.email },
    { sel: 'input#phone, input[id*="phone"]', val: PROFILE.phone },
  ];

  for (const f of fills) {
    const el = await frame.$(f.sel);
    if (el) {
      await el.fill(f.val);
      console.log(`Filled ${f.sel} -> ${f.val}`);
    }
  }

  // Education fields
  const fields = await frame.$$('.field, [class*="field"]');
  for (const f of fields) {
    const label = await f.$('label, .label');
    if (!label) continue;
    const ltext = (await label.innerText()).toLowerCase();
    
    if (ltext.includes('school')) {
      console.log('Filling School...');
      await fillReactSelect(frame, f, 'Oregon State University');
    } else if (ltext.includes('degree')) {
      console.log('Filling Degree...');
      await fillReactSelect(frame, f, "Master's Degree");
    } else if (ltext.includes('discipline')) {
      console.log('Filling Discipline...');
      await fillReactSelect(frame, f, 'Computer Science');
    } else if (ltext.includes('start date year')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('2023');
    } else if (ltext.includes('end date year')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('2026');
    } else if (ltext.includes('linkedin')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.linkedin);
    } else if (ltext.includes('how did you hear')) {
      console.log('Filling How did you hear...');
      await fillReactSelect(frame, f, 'Company Website') ||
      await fillReactSelect(frame, f, 'Careers Site') ||
      await fillReactSelect(frame, f, 'Job Board') ||
      await fillReactSelect(frame, f, 'Other');
    } else if (ltext.includes('sat/act')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('Did not take');
    } else if (ltext.includes('gpa')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(String(PROFILE.education.GPA));
    } else if (ltext.includes('.edu email')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.email);
    } else if (ltext.includes('eligible to work in the united states')) {
      console.log('Filling US Eligibility...');
      await fillReactSelect(frame, f, 'Yes');
    } else if (ltext.includes('visa sponsorship')) {
      console.log('Filling Sponsorship...');
      await fillReactSelect(frame, f, 'Yes');
    }
  }
}

async function fillSMX(page) {
  console.log('=== Filling SMX ===');
  const frame = await findGreenhouseFrame(page);
  console.log('Using frame:', frame.url());

  const resumePath = path.join(BASE, 'resumes/job-SMX-Software_Engineer__Secret___4611_.pdf');
  
  // 1. Resume upload
  const resumeInput = await frame.$('input[type="file"]#resume, input[type="file"]');
  if (resumeInput) {
    console.log('Uploading tailored resume...');
    await resumeInput.setInputFiles(resumePath);
    await sleep(2000);
  }

  // 2. Standard personal info
  const fills = [
    { sel: 'input#first_name', val: PROFILE.first_name },
    { sel: 'input#last_name', val: PROFILE.last_name },
    { sel: 'input#email', val: PROFILE.email },
    { sel: 'input#phone', val: PROFILE.phone },
  ];
  for (const f of fills) {
    const el = await frame.$(f.sel);
    if (el) {
      await el.fill(f.val);
      console.log(`Filled ${f.sel} -> ${f.val}`);
    }
  }

  // 3. Scan all fields
  const fields = await frame.$$('.field, [class*="field"], [role="group"]');
  for (const f of fields) {
    const label = await f.$('label, .label, legend');
    if (!label) continue;
    const ltext = (await label.innerText()).toLowerCase();
    
    if (ltext.includes('legal first name') && !ltext.includes('full legal name')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.first_name);
    } else if (ltext.includes('legal last name')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.last_name);
    } else if (ltext.includes('middle name')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('Srinivasa Rao');
    } else if (ltext.includes('street address')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.address.street);
    } else if (ltext.includes('city') && !ltext.includes('location')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.address.city);
    } else if (ltext.includes('state')) {
      await fillReactSelect(frame, f, 'Pennsylvania') || await fillReactSelect(frame, f, 'PA');
    } else if (ltext.includes('postal code') || ltext.includes('zip')) {
      const inp = await f.$('input');
      if (inp) await inp.fill(PROFILE.address.zip);
    } else if (ltext.includes('at least 18 years of age')) {
      await fillReactSelect(frame, f, 'Yes');
    } else if (ltext.includes('security clearance')) {
      // Checkbox "None"
      const noneCheckbox = await f.$('input[type="checkbox"][value*="None"], input[type="checkbox"][id*="None"]');
      if (noneCheckbox) {
        await noneCheckbox.check();
      } else {
        const labels = await f.$$('label');
        for (const l of labels) {
          if ((await l.innerText()).trim() === 'None') {
            await l.click();
            break;
          }
        }
      }
    } else if (ltext.includes('work authorization') && !ltext.includes('require')) {
      await fillReactSelect(frame, f, 'F-1') ||
      await fillReactSelect(frame, f, 'OPT') ||
      await fillReactSelect(frame, f, 'Authorized') ||
      await fillReactSelect(frame, f, 'Other');
    } else if (ltext.includes('require') && (ltext.includes('sponsorship') || ltext.includes('work authorization'))) {
      await fillReactSelect(frame, f, 'Yes');
    } else if (ltext.includes('salary requirement')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('$160,000');
    } else if (ltext.includes('previously worked for smx')) {
      await fillReactSelect(frame, f, 'No');
    } else if (ltext.includes('equal opportunity employer') || ltext.includes('pursuant to the workers')) {
      await fillReactSelect(frame, f, 'Yes') || await fillReactSelect(frame, f, 'Acknowledge') || await fillReactSelect(frame, f, 'I understand');
    } else if (ltext.includes('smx data privacy policy')) {
      await fillReactSelect(frame, f, 'Yes') || await fillReactSelect(frame, f, 'I agree') || await fillReactSelect(frame, f, 'Agree');
    } else if (ltext.includes('conditions of application and employment')) {
      await fillReactSelect(frame, f, 'Yes') || await fillReactSelect(frame, f, 'I agree') || await fillReactSelect(frame, f, 'Agree');
    } else if (ltext.includes('electronic signature submittal')) {
      await fillReactSelect(frame, f, 'Yes') || await fillReactSelect(frame, f, 'I agree') || await fillReactSelect(frame, f, 'Agree');
    } else if (ltext.includes('enter full legal name')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('Saketh Srinivasa Rao Metta');
    } else if (ltext.includes('date (mm/dd/yyyy)')) {
      const inp = await f.$('input');
      if (inp) await inp.fill('08/25/2026');
    } else if (ltext.includes('gender') && !ltext.includes('expression')) {
      await fillReactSelect(frame, f, 'Male');
    } else if (ltext.includes('hispanic/latino')) {
      await fillReactSelect(frame, f, 'No');
    } else if (ltext.includes('veteran status')) {
      await fillReactSelect(frame, f, 'I am not a protected veteran') || await fillReactSelect(frame, f, 'not a protected veteran') || await fillReactSelect(frame, f, 'No');
    } else if (ltext.includes('disability status')) {
      await fillReactSelect(frame, f, 'No, I do not have a disability and have not had one in the past') ||
      await fillReactSelect(frame, f, 'No, I don\'t have a disability') ||
      await fillReactSelect(frame, f, 'No');
    }
  }
}

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (url.includes('oldmissioncapital')) {
        await fillOldMission(page);
      } else if (url.includes('smxtech')) {
        await fillSMX(page);
      }
    }
  }
  console.log('=== Finished filling open tabs ===');
}

main().catch(console.error);
