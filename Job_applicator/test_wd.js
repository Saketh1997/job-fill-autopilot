const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const context = browser.contexts()[0];
  for (const page of context.pages()) {
    if (page.url().includes('tmobile.wd1')) {
      console.log('URL:', page.url());
      const locators = page.locator('button, a');
      const count = await locators.count();
      for (let i=0; i<count; i++) {
         const txt = await locators.nth(i).innerText().catch(()=>'');
         if (txt.trim()) console.log(' - ' + txt.trim().replace(/\n/g, ' '));
      }
      break;
    }
  }
  await browser.close();
})();
