require('dotenv').config();
const { chromium } = require('playwright');
const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = '1F5ntZXHa4eg1dKf0XR_9yClmeoZOpAW8_zm1GeJaEEY';
const CREDS_PATH = 'C:\\Users\\Mouth\\mcp-servers\\google-sheets\\credentials.json';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function writeToSheet(sheets, tabName, headers, records) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const rows = records.map(r => [...Object.values(r), now]);

  // Clear existing data (keep header row)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A2:Z`,
  });

  if (rows.length === 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  console.log(`  Wrote ${rows.length} rows to ${tabName}`);
}

async function login(page) {
  await page.goto('https://bscpro.com/auth/login');
  await page.waitForSelector('#login');
  await page.fill('#login', process.env.BSCPRO_EMAIL_OLIVIA);
  await page.fill('#password', process.env.BSCPRO_PASSWORD_OLIVIA);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 15000 });
}

async function loadAllRecords(page) {
  // Click "Load More" until it disappears
  let moreCount = 0;
  while (true) {
    const loadMore = await page.$('.w2ui-load-more:not([style*="display: none"])');
    if (!loadMore) break;
    const text = await loadMore.innerText().catch(() => '');
    if (!text.trim()) break;
    await loadMore.click();
    await page.waitForTimeout(2000);
    if (++moreCount > 50) break; // safety cap
  }
}

async function waitForGrid(page, minRecords = 1, timeout = 20000) {
  await page.waitForFunction((min) => {
    return typeof w2ui !== 'undefined' &&
           w2ui['grid'] &&
           w2ui['grid'].records &&
           w2ui['grid'].records.length >= min;
  }, minRecords, { timeout });
}

async function expandGridLimit(page) {
  // Bump the w2ui limit and reload to get all records
  const count = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const grid = w2ui['grid'];
      if (!grid) return reject('no grid');
      const original = grid.limit;
      grid.limit = 2000;
      const onLoad = () => {
        grid.off('load', onLoad);
        resolve(grid.records.length);
      };
      grid.on('load', onLoad);
      grid.reload();
      // Safety timeout
      setTimeout(() => { grid.off('load', onLoad); resolve(grid.records.length); }, 15000);
    });
  });
  console.log(`  After limit expansion: ${count} records`);
  return count;
}

async function scrapeRecruitTracker(page) {
  console.log('Scraping Recruit Tracker...');
  await page.goto('https://bscpro.com/speedfilter_new');
  await page.waitForLoadState('domcontentloaded');

  // Wait for initial grid load
  await waitForGrid(page);

  // Click the daterange input to open picker, then click "All" preset
  await page.click('input.speedfilter_daterange');
  await page.waitForTimeout(800);
  await page.click('li[data-range-key="All"]');

  // Wait until record count exceeds the initial current-month results
  await page.waitForFunction(() => {
    return typeof w2ui !== 'undefined' && w2ui['grid'] && w2ui['grid'].records.length > 22;
  }, { timeout: 30000 }).catch(() => console.log('  Warn: grid count did not increase past 22'));

  // Now expand limit to load all records
  await expandGridLimit(page);

  const records = await page.evaluate(() => {
    const grid = w2ui['grid'];
    if (!grid || !grid.records) return [];
    return grid.records.map(r => ({
      recid: r.recid,
      rec_lic_id: r.rec_lic_id,
      name: r.name?.trim(),
      code: r.code,
      email: r.email,
      contact: r.contact,
      state: r.state_val,
      country_state: r.country_state,
      start_date: r.start_date,
      recruiter: r.recruiter,
      field_trainer: (() => {
        const ft = r.field_trainer;
        if (!ft) return '';
        if (Array.isArray(ft)) return ft.join(', ');
        if (typeof ft === 'object') return ft.name || '';
        return String(ft);
      })(),
      team_leader: (() => {
        const tl = r.custom_field?.['107697']?.field_data;
        if (!tl) return '';
        if (Array.isArray(tl)) return tl.join(', ');
        if (typeof tl === 'object') return tl.name || '';
        return String(tl);
      })(),
      trainer: (() => {
        const t = r.custom_field?.['107627']?.field_data;
        if (!t) return '';
        if (Array.isArray(t)) return t.join(', ');
        if (typeof t === 'object') return Object.values(t).filter(Boolean)[0] || '';
        return String(t);
      })(),
      gx_level: (() => { const g = r.custom_field?.['108366']?.field_data; return Array.isArray(g) ? g.join(', ') : (g || ''); })(),
      recruit_tag: Array.isArray(r.recruit_tag) ? r.recruit_tag.join(', ') : (r.recruit_tag || ''),
      notes: r.notes || '',
      pre_license_date: r.custom_field?.['134']?.field_data || '',
      test_date_fl: r.custom_field?.['138']?.field_data || '',
      test_date_ny: r.custom_field?.['142']?.field_data || '',
      field_appt_1: r.custom_field?.['107699']?.field_data || '',
      field_appt_2: r.custom_field?.['107700']?.field_data || '',
      field_appt_3: r.custom_field?.['107701']?.field_data || '',
      biz_plan: r.custom_field?.['108256']?.field_data || 0,
      fast_start_school: r.custom_field?.['108258']?.field_data || '',
      birthday: r.custom_field?.['108360']?.field_data || '',
      highlight: r.highlight,
      completed_at: r.completed_at,
      level_code: r.level_code,
      is_active: r.is_active,
    }));
  });

  console.log(`  Found ${records.length} recruits`);
  return records;
}

