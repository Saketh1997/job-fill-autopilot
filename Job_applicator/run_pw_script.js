const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 1400 }
  });
  const page = await context.newPage();
  
  let ok = false;
  let reason = "";
  
  try {
    const url = "https://www.linkedin.com/jobs/view/4440075576/";
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait a bit for page to settle
    await page.waitForTimeout(3000);
    
    // Basic check if it's a valid job page
    const titleMatch = await page.title();
    if (titleMatch.toLowerCase().includes('sign in') || titleMatch.toLowerCase().includes('login') || await page.$('form[action*="login"]')) {
      ok = false;
      reason = "Hit a login wall, could not access job description.";
    } else {
      // Check for external apply link vs easy apply
      const hasApplyOnCompanySite = await page.$('button:has-text("Apply")'); // Might need tweaking
      
      // Since this script is running headless without further human interaction or complex fallback logic 
      // let's try to extract what's on the page first (the user rule: "if it's an apply on company website, click and follow. If easy apply, do not click.")
      
      // Let's dump the text content to figure out what's what, and handle it.
      // But if we're fully automating in one go:
      const jobDetails = await page.evaluate(() => {
        const titleEl = document.querySelector('.top-card-layout__title');
        const companyEl = document.querySelector('.topcard__org-name-link');
        const descEl = document.querySelector('.show-more-less-html__markup') || document.querySelector('.description__text');
        
        // Is there an external apply?
        let isExternal = false;
        
        let applyButtons = Array.from(document.querySelectorAll('button'));
        for(let b of applyButtons) {
            let txt = b.textContent.trim().toLowerCase();
            if(txt === 'apply') {
                 isExternal = true;
            }
        }
        
        let aLinks = Array.from(document.querySelectorAll('a'));
        for(let a of aLinks) {
            let txt = a.textContent.trim().toLowerCase();
            if(txt === 'apply' && !txt.includes('easy apply')) {
                 isExternal = true;
            }
        }
        
        return {
           title: titleEl ? titleEl.textContent.trim() : null,
           company: companyEl ? companyEl.textContent.trim() : null,
           description: descEl ? descEl.textContent.trim() : null,
           isExternal: isExternal
        };
      });

      console.log(JSON.stringify(jobDetails));

    }
  } catch (error) {
    ok = false;
    reason = "Error loading page: " + error.message;
  }
  
  await browser.close();
})();
