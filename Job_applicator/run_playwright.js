const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 1400 }
  });
  const page = await context.newPage();
  
  await page.goto('https://job-boards.greenhouse.io/anthropic/jobs/5362838008', { waitUntil: 'networkidle', timeout: 30000 });
  
  // Wait to see if content loads
  await page.waitForTimeout(2000);
  
  // Get main content
  const title = await page.title();
  let content = '';
  
  try {
    const jobDescriptionElement = await page.$('#header');
    const contentElement = await page.$('#content');
    
    if (jobDescriptionElement) {
        content += await jobDescriptionElement.innerText() + "\n";
    }
    
    if (contentElement) {
        content += await contentElement.innerText();
    }
    
    if (!jobDescriptionElement && !contentElement) {
       content = await page.innerText('body');
    }
  } catch (e) {
    content = await page.innerText('body');
  }
  
  const url = page.url();
  
  fs.writeFileSync('job_data.json', JSON.stringify({
    url: url,
    title: title,
    content: content
  }, null, 2));

  await browser.close();
})();
