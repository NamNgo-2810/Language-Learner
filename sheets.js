// Google Sheets data-access layer.
//
// Replaces the old markdown-file storage. Each language maps to one worksheet
// (tab) inside a spreadsheet, one word per row. There is no header row.
//
// Two row layouts coexist on the same tab and are both read as words:
//   - native : char=A, pinyin=B, sentence=C, session=D   (older rows from this app / migration)
//   - form   : char=D, pinyin=E, sentence=F, timestamp=G (new words added in the app, or a linked Google Form)
//
// The session value (a YYYY-MM-DD date, or the date part of a timestamp)
// replaces the old "## date" markdown headers — it's how the app figures out
// which words are newest. Rows sharing a session value are one class session.
//
// Auth: a Google service account. Set GOOGLE_SERVICE_ACCOUNT_JSON to the full
// JSON of the service-account key (or GOOGLE_SERVICE_ACCOUNT_FILE to a path).
// Share each spreadsheet with the service account's client_email (Editor).

const fs = require("fs");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

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

// The sheet has accumulated two row layouts over time (no header row):
//   - "native"  : char=A, pinyin=B, sentence=C, session=D  (written by this app)
//   - "form"    : char=D, pinyin=E, sentence=(none), timestamp=G
//                 (e.g. words added via a linked Google Form)
// Column H is shared by both layouts and holds the cached chiết tự (character
// component breakdown) explanation, generated once and reused instead of
// asking Claude on every flashcard view. Column I caches the Hán Việt
// reading the same way, and column J the grammar structures that come with the
// word, as a JSON array of { pattern, meaning, example } ("[]" = checked, none
// worth listing; empty = not checked yet).
// normalizeRow figures out which layout a given row is and returns a common
// { char, pinyin, sentence, session, chietu, hanViet, grammar } shape, or null if
// the row has no word.
//
// A1-notation date-like timestamps (e.g. a full "2026-09-08 14:03:22") are
// trimmed to just the YYYY-MM-DD part so both layouts group into sessions the
// same way.
function sessionFromCell(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  // Pull a leading YYYY-MM-DD if present (handles both bare dates and full
  // timestamps like "2026-09-08 14:03:22" or "2026-09-08T14:03:22Z").
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : raw;
}

// Column J -> array of grammar structures, or null if the word hasn't been
// checked yet (or the cell isn't valid JSON, so it gets re-checked).
function grammarFromCell(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((g) => g && g.pattern) : null;
  } catch {
    return null;
  }
}

function normalizeRow(row) {
  const col = (i) => String((row && row[i]) || "").trim();
  const chietu = col(7) || null; // column H, shared by both layouts
  const hanViet = col(8) || null; // column I, shared by both layouts
  const grammar = grammarFromCell(col(9)); // column J, shared by both layouts

  // Native layout: char in column A.
  if (col(0)) {
    const char = col(0);
    const pinyin = col(1);
    if (!char || !pinyin) return null;
    return {
      char,
      pinyin,
      sentence: col(2) || null,
      session: sessionFromCell(col(3)),
      chietu,
      hanViet,
      grammar,
    };
  }

  // Form layout: char in column D, pinyin in E, timestamp in G.
  if (col(3)) {
    const char = col(3);
    const pinyin = col(4);
    if (!char || !pinyin) return null;
    return {
      char,
      pinyin,
      sentence: col(5) || null, // tolerate an optional sentence in column F
      session: sessionFromCell(col(6)),
      chietu,
      hanViet,
      grammar,
    };
  }

  return null;
}

