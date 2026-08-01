/**
 * check_anthony_scope_overlap.js
 * Fetches base and superbase production_new records for Anthony and checks
 * whether policy_hidden values overlap between the two scopes — resolves
 * whether BSCpro's superbase scope is exclusive-of-base (like Olivia's,
 * confirmed by non-overlap) or actually cumulative (base ⊆ superbase) for
 * Anthony, since record counts alone (1236 > 714) don't prove it either way.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

const ANTHONY_BSCPRO_LOGIN_AS_URL = 'https://bscpro.com/auth/login_as_authorized_user/3997';

async function login(page) {
  await page.goto('https://bscpro.com/auth/login');
  await page.waitForSelector('#login');
  await page.fill('#login', process.env.BSCPRO_EMAIL_BRILYNN);
  await page.fill('#password', process.env.BSCPRO_PASSWORD_BRILYNN);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
  await page.goto(ANTHONY_BSCPRO_LOGIN_AS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
}

async function setScope(page, scopeValues) {
  await page.evaluate((scopeValues) => {
    const sel = document.getElementById('scope_filter');
    if (!sel) return false;
    Array.from(sel.options).forEach(o => { o.selected = scopeValues.includes(o.value); });
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const $ = window.jQuery || window.$;
    if ($ && $.fn && $.fn.selectpicker) $(sel).selectpicker('refresh');
    return true;
  }, scopeValues);
  await page.waitForTimeout(6000);
}

async function fetchProductionRecords(page, endDateStr) {
  return await page.evaluate(async (endDate) => {
    const payload = {
      limit: 5000, offset: 0, type: 'written_date',
      startDate: '1 Jan 2024', endDate,
      mentions_noti_product_id: '', selected_country: 'country_all',
    };
    const resp = await fetch('/production_new/getajaxdata', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: 'request=' + encodeURIComponent(JSON.stringify(payload)),
    });
    const data = await resp.json();
    return data.records || [];
  }, endDateStr);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  try {
    await login(page);
    await page.goto('https://bscpro.com/production_new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const now = new Date();
    const MON_SHORT = now.toLocaleDateString('en-US', { month: 'short' });
    const todayStr = now.getDate() + ' ' + MON_SHORT + ' ' + now.getFullYear();

    await setScope(page, ['base']);
    const baseRecords = await fetchProductionRecords(page, todayStr);
    await setScope(page, ['superbase']);
    const superbaseRecords = await fetchProductionRecords(page, todayStr);

    const key = r => (r.policy_hidden || '').trim() || `${r.client_name}|${r.product_name}|${r.product_date}`;
    const baseKeys = new Set(baseRecords.map(key));
    const superbaseKeys = new Set(superbaseRecords.map(key));

    let overlap = 0;
    for (const k of baseKeys) if (superbaseKeys.has(k)) overlap++;

    console.log('Base record count:', baseRecords.length);
    console.log('Superbase record count:', superbaseRecords.length);
    console.log('Overlap count (same policy/record key in both):', overlap);
    console.log('Base ⊆ Superbase (fully cumulative)?', overlap === baseKeys.size);
    console.log('Exclusive (zero overlap)?', overlap === 0);
    console.log('CHECK_COMPLETE');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
