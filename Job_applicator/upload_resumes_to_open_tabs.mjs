import { chromium } from 'playwright';
import path from 'node:path';

const BASE = '/home/hunter/projects/career-ops/Job_applicator';

const MAPPINGS = [
  {
    key: 'oraclecloud.com',
    name: 'Oracle',
    file: path.join(BASE, 'resumes/oracle-platform-software-engineer-1.pdf')
  },
  {
    key: 'cisco.wd5.myworkdayjobs.com',
    name: 'Cisco',
    file: path.join(BASE, 'resumes/cisco-software-engineer-i-full-time.pdf')
  },
  {
    key: 'careers-libertymutual.icims.com',
    name: 'Liberty Mutual',
    file: path.join(BASE, 'resumes/liberty-mutual-data-scientist-property-specialty.pdf'),
    inFrame: true
  },
  {
    key: 'lifeattiktok.com/resume',
    name: 'TikTok',
    file: path.join(BASE, 'resumes/tiktok-fullstack-software-engineer-graduate-global-ecom.pdf')
  },
  {
    key: 'careers.ibm.com',
    name: 'IBM',
    file: path.join(BASE, 'resumes/ibm-data-scientist-ai-elh-rtp-2027.pdf')
  },
  {
    key: 'unitytech.wd1.myworkdayjobs.com',
    name: 'Unity',
    file: path.join(BASE, 'resumes/unity-software-engineer-xr.pdf')
  }
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadToPage(page, mapping) {
  console.log(`\n--- Processing ${mapping.name} ---`);
  console.log(`URL: ${page.url()}`);
  console.log(`Resume: ${mapping.file}`);

  let input = null;

  if (mapping.inFrame) {
    for (const f of page.frames()) {
      input = await f.$('input[type="file"]').catch(() => null);
      if (input) {
        console.log(`Found file input in frame: ${f.url()}`);
        break;
      }
    }
  } else {
    // Check main frame
    input = await page.$('input[type="file"]').catch(() => null);
    if (!input) {
      // Check any subframes
      for (const f of page.frames()) {
        input = await f.$('input[type="file"]').catch(() => null);
        if (input) {
          console.log(`Found file input in subframe: ${f.url()}`);
          break;
        }
      }
    }
  }

  if (!input) {
    console.error(`ERROR: No file input found on page for ${mapping.name}`);
    return false;
  }

  try {
    await input.setInputFiles(mapping.file);
    console.log(`SUCCESS: Uploaded ${path.basename(mapping.file)} to ${mapping.name}`);
    await sleep(2000);
    return true;
  } catch (e) {
    console.error(`ERROR uploading to ${mapping.name}:`, e.message);
    return false;
  }
}

async function run() {
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const pages = browser.contexts()[0].pages();
  console.log(`Found ${pages.length} open pages.`);

  for (const mapping of MAPPINGS) {
    const page = pages.find(p => p.url().includes(mapping.key));
    if (page) {
      await uploadToPage(page, mapping);
    } else {
      console.log(`\nNotice: Page matching '${mapping.key}' for ${mapping.name} not found among open tabs.`);
    }
  }

  console.log('\n=== Upload pass completed! ===');
}

run().catch(console.error);
