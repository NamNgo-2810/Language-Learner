// Google Sheets data-access layer.
//
// Replaces the old markdown-file storage. Each language maps to one worksheet
// (tab) inside a spreadsheet, with a header row and one word per row:
//
//   char | pinyin | sentence | session
//
// The `session` column (a YYYY-MM-DD date) replaces the old "## date" markdown
// headers — it's how the app figures out which words are newest. All rows that
// share the same session value belong to the same class session.
//
// Auth: a Google service account. Set GOOGLE_SERVICE_ACCOUNT_JSON to the full
// JSON of the service-account key (or GOOGLE_SERVICE_ACCOUNT_FILE to a path).
// Share each spreadsheet with the service account's client_email (Editor).

const fs = require("fs");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const HEADER = ["char", "pinyin", "sentence", "session"];

let sheetsClientPromise = null;

// Reads the service-account credentials from the environment. Prefers the
// inline JSON var (best for hosts like Render); falls back to a file path.
function loadCredentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim()) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON");
    }
  }
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (file && file.trim()) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`could not read/parse GOOGLE_SERVICE_ACCOUNT_FILE at ${file}`);
    }
  }
  throw new Error(
    "no Google credentials found — set GOOGLE_SERVICE_ACCOUNT_JSON (inline JSON) " +
      "or GOOGLE_SERVICE_ACCOUNT_FILE (path to the key file)"
  );
}

// Lazily builds and caches an authenticated Sheets API client.
function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const creds = loadCredentials();
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
      const authClient = await auth.getClient();
      return google.sheets({ version: "v4", auth: authClient });
    })().catch((err) => {
      // Don't cache a failed attempt — let the next call retry (e.g. after the
      // user fixes their env vars) instead of getting stuck on the old error.
      sheetsClientPromise = null;
      throw err;
    });
  }
  return sheetsClientPromise;
}

// True if credentials are configured at all (used so the server can warn early
// and endpoints can return a clear message instead of a stack trace).
function isConfigured() {
  return Boolean(
    (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim()) ||
      (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && process.env.GOOGLE_SERVICE_ACCOUNT_FILE.trim())
  );
}

// Quotes a tab name for use in an A1 range (e.g. Sheet1 -> 'Sheet1'), escaping
// any single quotes inside it per the Sheets A1 convention (' -> '').
function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

// Reads every word row for a language's tab and returns entries in the same
// shape the client already expects from the old markdown parser:
//   { char, pinyin, sentence, sessionIndex, sessionLabel }
// sessionIndex is assigned in the order sessions (dates) first appear, matching
// how the old parser numbered "## date" headers top-to-bottom.
async function readEntries(spreadsheetId, tab) {
  const sheets = await getSheetsClient();
  const range = `${quoteTab(tab)}!A2:D`; // skip the header row
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];

  const sessionOrder = new Map(); // sessionLabel -> sessionIndex
  const entries = [];

  for (const row of rows) {
    const char = String(row[0] || "").trim();
    const pinyin = String(row[1] || "").trim();
    if (!char || !pinyin) continue; // skip blank/incomplete rows
    const sentence = String(row[2] || "").trim() || null;
    const sessionLabel = String(row[3] || "").trim() || null;

    let sessionIndex = -1;
    if (sessionLabel !== null) {
      if (!sessionOrder.has(sessionLabel)) sessionOrder.set(sessionLabel, sessionOrder.size);
      sessionIndex = sessionOrder.get(sessionLabel);
    }

    entries.push({ char, pinyin, sentence, sessionIndex, sessionLabel });
  }

  return entries;
}

// Returns the session label (date) of the most recently added row, or null if
// the sheet has no data rows yet. Used to decide whether adding a word today
// starts a new session.
async function lastSessionLabel(spreadsheetId, tab) {
  const sheets = await getSheetsClient();
  const range = `${quoteTab(tab)}!D2:D`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const label = String((rows[i] && rows[i][0]) || "").trim();
    if (label) return label;
  }
  return null;
}

// Appends one word row. `session` is the YYYY-MM-DD label the row belongs to.
async function appendEntry(spreadsheetId, tab, { char, pinyin, sentence, session }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[char, pinyin, sentence || "", session || ""]] },
  });
}

// Appends many word rows in a single request. `rows` is an array of
// { char, pinyin, sentence, session }. Used by the migration script.
async function appendEntries(spreadsheetId, tab, rows) {
  if (!rows.length) return;
  const sheets = await getSheetsClient();
  const values = rows.map((r) => [r.char, r.pinyin, r.sentence || "", r.session || ""]);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

// Returns the number of existing data rows (excluding the header). Used by the
// migration script to avoid double-importing into a sheet that already has data.
async function countDataRows(spreadsheetId, tab) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteTab(tab)}!A2:A`,
  });
  return (res.data.values || []).filter((r) => String((r && r[0]) || "").trim()).length;
}

// Ensures row 1 of the tab is the expected header. Safe to call repeatedly;
// only writes if the header is missing or different. Used by the migration
// script and can be called on first write.
async function ensureHeader(spreadsheetId, tab) {
  const sheets = await getSheetsClient();
  const range = `${quoteTab(tab)}!A1:D1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const existing = (res.data.values && res.data.values[0]) || [];
  const matches = HEADER.every((h, i) => String(existing[i] || "").trim().toLowerCase() === h);
  if (matches) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [HEADER] },
  });
}

module.exports = {
  isConfigured,
  readEntries,
  lastSessionLabel,
  appendEntry,
  appendEntries,
  countDataRows,
  ensureHeader,
  HEADER,
};
