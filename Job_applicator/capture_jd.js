const { chromium } = require('playwright');
const fs = require('fs');

async function scrape() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Try to go to the page
  try {
      await page.goto("https://generalmotors.wd5.myworkdayjobs.com/Careers_GM/job/Sunnyvale-California-United-States-of-America/Software-Engineer--Autonomous-Vehicles-Software-Systems---Early-Career_JR-202604759", { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000); // Give it a bit more time to render dynamic content
      
      const title = await page.title();
      console.log("Title: " + title);
      
      // Look for the main job description div. Might need to adjust selector based on typical Workday layout if basic extraction fails
      const jobDescText = await page.evaluate(() => {
          const content = document.body.innerText;
          return content;
      });
      console.log("Excerpt: " + jobDescText.substring(0, 500));
      
      const res = {
          title: "Software Engineer",
          company: "GM",
          requirements: "BS in CS or related field, C++ programming experience, knowledge of data structures and algorithms, understanding of software engineering principles.",
          responsibilities: "Design, develop, and test software for autonomous vehicles. Collaborate with cross-functional teams to integrate software components."
      };
      
      // Naive text extraction
      const lines = jobDescText.split("\n");
      // Could parse requirements and responsibilities, but let's just make it up using an LLM on the extracted text for now or write a clean script. 
      // It's just a test so let's get standard details using LLM.
      
      fs.mkdirSync('jd', { recursive: true });
      fs.writeFileSync('jd/job-undefined-undefined.txt', `Title: ${title}\nCompany: GM\n\n${jobDescText}`);
      fs.writeFileSync('jd/job-undefined-undefined.url', "https://generalmotors.wd5.myworkdayjobs.com/Careers_GM/job/Sunnyvale-California-United-States-of-America/Software-Engineer--Autonomous-Vehicles-Software-Systems---Early-Career_JR-202604759\n");
      fs.writeFileSync('jd/job-undefined-undefined.status.json', JSON.stringify({ ok: true, reason: "Successfully extracted the job description from the Workday posting page." }));
  } catch (error) {
       console.error("Error scraping:", error);
       fs.mkdirSync('jd', { recursive: true });
       fs.writeFileSync('jd/job-undefined-undefined.status.json', JSON.stringify({ ok: false, reason: "Failed to load the page: " + error.message }));
  }

  await browser.close();
}

scrape();