async function scrapeLicensingTracker(page) {
  console.log('Scraping Licensing Tracker...');
  await page.goto('https://bscpro.com/licensing');
  await page.waitForLoadState('domcontentloaded');

  // Wait for grid then expand scope
  try {
    await waitForGrid(page, 10000);
    console.log('  Grid loaded. Setting scope to Super Team...');
    await page.selectOption('select[name="scope_filter[]"]', ['Base', 'Super Base', 'Super Team']);
    await page.waitForTimeout(4000);
    console.log('  Grid loaded.');
  } catch (e) {
    console.log('  Grid wait timed out, using DOM fallback...');
    await page.waitForTimeout(5000);
  }

  const records = await page.evaluate(() => {
    const grid = w2ui['grid'];
    if (!grid || !grid.records || grid.records.length === 0) {
      // Fallback: scrape visible rows from DOM
      const rows = Array.from(document.querySelectorAll('tr[id^="grid_grid_frec_"]:not(#grid_grid_frec_top):not(#grid_grid_frec_bottom):not(#grid_grid_frec_more)'));
      return rows.map(row => {
        const nameEl = row.querySelector('.lic_track_link');
        const phoneEl = row.querySelector('.copy_prospect_phone');
        const emailEl = row.querySelector('.copy_prospect_email');
        return {
          name: nameEl?.getAttribute('title')?.trim() || nameEl?.innerText?.trim(),
          contact: phoneEl?.getAttribute('data-clipboard-text'),
          email: emailEl?.getAttribute('data-clipboard-text'),
          row_id: row.id,
        };
      });
    }
    return grid.records.map(r => ({
      recid: r.recid,
      name: r.name?.trim(),
      code: r.code,
      email: r.email,
      contact: r.contact,
      state: r.state_val,
      start_date: r.start_date,
      code_expiry_date: r.code_expiry_date,
      recruiter: r.recruiter,
      field_trainer: r.field_trainer,
      status: r.status,
      notes: r.notes,
      highlight: r.highlight,
    }));
  });

  console.log(`  Found ${records.length} licensing records`);
  return records;
}

(async () => {
  if (!fs.existsSync('data')) fs.mkdirSync('data');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });

  try {
    console.log('Logging in...');
    await login(page);
    console.log('Logged in.\n');

    const recruits = await scrapeRecruitTracker(page);
    fs.writeFileSync('data/recruits.json', JSON.stringify(recruits, null, 2));
    console.log(`  Scraped ${recruits.length} recruits\n`);

    const licensing = await scrapeLicensingTracker(page);
    fs.writeFileSync('data/licensing.json', JSON.stringify(licensing, null, 2));
    console.log(`  Scraped ${licensing.length} licensing records\n`);

    // Write to Google Sheet
    console.log('Syncing to Google Sheet...');
    const sheets = await getSheetsClient();
    await writeToSheet(sheets, 'Recruit Tracker', null, recruits);
    await writeToSheet(sheets, 'Licensing Tracker', null, licensing);

    console.log('\n=== SUMMARY ===');
    console.log(`Recruits synced: ${recruits.length}`);
    console.log(`Licensing records synced: ${licensing.length}`);
    console.log(`Sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
    console.log('\nDone!');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
