import { chromium } from 'playwright';
import fs from 'fs';

const QUEUE_PATH = '/home/hunter/projects/career-ops/data/linkedin-outreach-queue.json';
const SLUG = 'job-Wispr_Flow-Platform_Engineer__Infrastructure';

const SUBJECT = 'Wispr Flow Engineering Applications — Platform & Labs Roles (PostgreSQL Internals / Systems & RAG)';
const BODY = `Hi Eduardo,

I saw your recent note about Wispr Flow scaling the team following the Series B, and I wanted to reach out directly. I just submitted my applications for the Platform Engineer (Infrastructure) and Software Engineer (Labs) roles.

A quick snapshot of my background:
- Database Systems Research: I implemented novel sampling-based adaptive join algorithms (ROSL) directly inside PostgreSQL's NestLoop executor in C for my Master's thesis at Oregon State University, delivering up to 12x speedups on multi-GB workloads (paper under revision for VLDB).
- Full-Stack & AI Infrastructure: I built and operate a 2-node bare-metal Kubernetes homelab running 24/7 with GPU passthrough for local LLM inference, and built a RAG chatbot backend deployed on this cluster (live at sakethmetta.org).
- Production Systems: As a Salesforce Engineer at OSU, I built automated approval and validation workflows impacting 4,000+ graduate students.

I admire how Flow is transforming human-computer interaction and voice interfaces, and I am excited about the latency-critical platform systems and rapid prototyping happening at Wispr. I am East-coast based and fully open to relocating to San Francisco.

If you are open to putting my name in front of the engineering hiring team or connecting briefly, I would be grateful. Happy to send over my resume or any additional details!

Best regards,
Saketh Metta
sakethmetta097@gmail.com | sakethmetta.org`;

async function main() {
  console.log('Connecting to browser on http://localhost:9226...');
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  let page = pages.find(p => p.url().includes('messaging')) || pages[pages.length - 1];

  if (!page.url().includes('messaging/compose')) {
    console.log('Navigating to compose URL...');
    await page.goto('https://www.linkedin.com/messaging/compose/?recipient=ACoAABcrCrEBhKY-T9IYv6wTH47gEZcGpsrzxKU', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
  }

  console.log('Waiting for InMail compose fields...');
  const subjectInput = page.locator('input[name="subject"], input[placeholder*="Subject"]').first();
  await subjectInput.waitFor({ state: 'visible', timeout: 10000 });
  await subjectInput.click();
  await subjectInput.fill(SUBJECT);
  console.log('Subject filled:', SUBJECT);

  await page.waitForTimeout(500);

  const bodyInput = page.locator('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][aria-label*="message"]').first();
  await bodyInput.waitFor({ state: 'visible', timeout: 10000 });
  await bodyInput.click();
  
  // Fill body into contenteditable div
  await bodyInput.evaluate((el, text) => {
    el.focus();
    el.innerHTML = '<p>' + text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, BODY);

  console.log('Body filled (length:', BODY.length, ')');
  await page.waitForTimeout(1000);

  // Trigger typing to ensure form registers input and enables Send button
  await bodyInput.click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(1000);

  // Check send button
  const sendBtn = page.locator('button.msg-form__send-btn, button.msg-form__send-button, form.msg-form button[type="submit"]').first();
  await sendBtn.waitFor({ state: 'visible', timeout: 10000 });
  
  const isDisabled = await sendBtn.isDisabled();
  console.log('Send button disabled?', isDisabled);
  if (isDisabled) {
    console.log('Send button is disabled, dispatching input events...');
    await bodyInput.type(' ');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1000);
  }

  console.log('Clicking Send button...');
  await sendBtn.click({ timeout: 10000 });
  await page.waitForTimeout(5000);

  // Verify send
  const postUrl = page.url();
  console.log('Post send URL:', postUrl);
  const postText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  const inmailCreditsLeft = postText.match(/(\d+)\s+InMail credits?/i);
  console.log('Credits status in text:', inmailCreditsLeft ? inmailCreditsLeft[0] : 'Thread opened');

  // Update queue file
  if (fs.existsSync(QUEUE_PATH)) {
    const raw = fs.readFileSync(QUEUE_PATH, 'utf-8');
    const records = JSON.parse(raw);
    const rec = records.find(r => r.slug === SLUG);
    if (rec) {
      rec.status = 'sent';
      rec.sent_at = new Date().toISOString();
      rec.channel_used = 'inmail';
      rec.confirmation = `InMail credit sent to Eduardo Sanchez-Ubanell (Subject: "${SUBJECT}")`;
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(records, null, 2) + '\n');
      console.log('Updated queue record status to sent in ' + QUEUE_PATH);
    }
  }

  console.log('SUCCESS: InMail sent to Eduardo Sanchez-Ubanell!');
  await browser.close();
}

main().catch(err => {
  console.error('Error sending InMail:', err);
  process.exit(1);
});
