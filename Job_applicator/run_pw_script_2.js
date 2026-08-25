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
  
  try {
    const url = "https://www.linkedin.com/jobs/view/4440075576/";
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await page.waitForTimeout(5000); // give it time to load

    let currentUrl = page.url();
    let title = await page.title();
    console.log("Current URL:", currentUrl);
    console.log("Page Title:", title);

    if (currentUrl.includes('authwall') || title.toLowerCase().includes('sign in')) {
        ok = false;
        reason = "Hit LinkedIn authwall or sign-in page, could not access job description.";
    } else {
        // Try to click "See more" if it's there
        const showMoreBtn = await page.$('button[aria-label="Show more, visually expands previously read content above"]');
        if (showMoreBtn) {
            console.log("Found show more button, clicking...");
            await showMoreBtn.click();
            await page.waitForTimeout(2000);
        } else {
            console.log("No show more button found.");
            // try general show more classes
            const altShowMore = await page.$('.show-more-less-html__button');
            if (altShowMore) {
                console.log("Found alt show more button, clicking...");
                await altShowMore.click();
                await page.waitForTimeout(2000);
            }
        }

        const applyExternalBtn = await page.$('a.apply-button'); 
        let clickedExternal = false;
        // Looking for the generic Apply button that goes external (not Easy Apply)
        const applyButtons = await page.$$('button:has-text("Apply")'); // Also look for buttons
        
        // This is complex headless. Let's dump the HTML or text to see.
        const bodyText = await page.evaluate(() => document.body.innerText);
        fs.writeFileSync('page_text.txt', bodyText, 'utf8');
        console.log("Saved page_text.txt");
        
        ok = false;
        reason = "Check page_text.txt for what was rendered.";
    }
  } catch (error) {
    ok = false;
    reason = "Error loading page: " + error.message;
  }
  
  await browser.close();
  console.log(JSON.stringify({ok, reason}));
})();
