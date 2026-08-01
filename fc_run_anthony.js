/**
 * fc_run_anthony.js
 * Weekly-recurring "FC Run" point total for Anthony Augugliaro, for Jamie
 * Villalovos (Team Revolution leadership) — progress toward Field Chairman
 * promotion. Same formula/methodology as fc_run_jamie.js (built for Olivia
 * Sula-Wang); duplicated here for Anthony per Brilynn's request 2026-08-01.
 *
 * Running Total = Current WFG Points + Pending Points - Pending Chargebacks
 *   Pending Points = (life apps with a 1st-advance transaction paid today/yesterday * 40%)
 *                   + (life apps with a 2nd-advance transaction paid today/yesterday * 60%)
 *   Confirmed against BSCpro's production tracker "Advances" column (1st/2nd date +
 *   checkbox boxes) and the underlying points_detail transaction log: a `first_adv`
 *   transaction releases exactly 40% of a record's points, a `second_adv` transaction
 *   releases the remaining 60%. Tracked via top-level fields `first_adv` (1st advance
 *   date) and `paid_2_date` (2nd advance date). Points value = `actual_point` (the
 *   "Base Points" column left of Advances in the tracker) — NOT `base_written_points`,
 *   which applies a per-agent attribution split and produces decimals.
 *
 * Run weekly (Fridays). Usage: node fc_run_anthony.js
 *
 * ACCESS NOTES (specific to Anthony — different from fc_run_jamie.js):
 *  - BSCpro: Anthony has no separate direct BSCpro login here. Access goes
 *    through Brilynn's own BSCpro account (BSCPRO_EMAIL_BRILYNN/PASSWORD_BRILYNN
 *    in .env), then a "Log In As" switch via the authorized-user link
 *    https://bscpro.com/auth/login_as_authorized_user/3997 (Anthony's BSCpro
 *    user_id — found under Brilynn's profile dropdown > "Log In As").
 *  - mywfg.com: Anthony logs in directly with his own credentials
 *    (MYWFG_USERNAME_ANTHONY=53NUO / MYWFG_PASSWORD_ANTHONY in .env) — unlike
 *    Olivia's login flow, do NOT check the "I'm an agent assistant" checkbox,
 *    since this is a direct account login, not a delegated one. Uses its own
 *    persistent browser profile (mywfg_profile_anthony/) separate from
 *    Olivia's, so trusted-device cookies don't collide.
 *  - Net Points report AgentID = 53NUO (matches his mywfg username, same
 *    pattern as Olivia's 19RSI).
 *
 * KNOWN LIMITATIONS (read before trusting output):
 *  1. This is the FIRST automated run for Anthony's mywfg login — the
 *     persistent profile has no "Remember This Device" cookie yet, so an OTP
 *     challenge on the first run is likely. This script will report FAILED
 *     rather than hang if that happens; a manual headed login (not yet built
 *     for Anthony — copy scrape_mywfg_production.js's pattern if needed) would
 *     be required once to clear it and seed mywfg_profile_anthony/.
 *  2. Pending and issued buckets are restricted to RECENT_WINDOW_DAYS (today or
 *     yesterday), computed dynamically from the moment the script runs. Same
 *     rationale as fc_run_jamie.js: closes the gap versus mywfg's ~1-2 day
 *     snapshot lag, avoiding double-counting against Current WFG Points. A
 *     record can land in BOTH buckets if its 1st and 2nd advances both landed
 *     inside the window.
 *  3. Flanking: per Brilynn 2026-08-01, Anthony is confirmed NOT flanked by
 *     anyone, so no adjustment is applied — same as Olivia. If that ever
 *     changes, this script would need a manual flanking adjustment layered on
 *     top, same as fc_run_jamie.js would.
 *  4. Trial-app detection: BSCpro doesn't have a clean trial-app flag; this
 *     script regex-matches product_name/product_description/notes for "trial"
 *     language. If nothing matches, that means no trial apps were FOUND BY
 *     TEXT MATCH, not that none exist — flagged in output.
 *  5. "SuperTeam equals SuperBase" was confirmed true for Olivia (no separate
 *     SuperTeam population) but has NOT been verified for Anthony — his
 *     superteam figure is reported as-is from mywfg without that assumption.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'fc_run_anthony_latest.json');
const RECENT_WINDOW_DAYS = 1;       // pending/issued buckets only count records dated today (0) or yesterday (1) — dynamic, relative to NOW below.
const ANTHONY_BSCPRO_LOGIN_AS_URL = 'https://bscpro.com/auth/login_as_authorized_user/3997';

const NOW = new Date();
const YEAR = NOW.getFullYear();
const MONTH_1 = NOW.getMonth() + 1;
const pad2 = n => String(n).padStart(2, '0');
const MONTH_YM = `${YEAR}-${pad2(MONTH_1)}`;
const MON_SHORT = NOW.toLocaleDateString('en-US', { month: 'short' });

function detectProductType(productName) {
  if (!productName) return 'Unknown';
  const n = productName.toLowerCase();
  if (/iul|index.*univ|indexed.*life/.test(n)) return 'IUL';
  if (/final.expense|effortless|fe\b|burial|guaranteed.*univ|gul/.test(n)) return 'FE/GUL';
  if (/whole.life|wl\b/.test(n)) return 'WL';
  if (/annuity|fia\b/.test(n)) return 'Annuity';
  if (/term/.test(n)) return 'Term';
  if (/disability|ltd\b|std\b/.test(n)) return 'Disability';
  return 'Other';
}

function isTrialApp(rec) {
  const hay = [rec.product_name || '', rec.product_description || '', rec.note || ''].join(' ').toLowerCase();
  return /\btrial\b|\btemp(orary)? (app|application|policy)\b/.test(hay);
}

// See fc_run_jamie.js for full rationale on these two regexes — duplicated
// here verbatim since the product-line/carrier-naming quirks apply to any
// agent's book of business, not just Olivia's.
const UNAMBIGUOUS_ANNUITY_RE = /foreaccumulation|secure horizon|performance elite|ascent (pro|elite)|max ?rate|new heights|safe income|power accum(u)?lat|index adv(antage)?\b/i;
const AMBIGUOUS_ANNUITY_RE = /accum(u)?lat/i;

function isLikelyAnnuityByProductLine(productName, productType) {
  if (!productName) return false;
  if (UNAMBIGUOUS_ANNUITY_RE.test(productName)) return true;
  if ((productType === 'Other' || productType === 'Unknown') && AMBIGUOUS_ANNUITY_RE.test(productName)) {
    // Nationwide's "Accumulator" line (Accumulator II/III, IUL Accumulator) is a
    // real IUL/life product, not an annuity — Nationwide's annuity brand is
    // "New Heights" (already caught by UNAMBIGUOUS_ANNUITY_RE above).
    if (/nationwide/i.test(productName)) return false;
    return true;
  }
  return false;
}

function parseMDY(s) {
  if (!s) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

async function login(page) {
  // Anthony has no separate direct BSCpro login — access goes through
  // Brilynn's account, then a "Log In As" switch into Anthony's view.
  await page.goto('https://bscpro.com/auth/login');
  await page.waitForSelector('#login');
  await page.fill('#login', process.env.BSCPRO_EMAIL_BRILYNN);
  await page.fill('#password', process.env.BSCPRO_PASSWORD_BRILYNN);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
  console.log('Logged into BSCpro as Brilynn.');

  await page.goto(ANTHONY_BSCPRO_LOGIN_AS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
  console.log("Switched into Anthony Augugliaro's BSCpro account.");
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

function normalizeRecord(r) {
  const policyNum = (r.policy_hidden || '').trim();
  const isIssued = !!policyNum && r.pending_submission !== '1';
  const cb = (r.cb_date || '').trim();
  const hasChargeback = !!cb && cb !== '0000-00-00';
  return {
    client: (r.client_name || '').trim(),
    product_name: r.product_name || '',
    product_description: r.product_description || '',
    note: (r.acc_notes && r.acc_notes.note) || '',
    product_type: detectProductType(r.product_name),
    points: parseFloat(r.actual_point || 0) || 0,  // "Base Points" column (left of Advances) — whole-number
    submitted_date: r.product_date || '',
    first_adv: r.first_adv || '',      // date the "first_adv" points_detail transaction paid — releases 40% of points
    paid_2_date: r.paid_2_date || '',  // date the "second_adv" points_detail transaction paid — releases the remaining 60%
    policy_number: policyNum,
    is_issued: isIssued,
    cb_date: cb,
    has_chargeback: hasChargeback,
  };
}

function buildScopeReport(records, scopeLabel) {
  const withMeta = records.map(normalizeRecord).map(r => ({
    ...r,
    is_trial: isTrialApp(r),
    is_annuity_literal: r.product_type === 'Annuity',
    is_annuity_product_line: r.product_type !== 'Annuity' && isLikelyAnnuityByProductLine(r.product_name, r.product_type),
  }));

  const excludedTrial = withMeta.filter(r => !r.has_chargeback && r.is_trial);
  const excludedAnnuityLiteral = withMeta.filter(r => !r.has_chargeback && !r.is_trial && r.is_annuity_literal);
  const excludedAnnuityProductLine = withMeta.filter(r => !r.has_chargeback && !r.is_trial && !r.is_annuity_literal && r.is_annuity_product_line);
  const eligible = withMeta.filter(r => !r.has_chargeback && !r.is_trial && !r.is_annuity_literal && !r.is_annuity_product_line);

  const withFirstAdvDays = eligible.map(r => ({
    ...r,
    days_since_first_adv: parseMDY(r.first_adv) ? Math.floor((NOW - parseMDY(r.first_adv)) / 86400000) : null,
  }));
  const pendingNoAdvDate = withFirstAdvDays.filter(r => r.days_since_first_adv === null);
  const pendingOutsideWindow = withFirstAdvDays.filter(r => r.days_since_first_adv !== null && (r.days_since_first_adv < 0 || r.days_since_first_adv > RECENT_WINDOW_DAYS));
  const pendingInWindow = withFirstAdvDays.filter(r => r.days_since_first_adv !== null && r.days_since_first_adv >= 0 && r.days_since_first_adv <= RECENT_WINDOW_DAYS);

  const pendingBucket = pendingInWindow.map(r => ({
    client: r.client, product: r.product_name, product_type: r.product_type,
    first_adv: r.first_adv, days_since_first_adv: r.days_since_first_adv,
    points: r.points, credit_40pct: +(r.points * 0.4).toFixed(2),
  }));

  const withSecondAdvDays = eligible.map(r => ({
    ...r,
    days_since_paid_2: parseMDY(r.paid_2_date) ? Math.floor((NOW - parseMDY(r.paid_2_date)) / 86400000) : null,
  }));
  const issuedNoAdvDate = withSecondAdvDays.filter(r => r.days_since_paid_2 === null);
  const issuedOutsideWindow = withSecondAdvDays.filter(r => r.days_since_paid_2 !== null && (r.days_since_paid_2 < 0 || r.days_since_paid_2 > RECENT_WINDOW_DAYS));
  const issuedInWindow = withSecondAdvDays.filter(r => r.days_since_paid_2 !== null && r.days_since_paid_2 >= 0 && r.days_since_paid_2 <= RECENT_WINDOW_DAYS);

  const issuedBucket = issuedInWindow.map(r => ({
    client: r.client, product: r.product_name, product_type: r.product_type,
    paid_2_date: r.paid_2_date, days_since_paid_2: r.days_since_paid_2,
    points: r.points, credit_60pct: +(r.points * 0.6).toFixed(2),
  }));

  const chargebackBucket = withMeta.filter(r => r.has_chargeback && r.cb_date.startsWith(MONTH_YM)).map(r => ({
    client: r.client, product: r.product_name, points: r.points, cb_date: r.cb_date,
  }));

  const pendingTotal = +pendingBucket.reduce((s, r) => s + r.credit_40pct, 0).toFixed(2);
  const issuedTotal = +issuedBucket.reduce((s, r) => s + r.credit_60pct, 0).toFixed(2);
  const chargebackTotal = +chargebackBucket.reduce((s, r) => s + r.points, 0).toFixed(2);

  const sample = (arr, n = 15) => arr.slice(0, n).map(r => ({ client: r.client, product: r.product_name || r.product }));

  return {
    scope: scopeLabel,
    total_records_in_scope: records.length,
    pending_40pct: {
      bucket: pendingBucket, total_credit: pendingTotal,
      excluded_trial_count: excludedTrial.length, excluded_trial_sample: sample(excludedTrial),
      excluded_annuity_literal_count: excludedAnnuityLiteral.length, excluded_annuity_literal_sample: sample(excludedAnnuityLiteral),
      excluded_annuity_product_line_count: excludedAnnuityProductLine.length, excluded_annuity_product_line_sample: excludedAnnuityProductLine.map(r => ({ client: r.client, product: r.product_name, points: r.points })),
      no_first_adv_date_on_file_count: pendingNoAdvDate.length,
      excluded_outside_window_count: pendingOutsideWindow.length, excluded_outside_window_note: `first_adv not today/yesterday (window ${RECENT_WINDOW_DAYS}d) — not counted`,
    },
    issued_60pct: {
      bucket: issuedBucket, total_credit: issuedTotal,
      excluded_trial_count: excludedTrial.length, excluded_trial_sample: sample(excludedTrial),
      excluded_annuity_literal_count: excludedAnnuityLiteral.length, excluded_annuity_literal_sample: sample(excludedAnnuityLiteral),
      excluded_annuity_product_line_count: excludedAnnuityProductLine.length, excluded_annuity_product_line_sample: excludedAnnuityProductLine.map(r => ({ client: r.client, product: r.product_name, points: r.points })),
      no_paid_2_date_on_file_count: issuedNoAdvDate.length,
      excluded_outside_window_count: issuedOutsideWindow.length, excluded_outside_window_note: `paid_2_date not today/yesterday (window ${RECENT_WINDOW_DAYS}d) — not counted`,
    },
    chargebacks: { bucket: chargebackBucket, total: chargebackTotal },
    bscpro_pending_delta: +(pendingTotal + issuedTotal - chargebackTotal).toFixed(2),
  };
}

const MYWFG_REPORT_URL = 'https://www.mywfg.com/reports-points-recruits?AgentID=53NUO';

async function loginMywfg(page) {
  await page.goto('https://www.mywfg.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  const loginBtn = page.locator('button:has-text("Log in")').first();
  if (await loginBtn.count() === 0) return { ok: true, alreadyLoggedIn: true };

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  const agentInput = page.locator('input[placeholder*="User"], input[placeholder*="Agent"], input[type="text"]').first();
  await agentInput.fill(process.env.MYWFG_USERNAME_ANTHONY);
  await page.fill('input[type="password"]', process.env.MYWFG_PASSWORD_ANTHONY);

  // Deliberately NOT checking the "I'm an agent assistant" checkbox here —
  // this is Anthony's own direct mywfg login, unlike Olivia's assistant-style
  // delegated login in fc_run_jamie.js.

  await loginBtn.click();
  await page.waitForTimeout(4000);

  if (page.url().includes('macotp')) {
    return { ok: false, error: 'OTP challenge required — cannot complete unattended. This is likely the FIRST automated login for Anthony\'s account (no trusted-device cookie yet in mywfg_profile_anthony/); a manual headed login is needed once to clear it.' };
  }
  const stillOnLoginForm = await page.locator('button:has-text("Log in")').count() > 0;
  if (stillOnLoginForm) {
    const nearFormError = page.locator('input[type="password"]').locator('xpath=ancestor::form//*[contains(@class,"error") or contains(@class,"alert")]').first();
    let msg = 'Login failed — still on login form after submit';
    if (await nearFormError.count() > 0) {
      const t = (await nearFormError.textContent() || '').trim();
      if (t) msg = t;
    }
    return { ok: false, error: msg };
  }
  return { ok: true };
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

async function fetchNetPointsCurrent(page) {
  await page.goto(MYWFG_REPORT_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (page.url().includes('macotp') || (await page.locator('button:has-text("Log in")').count()) > 0) {
    throw new Error('Session expired mid-run while loading report page');
  }

  const jcfSelect = page.locator('.jcf-select').filter({ hasText: /Net Points|Gross Points/ }).first();
  if (await jcfSelect.count() === 0) {
    throw new Error('Could not find JCF Point Type dropdown on the page — mywfg report layout may have changed again');
  }
  const current = (await jcfSelect.textContent() || '').trim();
  if (!current.includes('Net Points')) {
    await jcfSelect.click();
    await page.waitForTimeout(600);
    const option = page.locator('.jcf-option:has-text("Net Points"), .jcf-list li:has-text("Net Points")').first();
    await option.waitFor({ timeout: 5000 });
    await option.click();
  }

  const genBtn = page.locator('button:has-text("Generate Report"), input[value="Generate Report"]').first();
  await genBtn.click();
  try {
    await page.waitForSelector('.loading, .spinner, [class*="load"]', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('.loading, .spinner, [class*="load"]', { state: 'hidden', timeout: 60000 });
  } catch { await page.waitForTimeout(8000); }
  await page.waitForTimeout(3000);

  const ssrsFrame = page.frames().find(f => f.url().includes('EmbeddedReport'));
  if (!ssrsFrame) throw new Error('SSRS EmbeddedReport frame not found — mywfg report page layout may have changed again');
  try {
    const spinner = ssrsFrame.locator('img[src*="SpinningWheel"]').first();
    if (await spinner.count() > 0) await spinner.waitFor({ state: 'hidden', timeout: 60000 });
  } catch { /* spinner may not appear */ }
  await page.waitForTimeout(2000);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    ssrsFrame.evaluate(() => $find('ReportViewer1').exportReport('CSV')),
  ]);
  const tmpPath = path.join(DATA_DIR, 'net_points_fcrun_anthony_tmp.csv');
  await download.saveAs(tmpPath);
  const lines = fs.readFileSync(tmpPath, 'utf8').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Net Points CSV export had no data rows — cannot extract current points');

  const summaryRow = parseCsvLine(lines[1]);
  const num = s => parseFloat(String(s).replace(/,/g, '')) || 0;
  return {
    as_of_date: summaryRow[0],
    personal: num(summaryRow[1]),
    base: num(summaryRow[3]),
    superbase: num(summaryRow[5]),
    superteam: num(summaryRow[7]),
  };
}

