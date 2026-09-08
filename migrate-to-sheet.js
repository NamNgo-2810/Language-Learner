// One-time migration: pushes words from the old markdown files into their
// Google Sheets. Run once after you've set up the sheet(s) and credentials:
//
//   npm run migrate            # migrate every language that has a legacyFile
//   npm run migrate mandarin   # migrate only the given language id(s)
//
// Safe to be cautious: it refuses to import into a tab that already has data
// rows unless you pass --force, so you won't accidentally double up.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sheets = require("./sheets");

const ROOT = __dirname;

function loadLanguages() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "languages.json"), "utf8"));
}

function todayLabel() {
  return new Date().toISOString().slice(0, 10);
}

// Resolves a language's sheet id the same way the server does: env override
// first (GOOGLE_SHEET_ID_<ID> or GOOGLE_SHEET_ID), then languages.json.
function resolveSheetId(lang) {
  const perLang = process.env[`GOOGLE_SHEET_ID_${lang.id.toUpperCase()}`];
  const generic = process.env.GOOGLE_SHEET_ID;
  const candidate = (perLang || generic || lang.sheetId || "").trim();
  if (!candidate || candidate === "PASTE_YOUR_GOOGLE_SHEET_ID_HERE") return null;
  return candidate;
}

// Parses the old markdown format:
//   "char pinyin" or "char pinyin | example sentence"
//   optional "## YYYY-MM-DD" lines mark a new class session.
// Returns [{ char, pinyin, sentence, session }] where session is the date label
// (falls back to today's date for words that appeared before any header).
function parseMarkdown(raw) {
  const rows = [];
  let session = todayLabel(); // default for words with no preceding header

  raw.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      session = headerMatch[1].trim();
      return;
    }

    const cleaned = line.replace(/^(\d+[.)]|[-*])\s*/, "");
    const [main, sentencePart] = cleaned.split("|").map((s) => s.trim());
    const match = main.match(/^(\S+)\s+(.+)$/);
    if (!match) return;

    rows.push({
      char: match[1],
      pinyin: match[2].trim(),
      sentence: sentencePart || "",
      session,
    });
  });

  return rows;
}

async function migrateLanguage(lang, { force }) {
  if (!lang.legacyFile) {
    console.log(`- ${lang.id}: no legacyFile set, skipping`);
    return;
  }
  const filePath = path.join(ROOT, lang.legacyFile);
  if (!fs.existsSync(filePath)) {
    console.log(`- ${lang.id}: ${lang.legacyFile} not found, skipping`);
    return;
  }

  const sheetId = resolveSheetId(lang);
  if (!sheetId) {
    console.error(`- ${lang.id}: no sheetId configured — set it in languages.json or GOOGLE_SHEET_ID env, skipping`);
    return;
  }
  const tab = lang.tab || lang.id;

  const rows = parseMarkdown(fs.readFileSync(filePath, "utf8"));
  if (!rows.length) {
    console.log(`- ${lang.id}: no words parsed from ${lang.legacyFile}, skipping`);
    return;
  }

  await sheets.ensureHeader(sheetId, tab);

  const existing = await sheets.countDataRows(sheetId, tab);
  if (existing > 0 && !force) {
    console.error(
      `- ${lang.id}: tab "${tab}" already has ${existing} row(s). ` +
        `Refusing to import (would duplicate). Re-run with --force to import anyway.`
    );
    return;
  }

  await sheets.appendEntries(sheetId, tab, rows);
  console.log(`- ${lang.id}: imported ${rows.length} word(s) into tab "${tab}" ✔`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const idFilter = args.filter((a) => !a.startsWith("--"));

  if (!sheets.isConfigured()) {
    console.error(
      "Google Sheets credentials not set. Set GOOGLE_SERVICE_ACCOUNT_JSON " +
        "(or GOOGLE_SERVICE_ACCOUNT_FILE) first — see the README."
    );
    process.exit(1);
  }

  let languages = loadLanguages();
  if (idFilter.length) languages = languages.filter((l) => idFilter.includes(l.id));
  if (!languages.length) {
    console.error("No matching languages to migrate.");
    process.exit(1);
  }

  console.log("Migrating words into Google Sheets...");
  for (const lang of languages) {
    try {
      await migrateLanguage(lang, { force });
    } catch (err) {
      console.error(`- ${lang.id}: failed — ${err.message}`);
    }
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
