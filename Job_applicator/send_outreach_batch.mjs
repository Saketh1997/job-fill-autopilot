import { chromium } from 'playwright';
import fs from 'fs';

const QUEUE_PATH = '/home/hunter/projects/career-ops/data/linkedin-outreach-queue.json';
const CDP = process.env.CDP_ENDPOINT || 'http://localhost:9226';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendConnect(page, profileUrl, contactName, message) {
  console.log(`\n========================================`);
  console.log(`Navigating to ${contactName}: ${profileUrl}`);
  console.log(`Message (${message.length} chars): ${message}`);
  
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  // Check if already connected or pending
  const pageText = await page.evaluate(() => document.body.innerText);
  if (pageText.includes('Pending') && !pageText.includes('Connect')) {
    console.log(`Already has pending invitation to ${contactName}.`);
    return { success: true, note: 'Already pending' };
  }

  // 1. Try to find Connect button directly
  let connectFound = false;

  const directConnect = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      const text = (b.innerText || '').trim();
      const aria = b.getAttribute('aria-label') || '';
      const inMainCard = b.closest('section') || b.closest('.artdeco-card') || b.closest('main');
      if (inMainCard && (text === 'Connect' || (aria.startsWith('Invite') && aria.includes('to connect')))) {
        const rect = b.getBoundingClientRect();
        if (rect.top < 600 && rect.top > 0) {
          b.click();
          return { clicked: true, text, aria, top: rect.top };
        }
      }
    }
    return { clicked: false };
  });

  if (directConnect.clicked) {
    console.log(`Clicked direct Connect button (top=${directConnect.top}, text="${directConnect.text}")`);
    connectFound = true;
  } else {
    console.log('Direct Connect not in top card, looking for "More" button...');
    const moreClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const text = (b.innerText || '').trim();
        const aria = b.getAttribute('aria-label') || '';
        if (text === 'More' || aria === 'More actions') {
          const rect = b.getBoundingClientRect();
          if (rect.top < 600 && rect.top > 0) {
            b.click();
            return { clicked: true, top: rect.top };
          }
        }
      }
      return { clicked: false };
    });

    if (moreClicked.clicked) {
      console.log(`Clicked "More" button (top=${moreClicked.top}), waiting for dropdown...`);
      await sleep(1500);

      const dropdownConnect = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('div[role="dialog"] *, ul *, div.artdeco-dropdown__content *'));
        for (const el of items) {
          const text = (el.innerText || '').trim();
          const aria = el.getAttribute('aria-label') || '';
          if (text === 'Connect' || (aria.includes('Invite') && aria.includes('to connect'))) {
            el.click();
            return { clicked: true, text };
          }
        }
        const allSpans = Array.from(document.querySelectorAll('span, button, div'));
        for (const el of allSpans) {
          if (el.innerText?.trim() === 'Connect' && el.offsetParent !== null) {
            el.click();
            return { clicked: true, text: 'Connect (visible span)' };
          }
        }
        return { clicked: false };
      });

      if (dropdownConnect.clicked) {
        console.log(`Clicked Connect from dropdown! (${dropdownConnect.text})`);
        connectFound = true;
      }
    }
  }

  if (!connectFound) {
    console.log('Could not find or click Connect button.');
    return { success: false, error: 'Connect button not found' };
  }

  await sleep(2000);

  // 2. Look for "Add a note" button in the connection modal
  console.log('Looking for "Add a note" in modal...');
  const addNoteClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const text = (b.innerText || '').trim();
      const aria = b.getAttribute('aria-label') || '';
      if (text.includes('Add a note') || aria.includes('Add a note')) {
        b.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  if (addNoteClicked.clicked) {
    console.log(`Clicked "Add a note" (${addNoteClicked.text})`);
    await sleep(1000);
  } else {
    console.log('"Add a note" button not seen; checking if textarea already exists...');
  }

  // 3. Fill the note textarea
  const typed = await page.evaluate((msg) => {
    const textarea = document.querySelector('textarea#custom-message, textarea[name="message"], .send-invite textarea, textarea');
    if (textarea && textarea.offsetParent !== null) {
      textarea.focus();
      textarea.value = msg;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true, valLength: textarea.value.length };
    }
    return { typed: false };
  }, message);

  if (!typed.typed) {
    console.log('Could not find textarea to enter message.');
    return { success: false, error: 'Textarea not found' };
  }

  console.log(`Successfully entered note (${typed.valLength} chars)`);
  await sleep(1500);

  // 4. Click Send button in modal
  console.log('Looking for Send button in modal...');
  const sent = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const text = (b.innerText || '').trim();
      const aria = b.getAttribute('aria-label') || '';
      if ((text === 'Send' || text === 'Send invitation' || aria === 'Send invitation' || aria === 'Send now') && b.offsetParent !== null && !b.disabled) {
        b.click();
        return { clicked: true, text, aria };
      }
    }
    return { clicked: false };
  });

  if (!sent.clicked) {
    console.log('Send button not clickable.');
    return { success: false, error: 'Send button not found or disabled' };
  }

  console.log(`Clicked Send button! (${sent.text || sent.aria})`);
  await sleep(3000);

  return { success: true, note: 'Invitation sent with note' };
}

async function main() {
  console.log('Reading outreach queue from', QUEUE_PATH);
  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));

  const targets = queue.filter(q => {
    return q.status !== 'sent' && q.message && q.contact_profile_url;
  });

  console.log(`Found ${targets.length} targets to process.`);
  if (targets.length === 0) {
    console.log('No pending outreach targets.');
    return;
  }

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = (await ctx.pages())[0] || await ctx.newPage();

  let sentCount = 0;
  const contactedUrls = new Set();

  for (const item of targets) {
    const { slug, company, role, contact_name, contact_profile_url, message } = item;

    if (contactedUrls.has(contact_profile_url)) {
      console.log(`Skipping duplicate contact URL: ${contact_profile_url} (${contact_name})`);
      item.status = 'sent';
      item.sent_at = new Date().toISOString();
      item.confirmation = `Deduped against previous send to ${contact_name}`;
      continue;
    }

    try {
      const result = await sendConnect(page, contact_profile_url, contact_name, message);
      if (result.success) {
        item.status = 'sent';
        item.sent_at = new Date().toISOString();
        item.confirmation = `Sent connection note: "${message.slice(0, 60)}..."`;
        contactedUrls.add(contact_profile_url);
        sentCount++;
        console.log(`-> SUCCESS for ${company} (${contact_name})`);
      } else {
        item.status = 'failed';
        item.error = result.error;
        console.log(`-> FAILED for ${company} (${contact_name}): ${result.error}`);
      }
    } catch (err) {
      console.error(`Error processing ${company} (${contact_name}):`, err.message);
      item.status = 'failed';
      item.error = err.message;
    }

    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
    console.log('Saved updated queue file.');
    await sleep(6000); // 6s polite rate-limit delay between LinkedIn requests
  }

  console.log(`\n========================================`);
  console.log(`Batch complete! Sent ${sentCount} outreach messages.`);
}

main().catch(console.error);
