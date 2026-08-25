import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = '/home/hunter/projects/career-ops/Job_applicator';
const PROFILE = JSON.parse(fs.readFileSync(path.join(BASE, 'profile.json'), 'utf8'));

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const APPS = [
  { name: 'SMX', url: 'https://www.smxtech.com/jobs/smxtech/software-engineer-secret-4611/?gh_jid=6693108003' },
  { name: 'Infleqtion (Compiler & Control)', url: 'https://apply.workable.com/coldquanta/j/350E0E30CF/' },
  { name: 'Infleqtion (Compiler)', url: 'https://apply.workable.com/coldquanta/j/45C525BF76/' },
  { name: 'STCU', url: 'https://jobs.smartrecruiters.com/STCU1/744000145379939-software-developer-i?oga=true' },
  { name: 'Ascensus', url: 'https://ascensushr.wd1.myworkdayjobs.com/ascensuscareers/job/Dresher-PA/Associate-Software-Engineer_R0021231' },
  { name: 'Cisco', url: 'https://cisco.wd5.myworkdayjobs.com/cisco_careers/job/Milpitas-California-US/Software-Engineer-I--Full-Time----United-States_2023527' },
  { name: 'Unity', url: 'https://unitytech.wd1.myworkdayjobs.com/Unity/job/Bellevue-WA-USA/Software-Engineer--XR_JOBREQ-2616415?source=jobright' },
  { name: 'Visa', url: 'https://visa.wd5.myworkdayjobs.com/visa/job/US---Austin-TX/Software-Engineer_REF081674W-1' },
  { name: 'Creative Artists Agency', url: 'https://caa.wd1.myworkdayjobs.com/careers/job/Los-Angeles-CA/Junior-Data-Scientist_JR9151' },
  { name: 'Oracle', url: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/343770' },
  { name: 'PACCAR', url: 'https://jobs.paccar.com/job/Mount-Vernon-Jr_-Software-Developer-WA-98273-9671/1429379533/' },
  { name: 'Liberty Mutual', url: 'https://careers-libertymutual.icims.com/jobs/77179/data-scientist%3a-property-%26-specialty-product-design-%26-modeling/job?in_iframe=1' },
  { name: 'IBM', url: 'https://careers.ibm.com/en_US/careers/JobDetail?jobId=129923' },
  { name: 'TikTok', url: 'https://lifeattiktok.com/search/7668828193675036981?spread=5MWH5CQ' }
];

async function fillSMX(page) {
  console.log('=== Filling SMX form ===');
  await page.waitForLoadState('domcontentloaded');
  await sleep(3000);

  // Find Greenhouse frame
  let frame = null;
  for (const f of page.frames()) {
    try {
      const form = await f.$('#application-form, input#first_name');
      if (form) { frame = f; break; }
    } catch (e) {}
  }
  if (!frame && page.frames().length > 1) {
    frame = page.frames()[1];
  }
  if (!frame) frame = page.mainFrame();

  console.log('Using SMX frame:', frame.url());

  // Attach resume
  const resumePath = path.join(BASE, 'resumes/job-SMX-Software_Engineer__Secret___4611_.pdf');
  const resumeInput = await frame.$('input[type="file"]#resume, input[type="file"]');
  if (resumeInput) {
    console.log('Uploading tailored SMX resume...');
    await resumeInput.setInputFiles(resumePath);
    await sleep(2000);
  }

  // Helper
  const fillId = async (id, val) => {
    const el = await frame.$('#' + id + ', input[id*="' + id + '"]');
    if (el) {
      await el.fill('');
      await el.type(val);
      console.log(`Filled #${id} -> ${val}`);
    }
  };

  await fillId('first_name', PROFILE.first_name);
  await fillId('last_name', PROFILE.last_name);
  await fillId('email', PROFILE.email);
  await fillId('phone', PROFILE.phone);

  // Fill remaining inputs
  const inputs = await frame.$$('input, select, textarea');
  for (const inp of inputs) {
    const id = (await inp.getAttribute('id')) || '';
    const label = await frame.$eval(`label[for="${id}"]`, l => l.innerText).catch(() => '');
    if (!label) continue;
    const l = label.toLowerCase();
    
    if (l.includes('legal first name') && !l.includes('full')) {
      await inp.fill(PROFILE.first_name);
    } else if (l.includes('legal last name')) {
      await inp.fill(PROFILE.last_name);
    } else if (l.includes('middle name')) {
      await inp.fill('Srinivasa Rao');
    } else if (l.includes('street address')) {
      await inp.fill(PROFILE.address.street);
    } else if (l.includes('city') && !l.includes('location')) {
      await inp.fill(PROFILE.address.city);
    } else if (l.includes('postal code') || l.includes('zip')) {
      await inp.fill(PROFILE.address.zip);
    } else if (l.includes('salary requirement')) {
      await inp.fill('$160,000');
    } else if (l.includes('enter full legal name')) {
      await inp.fill('Saketh Srinivasa Rao Metta');
    } else if (l.includes('date (mm/dd/yyyy)')) {
      await inp.fill('08/25/2026');
    }
  }

  // Security Clearance Checkbox "None"
  const noneBox = await frame.$('input[type="checkbox"][value*="None"], input[type="checkbox"][id*="None"]');
  if (noneBox) {
    await noneBox.check();
    console.log('Checked None for Security Clearance');
  }
}

async function run() {
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const ctx = browser.contexts()[0];

  console.log(`Opening ${APPS.length} unsubmitted applications in Chrome...`);

  for (const app of APPS) {
    console.log(`Opening ${app.name}: ${app.url}`);
    const page = await ctx.newPage();
    await page.goto(app.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
      console.log(`  Navigation notice for ${app.name}: ${e.message}`);
    });
    
    if (app.name === 'SMX') {
      await fillSMX(page).catch(e => console.error('SMX fill error:', e.message));
    }
    await sleep(500);
  }

  console.log('=== All applications opened in browser tabs! ===');
}

run().catch(console.error);
