import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const url = process.argv[2];
if (!url) {
  console.error('Usage: node extract_job.mjs <url>');
  process.exit(1);
}

const descPath = '/home/hunter/projects/career-ops/Job_applicator/jd/job-YO_IT_Consulting-Data_Scientist_-_Remote.txt';
const urlPath = '/home/hunter/projects/career-ops/Job_applicator/jd/job-YO_IT_Consulting-Data_Scientist_-_Remote.url';

function truncateWords(text, maxWords = 300) {
  const words = text.split(/\s+/);
  if (words.length > maxWords) {
    return words.slice(0, maxWords).join(' ') + '...';
  }
  return text;
}

function extractTitleCompanyFromLinkedIn(page) {
  // Attempt to get title and company from LinkedIn job page
  // These selectors are based on common LinkedIn structure
  let title = '';
  let company = '';
  try {
    // Job title: h1 with class containing 'job-title' or 'jobs-details-top-card__title'
    const titleEl = page.locator('h1.jobs-details-top-card__title, h1[class*="job-title"]').first();
    if (titleEl) title = titleEl.innerText().catch(() => '');
  } catch {}
  try {
    // Company name: usually in a span or a inside a div with class containing 'company-name'
    const companyEl = page.locator('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name span, .jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name span').first();
    if (companyEl) company = companyEl.innerText().catch(() => '');
  } catch {}
  return { title, company };
}

function extractTitleCompanyFromPage(page) {
  // Fallback for external pages: get from page title and maybe meta
  let title = '';
  let company = '';
  try {
    title = page.title();
    // Some sites put company in meta or header
    const companyEl = page.locator('meta[name="company"]').first();
    if (companyEl) {
      const content = companyEl.getAttribute('content');
      if (content) company = content;
    }
    // If not found, try to find a company name in the header or footer
    if (!company) {
      const headerCompany = page.locator('header [itemprop="name"], footer [itemprop="name"], .company-name, .organization-name, .employer-name').first();
      if (headerCompany) company = headerCompany.innerText().catch(() => '');
    }
  } catch {}
  return { title, company };
}

function getDescriptionSelectors() {
  return [
    '.job-description',
    '.description',
    '.job-details',
    '.jd',
    '.job-description-content',
    '[class*="job-description"]',
    '[class*="description"]',
    '#job-description',
    '#description',
    'section.job-description',
    'div.job-description',
    '.job-description__text',
    '.job-desc',
    '.job-description-text',
    '.jobDescription',
  ];
}

