const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 1400 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  let ok = false;
  let reason = "";
  let jTitle = "";
  let jCompany = "";
  let jDesc = "";
  let theUrl = "";
  
  try {
    const url = "https://www.linkedin.com/jobs/view/4440075576/";
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000); 

    let currentUrl = page.url();
    let pageTitle = await page.title();

    if (currentUrl.includes('authwall') || pageTitle.toLowerCase().includes('sign in') || pageTitle.toLowerCase().includes('login')) {
        ok = false;
        reason = "Hit LinkedIn authwall or sign-in page, could not access job description.";
    } else if (page.url() === 'https://www.linkedin.com/') {
       ok = false;
       reason = "Redirected to LinkedIn homepage.";
    } else {
        // Try to close modal if it exists (the error from previous attempt is a modal intercepting clicks)
        try {
           const dismissBtns = await page.$$('button[data-tracking-control-name="public_jobs_contextual-sign-in-modal_modal_dismiss"]');
           if (dismissBtns.length > 0) {
              await dismissBtns[0].click({force: true});
              await page.waitForTimeout(1000);
           }
        } catch(e) {}
        
        try {
           const closeBtns = await page.$$('button.modal__dismiss');
           if (closeBtns.length > 0) {
              await closeBtns[0].click({force: true});
              await page.waitForTimeout(1000);
           }
        } catch(e) {}

        // Try show more
        try {
            const altShowMore = await page.$('.show-more-less-html__button');
            if (altShowMore) {
                await altShowMore.click({force: true}); // force click to avoid modal intercept
                await page.waitForTimeout(2000);
            }
        } catch(e) {}
        
        const data = await page.evaluate(() => {
            let t = document.querySelector('h1.top-card-layout__title')?.innerText;
            if(!t) t = document.querySelector('.topcard__title')?.innerText;
            if(!t) t = document.querySelector('h1')?.innerText;
            
            let c = document.querySelector('.topcard__org-name-link')?.innerText;
            if(!c) c = document.querySelector('.topcard__flavor')?.innerText;
            
            let d = document.querySelector('.show-more-less-html__markup')?.innerText;
            if(!d) d = document.querySelector('.description__text')?.innerText;
            if(!d) d = document.querySelector('.jobs-description')?.innerText;
            
            let applyUrl = null;
            let extApplyBtn = document.querySelector('a.apply-button');
            if (extApplyBtn) applyUrl = extApplyBtn.href;
            
            // Or a button that triggers a new tab
            
            let easyApply = false;
            let btns = Array.from(document.querySelectorAll('button'));
            for(let b of btns) {
                if(b.innerText.toLowerCase().includes('easy apply')) easyApply = true;
            }
            let as = Array.from(document.querySelectorAll('a'));
            for(let a of as) {
                if(a.innerText.toLowerCase().includes('easy apply')) easyApply = true;
            }
            
            return {
               title: t ? t.trim() : "",
               company: c ? c.trim() : "",
               description: d ? d.trim() : "",
               applyUrl: applyUrl,
               easyApply: easyApply
            };
        });
        
        if (!data.title && !data.description) {
           ok = false;
           reason = "Job posting has been removed or page layout changed, could not extract description.";
        } else {
           if (data.applyUrl && !data.easyApply) {
               // Must click and follow redirect according to instructions
               console.log("Found external apply link: " + data.applyUrl);
               
               // We need to click it and let it open (might be a new tab)
               const [newPage] = await Promise.all([
                   context.waitForEvent('page'),
                   page.evaluate((url) => window.open(url, '_blank'), data.applyUrl)
               ]);
               
               await newPage.waitForLoadState('domcontentloaded');
               await newPage.waitForTimeout(5000);
               theUrl = newPage.url();
               console.log("Navigated to external site:", theUrl);
               
               // extract title, company, desc from the new page
               const extData = await newPage.evaluate(() => {
                   let t = document.querySelector('h1')?.innerText || "";
                   let d = document.body.innerText || "";
                   // heuristic to grab text
                   return { title: t, description: d };
               });
               
               jTitle = extData.title || data.title;
               jCompany = data.company;
               
               // the description from the company page can be massive, so we'll grab what we have or use the linkedin one if we can't parse it well.
               jDesc = extData.description;
               if (!jDesc || jDesc.length < 100) jDesc = data.description;
               
               await newPage.close();
           } else {
               theUrl = currentUrl;
               jTitle = data.title;
               jCompany = data.company;
               jDesc = data.description;
           }
           
           if (jDesc) {
               // extract just what is needed: responsibilities, requirements under 300 words
               ok = true;
               reason = "Successfully extracted job description.";
               
               // we do the text truncation here in node to avoid passing a huge string back
               let textToWrite = `Title: ${jTitle}\nCompany: ${jCompany}\n\nDescription:\n${jDesc}`;
               const words = textToWrite.split(/\s+/);
               if (words.length > 250) {
                   textToWrite = words.slice(0, 250).join(" ") + " ... (truncated)";
               }
               fs.writeFileSync('/home/hunter/projects/career-ops/Job_applicator/jd/job-Tesla-Data_Analytics_Engineer_Scientist__Thermal__Chassis.txt', textToWrite);
               
               // format the url strictly as required
               // remove tracking params from url just to be clean, or keep it.
               fs.writeFileSync('/home/hunter/projects/career-ops/Job_applicator/jd/job-Tesla-Data_Analytics_Engineer_Scientist__Thermal__Chassis.url', theUrl);
           } else {
               ok = false;
               reason = "Extracted title but no job description was found in the page markup.";
           }
        }
    }
  } catch (error) {
    ok = false;
    reason = "Error loading page or processing: " + error.message;
  }
  
  await browser.close();
  
  fs.writeFileSync('/home/hunter/projects/career-ops/Job_applicator/jd/job-Tesla-Data_Analytics_Engineer_Scientist__Thermal__Chassis.status.json', JSON.stringify({ok, reason}, null, 2));
  console.log("Done");
})();
