/**
 * read_fast_start.js
 * Reads active TA recruits from Recruit Tracker sheet + Fast Start tab,
 * filters by field trainer, merges step completion data, outputs JSON to stdout.
 *
 * Step 3 Done = "Fast Start" tab col C = "YES"
 * Step 4 Done = field_appt_1 (col T in Recruit Tracker) is non-empty
 * Step 5 Done = field_appt_2 (col U) non-empty OR Fast Start tab col E = "YES"
 *
 * Usage: node read_fast_start.js [--trainer "Olivia Sula-Wang"]
 * Output: [FAST_START_RESULT] { recruits: [...] }
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID        = '1F5ntZXHa4eg1dKf0XR_9yClmeoZOpAW8_zm1GeJaEEY';
const CREDS_PATH      = 'C:\\Users\\Mouth\\mcp-servers\\google-sheets\\credentials.json';
const PROD_CACHE_FILE = path.join(__dirname, 'data', 'production_clients.json');

// Load production clients (by_client keys are lowercased full names)
function loadProductionClients() {
  try {
    const raw = fs.readFileSync(PROD_CACHE_FILE, 'utf-8');
    const d   = JSON.parse(raw);
    return new Set(Object.keys(d.by_client || {}));
  } catch {
    return new Set();
  }
}

// Parse --trainer argument
const argv = process.argv.slice(2);
const trainerIdx = argv.indexOf('--trainer');
const TRAINER_FILTER = trainerIdx >= 0 ? argv[trainerIdx + 1] : '';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function main() {
  const productionClients = loadProductionClients();
  const sheets = await getSheetsClient();

  // Read Recruit Tracker (all columns, skip header row 1)
  const rtRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Recruit Tracker!A2:AD',
  });
  const rtRows = rtRes.data.values || [];

  // Column indices (0-based) in Recruit Tracker:
  // A=0 recid, B=1 rec_lic_id, C=2 name, D=3 code, E=4 email, F=5 phone
  // K=10 field_trainer, T=19 field_appt_1, U=20 field_appt_2, AB=27 level_code, AC=28 is_active
  const IDX = { name: 2, code: 3, phone: 5, trainer: 10, appt1: 19, appt2: 20, level: 27, active: 28 };

  // Read Fast Start tab (skip header row 1)
  const fsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Fast Start!A2:E',
  });
  const fsRows = fsRes.data.values || [];

  // Build lookup: code -> { step3Done, step5Done }
  const fastStartMap = {};
  for (const row of fsRows) {
    const code = (row[0] || '').trim();
    if (!code) continue;
    fastStartMap[code] = {
      step3Done: (row[2] || '').toUpperCase() === 'YES',
      step5Done: (row[4] || '').toUpperCase() === 'YES',
    };
  }

  // Build recruit list: active TAs filtered by field trainer
  const recruits = [];
  for (const row of rtRows) {
    const active  = (row[IDX.active]  || '').trim();
    const trainer = (row[IDX.trainer] || '').trim();

    if (active !== '1') continue;
    if (TRAINER_FILTER && !trainer.toLowerCase().includes(TRAINER_FILTER.toLowerCase())) continue;

    const code  = (row[IDX.code]  || '').trim();
    const name  = (row[IDX.name]  || '').trim();
    const phone = (row[IDX.phone] || '').trim();
    const appt1 = (row[IDX.appt1] || '').trim();
    const appt2 = (row[IDX.appt2] || '').trim();

    const fsEntry   = fastStartMap[code] || {};
    const isClient  = productionClients.has(name.toLowerCase());
    recruits.push({
      name,
      code,
      phone,
      trainer,
      step3Done: !!fsEntry.step3Done,
      step4Done: isClient || !!appt1,
      step5Done: isClient || !!appt2 || !!fsEntry.step5Done,
    });
  }

  // Sort: fewest steps completed first
  recruits.sort((a, b) => {
    const doneA = [a.step3Done, a.step4Done, a.step5Done].filter(Boolean).length;
    const doneB = [b.step3Done, b.step4Done, b.step5Done].filter(Boolean).length;
    return doneA - doneB;
  });

  console.log('[FAST_START_RESULT]' + JSON.stringify({ recruits }));
}

main().catch(err => {
  console.error(err.message);
  console.log('[FAST_START_RESULT]' + JSON.stringify({ recruits: [], error: err.message }));
});