async function run() {
  const result = {
    status: 'success',
    description: '',
    finalUrl: url,
    blocked_on: [],
    title: '',
    company: ''
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 1400 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Navigate to the URL
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Accept cookies if prompted (LinkedIn often has a cookie banner)
    try {
      const acceptButton = page.locator('button:has-text("Accept")').first();
      if (await acceptButton.count() > 0) {
        await acceptButton.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Check if we are on a sign-in page (if so, we can't proceed)
    const signInPrompt = page.locator('text="Sign in"').first();
    if (await signInPrompt.count() > 0) {
      result.status = 'partial';
      result.blocked_on.push('LinkedIn sign-in page detected; cannot access job description.');
      // Still try to get description if any, but likely none
    }

    // Detect Easy Apply or external apply link
    const easyApplyButton = page.locator('button:has-text("Easy Apply")').first();
    const isEasyApply = await easyApplyButton.count() > 0;

    let description = '';
    let finalUrl = url;
    let title = '';
    let company = '';

    if (isEasyApply) {
      // Stay on LinkedIn, expand description if needed
      try {
        const seeMore = page.locator('button:has-text("See more")').first();
        if (await seeMore.count() > 0) {
          await seeMore.click();
          await page.waitForTimeout(1000);
        }
      } catch {}

      // Extract title and company from LinkedIn
      const info = extractTitleCompanyFromLinkedIn(page);
      title = info.title;
      company = info.company;

      // Extract description from LinkedIn
      const descSelectors = [
        '.show-more-less-html__markup',
        '.jobs-description-content',
        '.job-description',
        '.jobs-description',
        '[data-test-id="job-description"]',
        '.jobs-details-description',
        '.job-details-description'
      ];
      for (const sel of descSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const text = await el.innerText();
          if (text.trim().length > 50) {
            description = text;
            break;
          }
        }
      }
      // If still empty, try to get all text from the job posting container
      if (!description) {
        const container = page.locator('.jobs-details, .jobs-details-container, .job-details-container').first();
        if (await container.count() > 0) {
          description = await container.innerText();
        } else {
          // Fallback: body text
          description = await page.locator('body').innerText();
        }
      }
      finalUrl = url; // stay on LinkedIn
    } else {
      // Look for external apply link
      const externalLink = page.locator('a:has-text("Apply on company website"), button:has-text("Apply on company website")').first();
      if (await externalLink.count() > 0) {
        // Click it and wait for navigation
        await externalLink.click();
        try {
          await page.waitForNavigation({ timeout: 10000 });
        } catch (e) {
          // Sometimes it opens a new tab; we might need to handle that
          // If navigation didn't happen, maybe it opened a new window
          // We'll check for new pages
          const pages = context.pages();
          if (pages.length > 1) {
            // Use the new page
            const newPage = pages[pages.length - 1];
            await newPage.waitForLoadState();
            // Switch to new page
            page = newPage;
          }
        }
        finalUrl = page.url();

        // Try to extract title and company from the external page
        const info = extractTitleCompanyFromPage(page);
        title = info.title;
        company = info.company;

        // Extract description from external page
        const descSelectors = getDescriptionSelectors();
        let descText = '';
        for (const sel of descSelectors) {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            const text = await el.innerText();
            if (text.trim().length > 100) {
              descText = text;
              break;
            }
          }
        }
        if (!descText || descText.trim().length < 100) {
          // Fallback: get all body text and try to filter out navigation
          const bodyText = await page.locator('body').innerText();
          // Remove common navigation/footer text (heuristic)
          const lines = bodyText.split('\n').filter(line => line.trim().length > 20);
          descText = lines.join('\n');
        }
        description = descText;
      } else {
        // No Easy Apply and no external link? Possibly the job is not open or page structure changed.
        result.blocked_on.push('No Easy Apply or external apply link found; cannot determine job posting.');
        // Still try to get description from LinkedIn page anyway
        const descSelectors = [
          '.show-more-less-html__markup',
          '.jobs-description-content',
          '.job-description',
          '.jobs-details-description'
        ];
        for (const sel of descSelectors) {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            const text = await el.innerText();
            if (text.trim().length > 50) {
              description = text;
              break;
            }
          }
        }
        if (!description) {
          // fallback to body text
          description = await page.locator('body').innerText();
        }
        finalUrl = url;
        const info = extractTitleCompanyFromLinkedIn(page);
        title = info.title;
        company = info.company;
      }
    }

    // Clean up description: remove excessive whitespace
    description = description.replace(/\s+/g, ' ').trim();

    // If description is still too short, record blocked
    if (!description || description.length < 20) {
      result.status = 'partial';
      result.blocked_on.push('Could not extract a meaningful job description.');
    }

    result.description = description;
    result.finalUrl = finalUrl;
    result.title = title;
    result.company = company;

    // Write files
    // Ensure jd directory exists
    const jdDir = path.dirname(descPath);
    if (!fs.existsSync(jdDir)) {
      fs.mkdirSync(jdDir, { recursive: true });
    }

    // Build content: include title and company if available
    let content = '';
    if (title) content += `Job Title: ${title}\n`;
    if (company) content += `Company: ${company}\n`;
    if (description) {
      const truncated = truncateWords(description, 300);
      content += `\n${truncated}`;
    }
    fs.writeFileSync(descPath, content.trim(), 'utf8');
    fs.writeFileSync(urlPath, finalUrl.trim(), 'utf8');

    // Output JSON result for logging
    console.log(JSON.stringify(result));

  } catch (error) {
    result.status = 'error';
    result.blocked_on.push(`Error: ${error.message}`);
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
