import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const CDP = process.env.CDP_ENDPOINT || 'http://localhost:9226';

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const pages = context.pages();
  console.log(`Found ${pages.length} open tabs`);

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const url = page.url();
    const title = await page.title();
    console.log(`\n--- Tab ${i}: [${title}] ${url} ---`);

    // Extract text from page and frames
    let pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    
    const frames = page.frames();
    for (const frame of frames) {
      if (frame !== page.mainFrame()) {
        try {
          const frameText = await frame.evaluate(() => document.body.innerText);
          pageText += '\n' + frameText;
        } catch (e) {}
      }
    }

    let slug = '';
    let role = 'swe';

    if (url.includes('mercuryinsurance')) {
      slug = 'mercury-software-engineer-i-test';
      role = 'swe';
    } else if (url.includes('studenttalent.bcg.com')) {
      slug = 'bcg-student-talent-associate';
      role = 'swe';
    } else if (url.includes('utah.peopleadmin.com')) {
      slug = 'university-of-utah-software-engineer';
      role = 'swe';
    } else if (url.includes('remilia.org')) {
      slug = 'remilia-corporation-software-engineer';
      role = 'swe';
    } else if (url.includes('withwaymo.com')) {
      slug = 'waymo-ml-engineer-foundation-model-infrastructure';
      role = 'ml';
    } else if (url.includes('generalmotors')) {
      slug = 'general-motors-software-engineer-av-data-collection';
      role = 'robotics';
    } else if (url.includes('mastercard')) {
      slug = 'mastercard-software-engineer-launch-program-2027';
      role = 'swe';
    } else if (url.includes('synnex')) {
      slug = 'synnex-hyve-software-engineer-new-college-grad';
      role = 'swe';
    } else if (url.includes('uhg.taleo.net')) {
      slug = 'unitedhealth-group-software-engineer-2379574';
      role = 'swe';
    } else if (url.includes('inspiracareers')) {
      slug = 'inspira-careers-software-developer';
      role = 'swe';
    } else if (url.includes('greptile.com')) {
      slug = 'greptile-infrastructure-engineer';
      role = 'swe';
    } else if (url.includes('careers-githubinc')) {
      slug = 'github-software-engineer-i-secret-scanning';
      role = 'swe';
    } else {
      slug = `tab-${i}-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    }

    const jdPath = `/home/hunter/projects/career-ops/Job_applicator/jd/${slug}.txt`;
    const resumePath = `/home/hunter/projects/career-ops/Job_applicator/resumes/${slug}.pdf`;

    const fullJd = `${title}\n${url}\n\n${pageText}`;
    fs.writeFileSync(jdPath, fullJd);
    console.log(`Saved JD to ${jdPath} (${fullJd.length} bytes)`);

    console.log(`Tailoring resume for ${slug} (${role})...`);
    try {
      execSync(`./tailor_resume.sh "${slug}" "${role}"`, {
        cwd: '/home/hunter/projects/career-ops/Job_applicator',
        stdio: 'inherit',
        env: { ...process.env, PATH: `/home/hunter/.local/bin:/home/hunter/.nvm/versions/node/v20.20.2/bin:${process.env.PATH}` }
      });
      console.log(`Generated tailored resume: ${resumePath}`);
    } catch (err) {
      console.error(`Error tailoring resume for ${slug}:`, err.message);
    }
  }

  console.log('\nAll tailored resumes generated successfully!');
}

main().catch(console.error);
