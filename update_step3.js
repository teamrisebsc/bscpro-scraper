/**
 * update_step3.js
 * Marks a recruit's Step 3 (Goals & Reachouts) as done or undone in the Fast Start sheet tab.
 *
 * Usage:
 *   node update_step3.js --code F6W00 --done true
 *   node update_step3.js --code F6W00 --done false
 *
 * Output: [UPDATE_STEP3_RESULT] { ok: true }
 */

require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID   = '1F5ntZXHa4eg1dKf0XR_9yClmeoZOpAW8_zm1GeJaEEY';
const CREDS_PATH = 'C:\\Users\\Mouth\\mcp-servers\\google-sheets\\credentials.json';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
);
// also support --code F6W00 (space-separated)
const argv = process.argv.slice(2);
const codeIdx = argv.indexOf('--code');
const doneIdx = argv.indexOf('--done');
const code = args.code || (codeIdx >= 0 ? argv[codeIdx + 1] : null);
const done = args.done !== undefined ? args.done : (doneIdx >= 0 ? argv[doneIdx + 1] : 'true');
const isDone = done === 'true' || done === true;

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function main() {
  if (!code) throw new Error('--code is required');

  const sheets = await getSheetsClient();

  // Read current Fast Start tab
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Fast Start!A2:E',
  });
  const rows = res.data.values || [];

  // Find existing row for this code
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === code) {
      rowIndex = i;
      break;
    }
  }

  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  if (rowIndex >= 0) {
    // Update existing row (row 2 = index 0 → sheet row 2)
    const sheetRow = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Fast Start!C${sheetRow}:D${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[isDone ? 'YES' : '', isDone ? today : '']] },
    });
  } else {
    // Append new row
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Fast Start!A:E',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[code, '', isDone ? 'YES' : '', isDone ? today : '', '']] },
    });
  }

  console.log('[UPDATE_STEP3_RESULT]' + JSON.stringify({ ok: true }));
}

main().catch(err => {
  console.error(err.message);
  console.log('[UPDATE_STEP3_RESULT]' + JSON.stringify({ ok: false, error: err.message }));
});
