import { chromium } from 'playwright';
import fs from 'fs';

const QUEUE_PATH = '/home/hunter/projects/career-ops/data/linkedin-outreach-queue.json';
const CDP = process.env.CDP_ENDPOINT || 'http://localhost:9226';

function extractVanityName(url) {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  return match ? match[1] : null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendOutreach(page, vanityName, contactName, message) {
  console.log(`\n----------------------------------------`);
  console.log(`Sending to ${contactName} (vanity: ${vanityName})`);
  console.log(`Message (${message.length} chars): ${message}`);

  const inviteUrl = `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(vanityName)}`;
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await sleep(3500);

  // Check page text
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check if already invited or already connected
  if (bodyText.includes('Pending') || bodyText.includes('already connected') || bodyText.includes('Remove connection')) {
    console.log(`Already connected or invitation already pending for ${contactName}.`);
    return { success: true, note: 'Already connected or pending' };
  }

  // 1. Click "Add a note" button
  console.log('Looking for "Add a note" button...');
  const addNoteBtn = page.locator('button:has-text("Add a note"), [aria-label*="Add a note"]').first();
  try {
    await addNoteBtn.waitFor({ state: 'visible', timeout: 6000 });
    await addNoteBtn.click();
    console.log('Clicked "Add a note"');
  } catch (e) {
    console.log('"Add a note" button not found or already open, checking textarea...');
  }
  await sleep(1000);

  // 2. Find textarea and enter message
  console.log('Looking for note textarea...');
  const textarea = page.locator('textarea#custom-message, textarea[name="message"], div[role="dialog"] textarea, textarea').first();
  try {
    await textarea.waitFor({ state: 'visible', timeout: 6000 });
    await textarea.fill(message);
    console.log(`Filled message (${message.length} chars)`);
  } catch (e) {
    console.log('Error finding/filling textarea:', e.message);
    return { success: false, error: 'Textarea not found' };
  }
  await sleep(1500);

  // 3. Click Send button
  console.log('Looking for Send button...');
  const sendBtn = page.locator('button:has-text("Send"), button[aria-label*="Send invitation"], button[aria-label*="Send now"]').first();
  try {
    await sendBtn.waitFor({ state: 'visible', timeout: 6000 });
    const disabled = await sendBtn.isDisabled();
    if (disabled) {
      console.log('Send button disabled, retrying textarea input...');
      await textarea.type(' ');
      await page.keyboard.press('Backspace');
      await sleep(1000);
    }
    await sendBtn.click();
    console.log('Clicked Send button!');
  } catch (e) {
    console.log('Error clicking Send button:', e.message);
    return { success: false, error: 'Send button not found or disabled' };
  }

  await sleep(4000);
  return { success: true, note: 'Invitation sent with note' };
}

async function main() {
  console.log('Reading queue from:', QUEUE_PATH);
  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  const page = (await ctx.pages())[0] || await ctx.newPage();

  let sentCount = 0;
  const processedUrls = new Set();

  for (const item of queue) {
    const { slug, company, role, contact_name, contact_profile_url, message, status } = item;

    // Skip if marked do not send or withdrawn
    if (item.do_not_send || status === 'withdrawn') {
      continue;
    }

    // Skip if already marked sent
    if (status === 'sent' && item.sent_at) {
      continue;
    }

    if (!message || !contact_profile_url) {
      continue;
    }

    const vanity = extractVanityName(contact_profile_url);
    if (!vanity) {
      console.log(`Skipping invalid LinkedIn URL: ${contact_profile_url}`);
      continue;
    }

    if (processedUrls.has(vanity)) {
      console.log(`Duplicate vanity in batch: ${vanity} (${contact_name}), marking sent...`);
      item.status = 'sent';
      item.sent_at = new Date().toISOString();
      item.confirmation = `Deduped against send to ${contact_name}`;
      continue;
    }

    try {
      const res = await sendOutreach(page, vanity, contact_name, message);
      if (res.success) {
        item.status = 'sent';
        item.sent_at = new Date().toISOString();
        item.confirmation = `Sent connection note: "${message.slice(0, 60)}..." (${res.note || 'sent'})`;
        processedUrls.add(vanity);
        sentCount++;
        console.log(`==> SUCCESS for ${company} (${contact_name})`);
      } else {
        item.status = 'failed';
        item.error = res.error;
        console.log(`==> FAILED for ${company} (${contact_name}): ${res.error}`);
      }
    } catch (err) {
      console.error(`Error with ${company} (${contact_name}):`, err.message);
      item.status = 'failed';
      item.error = err.message;
    }

    // Save after each item
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
    console.log('Updated queue file.');
    await sleep(6000); // 6s pause between invites
  }

  console.log(`\n========================================`);
  console.log(`Batch complete! Successfully sent ${sentCount} connection notes.`);
}

main().catch(console.error);