// Reads every word row for a language's tab and returns entries in the same
// shape the client already expects from the old markdown parser:
//   { char, pinyin, sentence, sessionIndex, sessionLabel, chietu, hanViet, grammar, rowNumber }
// Handles both the native (A-D) and form (D/E/G) row layouts on the same tab.
// sessionIndex is assigned in the order sessions (dates) first appear.
// rowNumber is the 1-based sheet row, used to write the cached columns back to
// the right row later without a second lookup.
async function readEntries(spreadsheetId, tab) {
  const sheets = await getSheetsClient();
  // Read A:J so both layouts (char in A, or char in D + timestamp in G) are
  // covered, plus the shared cache columns (H chietu, I Hán Việt, J grammar).
  const range = `${quoteTab(tab)}!A:J`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];

  const sessionOrder = new Map(); // sessionLabel -> sessionIndex
  const entries = [];

  for (let i = 0; i < rows.length; i++) {
    const norm = normalizeRow(rows[i]);
    if (!norm) continue; // blank row, header-ish row, or incomplete word

    const sessionLabel = norm.session;
    let sessionIndex = -1;
    if (sessionLabel !== null) {
      if (!sessionOrder.has(sessionLabel)) sessionOrder.set(sessionLabel, sessionOrder.size);
      sessionIndex = sessionOrder.get(sessionLabel);
    }

    entries.push({
      char: norm.char,
      pinyin: norm.pinyin,
      sentence: norm.sentence,
      sessionIndex,
      sessionLabel,
      chietu: norm.chietu,
      hanViet: norm.hanViet,
      grammar: norm.grammar,
      rowNumber: i + 1,
    });
  }

  return entries;
}

// Returns the session label (date) of the most recently added row, or null if
// the sheet has no words yet. Uses the same dual-layout normalization as
// readEntries so it's correct whichever format the last row is in.
async function lastSessionLabel(spreadsheetId, tab) {
  const entries = await readEntries(spreadsheetId, tab);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sessionLabel) return entries[i].sessionLabel;
  }
  return null;
}

// Appends one word row in the "form" layout, starting at column D: char=D,
// pinyin=E, sentence=F, session=G (columns A-C are left empty). `session` is
// the YYYY-MM-DD label the row belongs to. `chietu` (optional) is the chiết tự
// breakdown generated at add-time, cached in column H so it's never
// re-requested from Claude later; `hanViet` likewise in column I, and
// `grammar` (an array, or null if it couldn't be generated) in column J.
async function appendEntry(spreadsheetId, tab, { char, pinyin, sentence, session, chietu, hanViet, grammar }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!D:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        char, pinyin, sentence || "", session || "",
        chietu || "", hanViet || "", grammar ? JSON.stringify(grammar) : "",
      ]],
    },
  });
}

// Writes (or overwrites) the cached chiết tự breakdown for one existing row,
// identified by its 1-based sheet row number (as returned by readEntries).
async function updateChietu(spreadsheetId, tab, rowNumber, chietu) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteTab(tab)}!H${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[chietu]] },
  });
}

// Writes (or overwrites) the cached Hán Việt reading for one existing row.
async function updateHanViet(spreadsheetId, tab, rowNumber, hanViet) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteTab(tab)}!I${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[hanViet]] },
  });
}

// Overwrites all three cached columns (H chiết tự, I Hán Việt, J grammar) of
// one row, e.g. after the learner asks for them to be regenerated.
async function updateWordInfo(spreadsheetId, tab, rowNumber, { chietu, hanViet, grammar }) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteTab(tab)}!H${rowNumber}:J${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[chietu || "", hanViet || "", grammar ? JSON.stringify(grammar) : ""]] },
  });
}

// Writes the grammar structures for many rows in one request.
// `updates` is an array of { rowNumber, grammar } with grammar an array.
async function updateGrammarBatch(spreadsheetId, tab, updates) {
  if (!updates.length) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates.map((u) => ({
        range: `${quoteTab(tab)}!J${u.rowNumber}`,
        values: [[JSON.stringify(u.grammar)]],
      })),
    },
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

// Returns the number of existing word rows (either layout). Used by the
// migration script to avoid double-importing into a sheet that already has data.
async function countDataRows(spreadsheetId, tab) {
  const entries = await readEntries(spreadsheetId, tab);
  return entries.length;
}

module.exports = {
  isConfigured,
  readEntries,
  lastSessionLabel,
  appendEntry,
  appendEntries,
  updateChietu,
  updateHanViet,
  updateGrammarBatch,
  updateWordInfo,
  countDataRows,
};