(async () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const bscPage = await browser.newPage();
  await bscPage.setViewportSize({ width: 1600, height: 900 });

  const report = {
    generated_at: new Date().toISOString(),
    for_month: `${MON_SHORT} ${YEAR}`,
    mywfg_current_points: { status: 'not_attempted' },
    scopes: {},
  };

  const mywfgProfileDir = path.join(__dirname, 'mywfg_profile_anthony');
  let mywfgContext = null;
  const todayStr = NOW.getDate() + ' ' + MON_SHORT + ' ' + YEAR;

  try {
    // --- mywfg current points (attempt, do not fabricate on failure) ---
    try {
      mywfgContext = await chromium.launchPersistentContext(mywfgProfileDir, {
        headless: true, args: ['--no-sandbox'], acceptDownloads: true,
      });
      const mywfgPage = mywfgContext.pages()[0] || await mywfgContext.newPage();
      await mywfgPage.setViewportSize({ width: 1400, height: 900 });

      const loginResult = await loginMywfg(mywfgPage);
      if (!loginResult.ok) {
        report.mywfg_current_points = { status: 'FAILED', reason: loginResult.error, note: 'Current WFG points NOT available; do not treat as zero.' };
      } else {
        const netPoints = await fetchNetPointsCurrent(mywfgPage);
        report.mywfg_current_points = {
          status: 'OK',
          source: 'mywfg.com Net Points report (reports-points-recruits, AgentID 53NUO), current in-progress-month summary row',
          ...netPoints,
          note: `As of ${netPoints.as_of_date} — mywfg's own "current month" snapshot, may lag today's date by a day or two. SuperTeam vs SuperBase equivalence has NOT been verified for Anthony (unlike Olivia) — reported as-is.`,
        };
      }
    } catch (e) {
      report.mywfg_current_points = { status: 'ERROR', reason: e.message };
    } finally {
      if (mywfgContext) await mywfgContext.close();
    }

    // --- BSCpro pending/issued/chargeback, Base and Superbase ---
    await login(bscPage);
    await bscPage.goto('https://bscpro.com/production_new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bscPage.waitForTimeout(3000);

    for (const { label, values } of [{ label: 'base', values: ['base'] }, { label: 'superbase', values: ['superbase'] }]) {
      console.log(`\n=== Scope: ${label} ===`);
      await setScope(bscPage, values);
      const records = await fetchProductionRecords(bscPage, todayStr);
      console.log(`  Records fetched: ${records.length}`);
      report.scopes[label] = buildScopeReport(records, label);
    }

    // --- Running Total = Current WFG (Net) Points + BSCpro Delta ---
    if (report.mywfg_current_points.status === 'OK') {
      const mw = report.mywfg_current_points;
      // Same rollup fix as fc_run_jamie.js: BSCpro's scope_filter=superbase is
      // an EXCLUSIVE slice (not cumulative with base), while mywfg's SuperBase
      // Net Points figure IS cumulative — so the superbase running total adds
      // both scopes' BSCpro deltas together. Verify record counts confirm the
      // same exclusivity for Anthony (superbase scope count < base scope count)
      // before trusting this blindly — flagged in output for review.
      const superbaseDelta = +(report.scopes.base.bscpro_pending_delta + report.scopes.superbase.bscpro_pending_delta).toFixed(2);
      report.running_totals = {
        base: +(mw.base + report.scopes.base.bscpro_pending_delta).toFixed(2),
        superbase: +(mw.superbase + superbaseDelta).toFixed(2),
        superbase_delta_breakdown: { base_scope_delta: report.scopes.base.bscpro_pending_delta, superbase_scope_delta: report.scopes.superbase.bscpro_pending_delta, combined: superbaseDelta },
        formula: 'Running Total = Current WFG Net Points (mywfg, current in-progress month) + BSCpro Delta (1st-advance-paid-today/yesterday*40% + 2nd-advance-paid-today/yesterday*60% - chargebacks); superbase delta = base scope delta + superbase scope delta (assumes superbase scope is exclusive of base, not cumulative — verify record counts for Anthony)',
        flanking_note: 'Confirmed by Brilynn 2026-08-01: Anthony Augugliaro is not flanked by anyone. No flanking adjustment applied.',
      };
    } else {
      report.running_totals = { status: 'UNAVAILABLE', reason: 'mywfg_current_points did not succeed this run — see mywfg_current_points.reason above. Do not report a running total without a fresh Current WFG Points figure.' };
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log('\nSaved to', OUT_FILE);
    console.log('REPORT_COMPLETE');
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
