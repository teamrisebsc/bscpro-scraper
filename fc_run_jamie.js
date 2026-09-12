/**
 * fc_run_jamie.js
 * Weekly-recurring "FC Run" point total for Olivia Sula-Wang, for Jamie Villalovos
 * (Team Revolution leadership) — progress toward Field Chairman promotion.
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
 * Run weekly (Fridays). Usage: node fc_run_jamie.js
 *
 * KNOWN LIMITATIONS (read before trusting output):
 *  1. Current WFG points requires a working mywfg.com login. Password was refreshed
 *     2026-07-31 (MYWFG_PASSWORD in .env) and confirmed working. Login
 *     reuses the persistent browser profile at mywfg_profile/ (same one
 *     scrape_mywfg_production.js uses) so the "Remember This Device" cookie avoids
 *     OTP on repeat runs. If OTP ever gets triggered again (new machine, cleared
 *     profile, etc.), this script will report FAILED rather than hang — run
 *     `node scrape_mywfg_production.js` once manually (headed) to clear the OTP
 *     challenge and refresh the trusted-device cookie, then re-run this script.
 *     "Current WFG Points" = the Net Points report's current in-progress-month
 *     summary row (not the historical MonthYear table, which only shows closed
 *     months) — Net (not Gross) is used because it's already net of chargebacks,
 *     matching how this formula layers BSCpro chargebacks in separately.
 *     mywfg's Net Points report DOES split by scope (Base / SuperBase / SuperTeam
 *     columns) matching BSCpro's scope_filter — confirmed 2026-07-31. For Olivia,
 *     SuperBase and SuperTeam values are identical (no separate SuperTeam
 *     population beyond her superbase).
 *  2. Pending and issued buckets are restricted to RECENT_WINDOW_DAYS (today or
 *     yesterday), computed dynamically from the moment the script runs — not a
 *     fixed calendar date. This closes the gap between what BSCpro shows live
 *     and what mywfg's Net Points snapshot has already caught up to (mywfg's
 *     own current-month figure lags ~1-2 days behind today, per its own report
 *     metadata). Anything advanced further back is assumed to already be
 *     reflected in the mywfg number and is excluded here to avoid
 *     double-counting. Note: a record can land in BOTH buckets in the same run
 *     if its 1st and 2nd advances both landed inside the window (e.g. a fast
 *     policy that gets both advances within a day or two of each other).
 *  3. The WFG flanking rule (same-level downline legs excluded from upline credit)
 *     is NOT applied here - BSCpro's scope_filter (base/superbase) does not expose
 *     which downline legs are "flanked" (same promotion level as Olivia in the same
 *     line). This script reports RAW BSCpro pending/issued totals for the scope;
 *     a human must cross-check against known flanked legs before treating this as
 *     final WFG-credited points.
 *  4. Trial-app detection: BSCpro doesn't have a clean trial-app flag; this script
 *     regex-matches product_name/product_description/notes for "trial" language.
 *     If nothing matches, that means no trial apps were FOUND BY TEXT MATCH, not
 *     that none exist - flagged in output.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'fc_run_jamie_latest.json');
// Registry of policy_numbers already credited toward the running total, keyed
// by scope (base/superbase kept separate — Olivia's scopes are mutually
// exclusive so this doesn't matter for her, but fc_run_anthony.js reuses this
// same mechanism and his scopes intentionally overlap/double-count by design,
// see fc-run.md). Added 9/12/26 per Brilynn: policies that are ISSUED but
// whose 1st/2nd advance hasn't posted in BSCpro yet were getting $0 credit
// forever (the old formula only fired on an advance-transaction date landing
// in the 1-day window) — now any newly-issued policy gets 100% credit the
// first time it's seen, and this registry stops it from being credited again
// once its advance dates later post. On the very first run (no registry file
// yet) every CURRENTLY-issued policy is seeded into the registry at 0 credit
// instead of counted, so flipping this on doesn't dump years of back-issued
// business into one week's number — only genuinely new issuances from here
// forward hit issued_100pct.
const REGISTRY_FILE = path.join(DATA_DIR, 'fc_run_credited_policies_jamie.json');
const windowArg = process.argv.find(a => a.startsWith('--window='));
const RECENT_WINDOW_DAYS = windowArg ? parseInt(windowArg.split('=')[1], 10) : 1;  // pending/issued buckets only count records dated today (0) or yesterday (1) by default — dynamic, relative to NOW below. Override with --window=N for a one-off wider run (e.g. to catch a date that aged out of the normal 1-day window). SEE CAVEAT ABOVE
const unseedDatesArg = process.argv.find(a => a.startsWith('--unseed-dates='));
const UNSEED_DATES = unseedDatesArg ? unseedDatesArg.split('=')[1].split(',') : null;  // one-off recovery: MM/DD/YYYY,MM/DD/YYYY — see buildScopeReport

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

// SUPPLEMENTARY annuity check. The task-specified detectProductType() regex
// (/annuity|fia\b/i) only catches product names that literally say "annuity"
// or "FIA" — it misses well-known carrier annuity product LINES that are sold
// under branded names with no such keyword: Nationwide New Heights/Accumulator,
// F&G Power Accumulator/Safe Income Advantage/Accumulator Plus, Athene
// Performance Elite/Ascent Pro/MaxRate, North American Secure Horizon, Global
// Atlantic ForeAccumulation, Allianz Index Advantage. On a first pass through
// this data those branded names accounted for a large share of the "Other"
// bucket. Given the task's hard rule ("annuities = zero, no exceptions"),
// under-detecting is worse than over-flagging, so this is applied as an
// ADDITIONAL check on top of detectProductType — flagged separately in output
// as "product-line match" (not a literal keyword hit) so it can be manually
// verified against the actual carrier product sheet.
// UNAMBIGUOUS annuity brand names — these carrier product lines are annuity-only
// (never used for a life/IUL product), so they override detectProductType()'s
// result even when that function mis-tagged the record. This matters because
// the task-specified detectProductType regex has a real bug: /fe\b/ (meant for
// "Final Expense") also matches the "fe" at the end of the word "Life" (e.g.
// "Global Atlantic Forethought LIFE Insurance - ForeAccumulation II" gets
// mis-tagged 'FE/GUL' purely because of the word "Life" in the carrier's full
// legal name) — so gating strictly on 'Other'/'Unknown' would miss it.
const UNAMBIGUOUS_ANNUITY_RE = /foreaccumulation|secure horizon|performance elite|ascent (pro|elite)|max ?rate|new heights|safe income|power accum(u)?lat|index adv(antage)?\b/i;
// AMBIGUOUS: bare "Accumulator"/"Accumlat" (typo variant) is also Nationwide's
// branded name for a real IUL LIFE product ("IUL Accumulator II 2020"), so this
// one is only trusted when detectProductType() found no other signal at all
// (i.e. returned 'Other'/'Unknown') — otherwise it would wrongly reclassify
// genuine IUL policies as annuities.
const AMBIGUOUS_ANNUITY_RE = /accum(u)?lat/i;

function isLikelyAnnuityByProductLine(productName, productType) {
  if (!productName) return false;
  if (UNAMBIGUOUS_ANNUITY_RE.test(productName)) return true;
  if ((productType === 'Other' || productType === 'Unknown') && AMBIGUOUS_ANNUITY_RE.test(productName)) {
    // Nationwide's "Accumulator" line (Accumulator II/III, IUL Accumulator) is a
    // real IUL/life product, not an annuity — Nationwide's annuity brand is
    // "New Heights" (already caught by UNAMBIGUOUS_ANNUITY_RE above). Confirmed
    // 2026-08-01 after this false-positive silently dropped every Nationwide
    // Accumulator policy (e.g. Stephanie Stovall) from both buckets.
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
  await page.goto('https://bscpro.com/auth/login');
  await page.waitForSelector('#login');
  await page.fill('#login', process.env.BSCPRO_EMAIL_OLIVIA);
  await page.fill('#password', process.env.BSCPRO_PASSWORD_OLIVIA);
  await page.click('input[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
  console.log('Logged into BSCpro as Olivia.');
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

// Mapped-team multiplier: when a sub-team is mapped in from elsewhere, BSCpro
// shows a small "75%" (or similar) badge next to the writing/split agents in
// the production grid, and only that fraction of the record's points count.
// Confirmed via raw record inspection (Moises Cabrera, 8/8/26): agents[].multiplier
// = "0.75" on the writing_agent/split_agent (0 on trainees), and BSCpro's own
// points_detail transactions bake this in (base_amount = transaction_amount *
// attribution_percentage/100, e.g. 266.4 * 0.75 = 199.8). Per Brilynn's
// instruction, apply the writing agent's multiplier to actual_point before
// computing the 40%/60% credit — do not use the raw actual_point for mapped teams.
function getMappedMultiplier(r) {
  const agents = Array.isArray(r.agents) ? r.agents : [];
  const writingAgent = agents.find(a => a.agent_type === 'writing_agent');
  if (writingAgent && writingAgent.multiplier !== undefined && writingAgent.multiplier !== null) {
    const m = parseFloat(writingAgent.multiplier);
    if (!isNaN(m)) return m;
  }
  return 1;
}

function normalizeRecord(r) {
  const policyNum = (r.policy_hidden || '').trim();
  const isIssued = !!policyNum && r.pending_submission !== '1';
  const cb = (r.cb_date || '').trim();
  const hasChargeback = !!cb && cb !== '0000-00-00';
  const rawPoints = parseFloat(r.actual_point || 0) || 0;
  const mappedMultiplier = getMappedMultiplier(r);
  return {
    client: (r.client_name || '').trim(),
    product_name: r.product_name || '',
    product_description: r.product_description || '',
    note: (r.acc_notes && r.acc_notes.note) || '',
    product_type: detectProductType(r.product_name),
    raw_points: rawPoints,
    mapped_multiplier: mappedMultiplier,
    points: +(rawPoints * mappedMultiplier).toFixed(2),  // "Base Points" column (left of Advances) — whole-number, unlike base_written_points which applies a per-agent attribution split and produces decimals; reduced by mapped_multiplier when < 1 (mapped-in team)
    submitted_date: r.product_date || '',
    issued_date: r.issued_date || '',
    given_to_agent_date: r.given_to_agent_date || '',
    production_created_at_date: (r.production_created_at || '').split(' ')[0] || '',
    first_adv: r.first_adv || '',      // date the "first_adv" points_detail transaction paid — releases 40% of points
    paid_2_date: r.paid_2_date || '',  // date the "second_adv" points_detail transaction paid — releases the remaining 60%
    policy_number: policyNum,
    is_issued: isIssued,
    cb_date: cb,
    has_chargeback: hasChargeback,
  };
}

function buildScopeReport(records, scopeLabel, registry, isBackfillRun, unseedDates) {
  const withMeta = records.map(normalizeRecord).map(r => ({
    ...r,
    is_trial: isTrialApp(r),
    is_annuity_literal: r.product_type === 'Annuity',
    is_annuity_product_line: r.product_type !== 'Annuity' && isLikelyAnnuityByProductLine(r.product_name, r.product_type),
  }));

  // Shared eligibility filter (not trial, not annuity, not charged back) —
  // applies identically to both buckets since they now key off the same
  // underlying record pool, just different advance-date fields.
  const excludedTrial = withMeta.filter(r => !r.has_chargeback && r.is_trial);
  const excludedAnnuityLiteral = withMeta.filter(r => !r.has_chargeback && !r.is_trial && r.is_annuity_literal);
  const excludedAnnuityProductLine = withMeta.filter(r => !r.has_chargeback && !r.is_trial && !r.is_annuity_literal && r.is_annuity_product_line);
  const eligibleAll = withMeta.filter(r => !r.has_chargeback && !r.is_trial && !r.is_annuity_literal && !r.is_annuity_product_line);

  // ---- Registry gate: skip anything already credited in a prior run ----
  const registryScope = registry[scopeLabel] || (registry[scopeLabel] = {});

  // ---- One-off recovery (--unseed-dates=MM/DD/YYYY,MM/DD/YYYY): the 9/12/26
  // backfill seeded EVERY currently-issued policy at 0 credit to avoid a
  // historical spike, but that also swallowed the specific 9/10-9/11 policies
  // that should have gotten real credit in the 9/11 run this fix was written
  // for. Un-seed (remove from registry) any backfill_seed entry whose
  // submitted_date matches one of the given dates, so it flows through as a
  // fresh issued_100pct credit in this same run — one-time use, not part of
  // normal weekly operation.
  let unseededCount = 0;
  if (unseedDates && unseedDates.length) {
    for (const r of eligibleAll) {
      if (!r.policy_number) continue;
      const entry = registryScope[r.policy_number];
      const recordDateMatch = unseedDates.includes(r.issued_date) || unseedDates.includes(r.given_to_agent_date) || unseedDates.includes(r.production_created_at_date);
      if (entry && entry.bucket === 'backfill_seed' && recordDateMatch) {
        delete registryScope[r.policy_number];
        unseededCount++;
      }
    }
  }

  const alreadyCreditedCount = eligibleAll.filter(r => r.policy_number && registryScope[r.policy_number]).length;
  const eligible = eligibleAll.filter(r => !(r.policy_number && registryScope[r.policy_number]));

  // ---- Issued 100% bucket: policy is ISSUED (has a policy number, not a
  // pending submission) regardless of whether either advance has posted yet.
  // Per Brilynn 9/12/26: an issued policy should count in full the first time
  // it's seen — don't wait on the advance transaction, which can lag BSCpro
  // by weeks. Everything here gets written into `registry` so it's never
  // credited again once its first_adv/paid_2_date eventually post (which
  // would otherwise double-count it via the buckets below).
  const issuedFullCredit = isBackfillRun ? [] : eligible.filter(r => r.is_issued && r.policy_number);
  const issuedFullCreditBucket = issuedFullCredit.map(r => ({
    client: r.client, product: r.product_name, product_type: r.product_type,
    policy_number: r.policy_number, points: r.points, credit_100pct: r.points,
    ...(r.mapped_multiplier < 1 ? { raw_points: r.raw_points, mapped_multiplier: r.mapped_multiplier } : {}),
  }));
  const issuedFullCreditTotal = +issuedFullCreditBucket.reduce((s, r) => s + r.credit_100pct, 0).toFixed(2);

  // Backfill run: seed the registry with every CURRENTLY-issued policy at 0
  // credit instead of counting it, so turning this feature on doesn't dump
  // years of already-issued business into one week's number.
  const backfillSeeded = isBackfillRun ? eligible.filter(r => r.is_issued && r.policy_number) : [];

  // Remaining pool for the old advance-date buckets below: anything not
  // issued yet (still pending submission / no policy number) — in practice
  // these rarely carry an advance date, but kept as a safety net in case an
  // advance transaction ever posts ahead of the formal "issued" flag.
  const notYetIssuedPool = isBackfillRun ? eligible : eligible.filter(r => !(r.is_issued && r.policy_number));

  // ---- Pending 40% bucket: the "first_adv" points_detail transaction paid
  // today or yesterday (RECENT_WINDOW_DAYS). Confirmed via BSCpro's production
  // tracker "Advances" column (1st/2nd boxes) and the underlying points_detail
  // transaction log: a first_adv transaction releases exactly 40% of a
  // record's points. Outside the window = assumed already reflected in
  // mywfg's Current WFG Points figure.
  const withFirstAdvDays = notYetIssuedPool.map(r => ({
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
    ...(r.mapped_multiplier < 1 ? { raw_points: r.raw_points, mapped_multiplier: r.mapped_multiplier } : {}),
  }));

  // ---- Issued 60% bucket: the "second_adv" points_detail transaction paid
  // today or yesterday (RECENT_WINDOW_DAYS), tracked via BSCpro's top-level
  // `paid_2_date` field (the "2nd" box in the Advances column) — releases
  // the remaining 60% of a record's points.
  const withSecondAdvDays = notYetIssuedPool.map(r => ({
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
    ...(r.mapped_multiplier < 1 ? { raw_points: r.raw_points, mapped_multiplier: r.mapped_multiplier } : {}),
  }));

  // ---- Chargebacks: cb_date set, in current month (expected to hit this month) ----
  const chargebackBucket = withMeta.filter(r => r.has_chargeback && r.cb_date.startsWith(MONTH_YM)).map(r => ({
    client: r.client, product: r.product_name, points: r.points, cb_date: r.cb_date,
  }));

  const pendingTotal = +pendingBucket.reduce((s, r) => s + r.credit_40pct, 0).toFixed(2);
  const issuedTotal = +issuedBucket.reduce((s, r) => s + r.credit_60pct, 0).toFixed(2);
  const chargebackTotal = +chargebackBucket.reduce((s, r) => s + r.points, 0).toFixed(2);

  // ---- Commit this run's credits to the registry so nothing here is ever
  // re-counted in a future run (whether it stays in this same bucket or its
  // advance dates post later). ----
  const nowIso = new Date().toISOString();
  for (const r of issuedFullCredit) {
    registryScope[r.policy_number] = { credited_at: nowIso, points: r.points, bucket: 'issued_100pct', client: r.client, scope: scopeLabel };
  }
  for (const r of backfillSeeded) {
    registryScope[r.policy_number] = { credited_at: nowIso, points: 0, bucket: 'backfill_seed', client: r.client, scope: scopeLabel };
  }
  for (const r of pendingInWindow) {
    if (r.policy_number) registryScope[r.policy_number] = { credited_at: nowIso, points: +(r.points * 0.4).toFixed(2), bucket: 'first_adv_40pct', client: r.client, scope: scopeLabel };
  }
  for (const r of issuedInWindow) {
    if (!r.policy_number) continue;
    const existing = registryScope[r.policy_number];
    if (existing && existing.bucket === 'first_adv_40pct') {
      existing.bucket = 'first_adv_40pct+second_adv_60pct';
      existing.points = +(existing.points + r.points * 0.6).toFixed(2);
    } else {
      registryScope[r.policy_number] = { credited_at: nowIso, points: +(r.points * 0.6).toFixed(2), bucket: 'second_adv_60pct', client: r.client, scope: scopeLabel };
    }
  }

  const sample = (arr, n = 15) => arr.slice(0, n).map(r => ({ client: r.client, product: r.product_name || r.product }));

  return {
    scope: scopeLabel,
    total_records_in_scope: records.length,
    already_credited_prior_run_count: alreadyCreditedCount,
    unseeded_for_recovery_count: unseededCount,
    issued_100pct: {
      bucket: issuedFullCreditBucket, total_credit: issuedFullCreditTotal,
      note: isBackfillRun
        ? `BACKFILL RUN: registry didn't exist yet — ${backfillSeeded.length} currently-issued policies were seeded into the registry at 0 credit (not counted) so this methodology change doesn't dump historical business into one week's number. From next run forward, newly-issued policies will show here at full credit.`
        : unseededCount > 0
          ? `Includes ${unseededCount} policy(ies) recovered via --unseed-dates (submitted_date matched one of the given recovery dates, previously backfilled at 0) plus any genuinely new issuance since the last run.`
          : 'Policies with a policy number (is_issued) not previously seen in the registry — credited at 100% of points regardless of advance-transaction status, per Brilynn 9/12/26.',
    },
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
    bscpro_pending_delta: +(pendingTotal + issuedTotal + issuedFullCreditTotal - chargebackTotal).toFixed(2),
  };
}

const MYWFG_REPORT_URL = 'https://www.mywfg.com/reports-points-recruits?AgentID=19RSI';

async function loginMywfg(page) {
  await page.goto('https://www.mywfg.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);
  const loginBtn = page.locator('button:has-text("Log in")').first();
  if (await loginBtn.count() === 0) return { ok: true, alreadyLoggedIn: true };

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  const agentInput = page.locator('input[placeholder*="User"], input[placeholder*="Agent"], input[type="text"]').first();
  await agentInput.fill(process.env.MYWFG_USERNAME);
  await page.fill('input[type="password"]', process.env.MYWFG_PASSWORD);

  const agentBox = page.locator('input[type="checkbox"]').first();
  if (!(await agentBox.isChecked())) await agentBox.check();

  await loginBtn.click();
  await page.waitForTimeout(4000);

  if (page.url().includes('macotp')) {
    return { ok: false, error: 'OTP challenge required — cannot complete unattended. Run `node scrape_mywfg_production.js` manually (headed) once to refresh the trusted-device cookie in mywfg_profile/, then re-run.' };
  }
  // Determine success by whether the login form itself is gone (matches
  // scrape_mywfg_production.js's isLoginPage() check) — NOT a broad page-wide
  // text search for "error"/"incorrect", which false-positives on unrelated
  // page content (e.g. the homepage's "Errors & Omissions (E&O) Insurance Info"
  // banner, which contains the substring "Error").
  const stillOnLoginForm = await page.locator('button:has-text("Log in")').count() > 0;
  if (stillOnLoginForm) {
    // Best-effort: look for an actual error message near the password field only.
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

// Pulls the current in-progress-month summary row from the top of the Net Points
// SSRS CSV export (columns textbox44-52: AsOfDate, Personal, RecruitsPersonal,
// Base, RecruitsBase, SuperBase, RecruitsSuperBase, SuperTeam, RecruitsSuperTeam).
// This is DIFFERENT from the historical MonthYear table further down the same
// file, which only contains already-closed-out months — the current month never
// appears there until it closes.
async function fetchNetPointsCurrent(page) {
  await page.goto(MYWFG_REPORT_URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (page.url().includes('macotp') || (await page.locator('button:has-text("Log in")').count()) > 0) {
    throw new Error('Session expired mid-run while loading report page');
  }

  // Point Type defaults to "Net Points" on this report; verify and switch if not.
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
  const tmpPath = path.join(DATA_DIR, 'net_points_fcrun_tmp.csv');
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
  const isBackfillRun = !fs.existsSync(REGISTRY_FILE);
  const registry = isBackfillRun ? {} : JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const bscPage = await browser.newPage();
  await bscPage.setViewportSize({ width: 1600, height: 900 });

  const report = {
    generated_at: new Date().toISOString(),
    for_month: `${MON_SHORT} ${YEAR}`,
    mywfg_current_points: { status: 'not_attempted' },
    registry_backfill_run: isBackfillRun,
    scopes: {},
  };

  const mywfgProfileDir = path.join(__dirname, 'mywfg_profile');
  let mywfgContext = null;
  const todayStr = NOW.getDate() + ' ' + MON_SHORT + ' ' + YEAR;

  try {
    // --- mywfg current points (attempt, do not fabricate on failure) ---
    // Uses the persistent profile (mywfg_profile/) shared with scrape_mywfg_production.js
    // so the "Remember This Device" cookie carries over and avoids OTP.
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
          source: 'mywfg.com Net Points report (reports-points-recruits, AgentID 19RSI), current in-progress-month summary row',
          ...netPoints,
          note: `As of ${netPoints.as_of_date} — mywfg's own "current month" snapshot, may lag today's date by a day or two. SuperTeam equals SuperBase for Olivia (no separate SuperTeam population).`,
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
      report.scopes[label] = buildScopeReport(records, label, registry, isBackfillRun, UNSEED_DATES);
    }

    // --- Running Total = Current WFG (Net) Points + BSCpro Delta ---
    // Flanking: confirmed by Brilynn that Olivia is not flanked by anyone —
    // no flanking adjustment applied to either scope.
    if (report.mywfg_current_points.status === 'OK') {
      const mw = report.mywfg_current_points;
      // BSCpro's scope_filter=superbase returns an EXCLUSIVE slice (the
      // downline beyond Olivia's own base shop), not a cumulative one — the
      // superbase scope consistently returns FEWER records than base
      // (e.g. 512 vs 1247), confirming the two scopes don't overlap. mywfg's
      // "SuperBase" Net Points figure, by contrast, IS cumulative (base +
      // superbase rolled together). So the superbase running total must add
      // BOTH scopes' BSCpro deltas to line up with what mywfg is counting.
      const superbaseDelta = +(report.scopes.base.bscpro_pending_delta + report.scopes.superbase.bscpro_pending_delta).toFixed(2);
      report.running_totals = {
        base: +(mw.base + report.scopes.base.bscpro_pending_delta).toFixed(2),
        superbase: +(mw.superbase + superbaseDelta).toFixed(2),
        superbase_delta_breakdown: { base_scope_delta: report.scopes.base.bscpro_pending_delta, superbase_scope_delta: report.scopes.superbase.bscpro_pending_delta, combined: superbaseDelta },
        formula: 'Running Total = Current WFG Net Points (mywfg, current in-progress month) + BSCpro Delta (newly-issued policies not previously credited*100% + 1st-advance-paid-today/yesterday*40% + 2nd-advance-paid-today/yesterday*60% - chargebacks); superbase delta = base scope delta + superbase scope delta (superbase scope is exclusive of base, not cumulative)',
        flanking_note: 'Confirmed by Brilynn 2026-07-31: Olivia is not flanked by anyone. No flanking adjustment applied.',
      };
    } else {
      report.running_totals = { status: 'UNAVAILABLE', reason: 'mywfg_current_points did not succeed this run — see mywfg_current_points.reason above. Do not report a running total without a fresh Current WFG Points figure.' };
    }

    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
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
