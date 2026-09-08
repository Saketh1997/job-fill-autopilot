#!/usr/bin/env node
/**
 * audit_thread.mjs <profileUrl> <contactName> -- read ONE person's thread with
 * certainty, by opening their overlay from their profile and scoping every read
 * to that overlay's own bubble. Clicking a name in the inbox list is not
 * reliable (it silently leaves the previous conversation selected), which is how
 * two earlier checks reported one thread's contents under both names.
 */
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BOX = '.msg-form__contenteditable [role="textbox"], .msg-form__contenteditable, div.msg-form__contenteditable[contenteditable="true"], form.msg-form div[role="textbox"][contenteditable="true"]';
const [url, name] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT||'http://localhost:9226');
const page = await browser.contexts()[0].newPage();
await page.goto(url, {waitUntil:'domcontentloaded', timeout:45000});
await sleep(4500);
await page.evaluate(() => {
  for (const el of document.querySelectorAll('main button, main a, main [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (!(r.width>0 && r.y>80 && r.y<800)) continue;
    const t=(el.innerText||'').trim().toLowerCase(), a=(el.getAttribute('aria-label')||'').toLowerCase();
    if (a.includes('messaging')||t.includes('messaging')) continue;
    if (t==='message'||a.startsWith('message ')) { el.click(); return; }
  }
});
await sleep(5000);
const want = name.toLowerCase();
let target = null;
for (const b of await page.$$(BOX)) {
  const bb = await b.boundingBox(); if (!bb || !bb.width) continue;
  const info = await b.evaluate((el) => {
    let bub = el;
    for (let i=0;i<15 && bub.parentElement;i++){ bub=bub.parentElement;
      if(/msg-overlay-conversation-bubble|msg-convo-wrapper|msg-overlay-container/.test((bub.className||'').toString())) break; }
    const names=new Set();
    bub.querySelectorAll('[aria-label*="conversation with"], .msg-form__upload-attachment').forEach(n=>{
      const m=((n.innerText||'')+' '+(n.getAttribute('aria-label')||'')).match(/conversation with ([^\n]+?)\s*$/im);
      if(m) names.add(m[1].trim());
    });
    const evs=[...bub.querySelectorAll('.msg-s-event-listitem')].slice(-4).map(li=>({
      text:(li.innerText||'').replace(/\s+/g,' ').trim().slice(0,150),
      fileish:[...li.querySelectorAll('*')].filter(n=>{
        const c=(n.className||'').toString();
        return /attachment|file-card|ambry|document/i.test(c) && !/profile|picture|photo/i.test(c);
      }).map(n=>({cls:(n.className||'').toString().slice(0,70), t:(n.innerText||'').trim().slice(0,60)})),
    }));
    return { names:[...names], evs };
  });
  if (info.names.some(n=>n.toLowerCase().includes(want))) { target = info; break; }
}
if (!target) { console.log('NO BUBBLE FOR', name); process.exit(1); }
console.log(`=== ${name} === bubble names: ${JSON.stringify(target.names)}`);
target.evs.forEach(e => {
  console.log(`\n  MSG: ${e.text}`);
  console.log(`  attachment elements: ${e.fileish.length ? JSON.stringify(e.fileish) : 'NONE'}`);
});
await page.close(); process.exit(0);
