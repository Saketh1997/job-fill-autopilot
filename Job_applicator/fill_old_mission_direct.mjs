import { chromium } from 'playwright';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  const browser = await chromium.connectOverCDP('http://localhost:9226');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('oldmission'));
  if (!page) {
    console.error('Old Mission page not found!');
    return;
  }
  const frame = page.frames().find(f => f.url().includes('job_app') || f.url().includes('greenhouse'));
  if (!frame) {
    console.error('Greenhouse frame not found!');
    return;
  }
  console.log('Found frame:', frame.url());

  // Let's list all inputs and react-selects
  const fields = await frame.$$('.field, [class*="field"], [role="group"]');
  console.log('Total field containers:', fields.length);

  for (const field of fields) {
    const labelEl = await field.$('label, .label, legend');
    const label = labelEl ? (await labelEl.innerText()).trim() : '';
    if (!label) continue;
    console.log('\n--- FIELD:', label);

    const l = label.toLowerCase();
    if (l.includes('start date year')) {
      const inp = await field.$('input');
      if (inp) {
        await inp.fill('');
        await inp.type('2023');
        console.log('  Filled start date year: 2023');
      }
    } else if (l.includes('end date year')) {
      const inp = await field.$('input');
      if (inp) {
        await inp.fill('');
        await inp.type('2026');
        console.log('  Filled end date year: 2026');
      }
    } else if (l.includes('.edu email')) {
      const inp = await field.$('input');
      if (inp) {
        await inp.fill('sakethmetta097@gmail.com');
        console.log('  Filled .edu email: sakethmetta097@gmail.com');
      }
    } else if (l.includes('school')) {
      await selectReactSelect(frame, field, 'Oregon State University');
    } else if (l.includes('degree')) {
      await selectReactSelect(frame, field, "Master's Degree");
    } else if (l.includes('discipline')) {
      await selectReactSelect(frame, field, 'Computer Science');
    } else if (l.includes('how did you hear')) {
      await selectReactSelect(frame, field, 'Company Website', ['Careers Site', 'Job Board', 'LinkedIn', 'Other']);
    } else if (l.includes('country') && field.toString().includes('phone')) {
      // intl-tel country
      await selectReactSelect(frame, field, 'United States');
    }
  }

  console.log('\n=== Old Mission Fill Done ===');
}

async function selectReactSelect(frame, container, targetOption, fallbacks = []) {
  try {
    const control = await container.$('.select__control, [class*="-control"]');
    if (!control) {
      console.log('  No react-select control found');
      return;
    }
    console.log(`  Clicking control for option: ${targetOption}`);
    await control.click();
    await sleep(500);

    const input = await container.$('input');
    if (input) {
      console.log(`  Typing query: ${targetOption}`);
      await input.fill(targetOption);
      await sleep(500);
    }

    const options = await frame.$$('[id^="react-select-"][id*="-option-"], .select__option, [class*="-option"]');
    console.log(`  Found ${options.length} options matching query`);
    if (options.length > 0) {
      const txt = (await options[0].innerText()).trim();
      console.log(`  Clicking option: "${txt}"`);
      await options[0].click();
      await sleep(300);
      return;
    }

    if (fallbacks.length > 0) {
      for (const fb of fallbacks) {
        if (input) {
          await input.fill(fb);
          await sleep(500);
          const fbOptions = await frame.$$('[id^="react-select-"][id*="-option-"], .select__option, [class*="-option"]');
          if (fbOptions.length > 0) {
            const txt = (await fbOptions[0].innerText()).trim();
            console.log(`  Clicking fallback option: "${txt}"`);
            await fbOptions[0].click();
            await sleep(300);
            return;
          }
        }
      }
    }

    await frame.keyboard.press('Escape').catch(() => {});
  } catch (e) {
    console.error('  Error in selectReactSelect:', e.message);
  }
}

run().catch(console.error);
