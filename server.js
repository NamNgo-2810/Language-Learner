require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sheets = require("./sheets");
const { toPinyin, pinyinVariants } = require("./pinyin");

// This server has no AI of its own. Every Claude call (sentences, stories,
// Hán Việt, chiết tự, grammar, writing tasks and grading) is made by the
// browser to local-bridge.js on the learner's machine, which runs the Claude
// Code CLI. The results that need to persist are sent back here to be saved
// in the sheet (see /api/add-word, /api/save-word-info, /api/save-grammar).

const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// Constant-time string compare, tolerant of mismatched lengths (still does a
// dummy comparison so a wrong-length guess takes the same time as a right-length one).
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// HTTP Basic Auth gate. If APP_USERNAME/APP_PASSWORD aren't set, auth is
// skipped (local dev only) — always set both before deploying anywhere public.
function isAuthorized(req) {
  const user = process.env.APP_USERNAME;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) return true;

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;

  const providedUser = decoded.slice(0, sep);
  const providedPass = decoded.slice(sep + 1);
  return safeEqual(providedUser, user) && safeEqual(providedPass, pass);
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Reads a JSON body (capped at `limit` bytes) and hands it to `fn`, or
// answers 400 for malformed JSON.
function withJSONBody(req, res, limit, fn) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > limit) req.destroy();
  });
  req.on("end", () => {
    let data;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    fn(data || {});
  });
}

function loadLanguages() {
  const raw = fs.readFileSync(path.join(ROOT, "languages.json"), "utf8");
  return JSON.parse(raw);
}

function todayLabel() {
  return new Date().toISOString().slice(0, 10);
}

// Resolves the spreadsheet ID for a language. An env var can override the value
// in languages.json so credentials/IDs stay out of the committed file:
//   GOOGLE_SHEET_ID_<UPPERCASE_LANGUAGE_ID>  (e.g. GOOGLE_SHEET_ID_MANDARIN)
//   GOOGLE_SHEET_ID                          (fallback for a single-language setup)
// Returns null if nothing usable is configured (placeholder counts as unset).
function resolveSheetId(lang) {
  const perLang = process.env[`GOOGLE_SHEET_ID_${lang.id.toUpperCase()}`];
  const generic = process.env.GOOGLE_SHEET_ID;
  const candidate = (perLang || generic || lang.sheetId || "").trim();
  if (!candidate || candidate === "PASTE_YOUR_GOOGLE_SHEET_ID_HERE") return null;
  return candidate;
}

// Looks up a language by id and resolves its sheet target. Returns
// { lang, sheetId, tab } or an { error, status } object to send back.
function resolveLanguageTarget(languageId) {
  let languages;
  try {
    languages = loadLanguages();
  } catch {
    return { error: "could not read languages.json", status: 500 };
  }
  const lang = languages.find((l) => l.id === languageId);
  if (!lang) return { error: "unknown language", status: 404 };

  const sheetId = resolveSheetId(lang);
  if (!sheetId) {
    return {
      error: `no Google Sheet configured for "${languageId}" — set its sheetId in languages.json or a GOOGLE_SHEET_ID env var`,
      status: 500,
    };
  }
  return { lang, sheetId, tab: lang.tab || lang.id };
}

const SHEETS_NOT_CONFIGURED =
  "Google Sheets credentials are not set on the server — see README (GOOGLE_SERVICE_ACCOUNT_JSON)";

// ---------- validation of AI results sent by the browser ----------

// The browser relays what local-bridge.js generated. It's behind the same
// login as everything else, but still clean it before it lands in the sheet.
function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

// An array of up to 3 { pattern, meaning, example }, or null when the value
// isn't an array (null means "not scanned yet" in the sheet).
function cleanGrammar(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((g) => g && typeof g === "object" && cleanText(g.pattern, 100))
    .slice(0, 3)
    .map((g) => ({
      pattern: cleanText(g.pattern, 100),
      meaning: cleanText(g.meaning, 400),
      example: cleanText(g.example, 200),
    }));
}

const MAX_CHIETU = 2000;
const MAX_HANVIET = 200;

// ---------- handlers ----------

// GET /api/languages — the language picker list, without exposing sheet IDs.
function handleGetLanguages(req, res) {
  let languages;
  try {
    languages = loadLanguages();
  } catch {
    return sendJSON(res, 500, { error: "could not read languages.json" });
  }
  const list = languages.map((l) => ({ id: l.id, name: l.name }));
  sendJSON(res, 200, { ok: true, languages: list });
}

// GET /api/words?languageId=xxx — returns the language's words from its sheet
// as parsed entries: [{ char, pinyin, sentence, sessionIndex, sessionLabel,
// chietu, hanViet, grammar, rowNumber, pinyinVariants? }]. Multi-character
// words also carry pinyinVariants (see pinyin.js) for multiple-choice distractors.
function handleGetWords(req, res, query) {
  if (!sheets.isConfigured()) return sendJSON(res, 500, { error: SHEETS_NOT_CONFIGURED });
  const languageId = String(query.get("languageId") || "");
  if (!languageId) return sendJSON(res, 400, { error: "languageId is required" });

  const target = resolveLanguageTarget(languageId);
  if (target.error) return sendJSON(res, target.status, { error: target.error });

  sheets
    .readEntries(target.sheetId, target.tab)
    .then((entries) => {
      entries.forEach((e) => {
        const variants = pinyinVariants(e.char, e.pinyin);
        if (variants.length) e.pinyinVariants = variants;
      });
      sendJSON(res, 200, { ok: true, entries });
    })
    .catch((err) => sendJSON(res, 502, { error: err.message || "could not read sheet" }));
}

// POST /api/pinyin { char } — converts a character/word to tone-marked pinyin.
// Pure/local (no network), so it works even without Sheets configured.
function handlePinyin(req, res) {
  withJSONBody(req, res, 1e4, (data) => {
    const char = String(data.char || "").trim();
    if (!char) return sendJSON(res, 400, { error: "char is required" });
    try {
      sendJSON(res, 200, { ok: true, pinyin: toPinyin(char) });
    } catch (err) {
      sendJSON(res, 500, { error: err.message || "pinyin conversion failed" });
    }
  });
}

// The session label (date) of the most recently added row, or null.
function lastSessionLabelOf(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sessionLabel) return entries[i].sessionLabel;
  }
  return null;
}

// POST /api/add-word { languageId, char, sentence?, pinyin?, chietu?, hanViet?, grammar? }
// Appends a row to the language's sheet. Pinyin is generated here from the
// character; a client-supplied `pinyin` is only a fallback if conversion
// yields nothing. chietu / hanViet / grammar are what the browser got from
// local-bridge.js before saving; any of them may be missing (bridge not
// running), in which case they're filled in later.
function handleAddWord(req, res) {
  if (!sheets.isConfigured()) return sendJSON(res, 500, { error: SHEETS_NOT_CONFIGURED });
  withJSONBody(req, res, 1e5, async (data) => {
    const languageId = String(data.languageId || "");
    const char = cleanText(data.char, 30);
    const sentence = cleanText(data.sentence, 500);
    if (!languageId || !char) return sendJSON(res, 400, { error: "languageId and char are required" });

    let pinyin = toPinyin(char);
    if (!pinyin) pinyin = cleanText(data.pinyin, 80);
    if (!pinyin) return sendJSON(res, 422, { error: "could not derive pinyin for that input" });

    const chietu = cleanText(data.chietu, MAX_CHIETU);
    const hanViet = cleanText(data.hanViet, MAX_HANVIET);
    const grammar = cleanGrammar(data.grammar);

    const target = resolveLanguageTarget(languageId);
    if (target.error) return sendJSON(res, target.status, { error: target.error });

    let entries;
    try {
      entries = await sheets.readEntries(target.sheetId, target.tab);
    } catch (err) {
      return sendJSON(res, 502, { error: err.message || "could not read sheet" });
    }

    try {
      const today = todayLabel();
      const newSession = lastSessionLabelOf(entries) !== today;
      await sheets.appendEntry(target.sheetId, target.tab, {
        char,
        pinyin,
        sentence,
        session: today,
        chietu,
        hanViet,
        grammar,
      });
      sendJSON(res, 200, {
        ok: true,
        char,
        pinyin,
        newSession,
        sessionLabel: today,
        chietu: chietu || null,
        hanViet: hanViet || null,
        grammar,
        pinyinVariants: pinyinVariants(char, pinyin),
      });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "write failed" });
    }
  });
}

// POST /api/save-word-info { languageId, char, hanViet?, chietu?, grammar? }
// Saves generated values for every row of `char`. Only the fields present in
// the body are written, so a lazily fetched Hán Việt doesn't wipe the chiết tự.
// Used for flashcard Hán Việt / chiết tự and for "regenerate word".
function handleSaveWordInfo(req, res) {
  if (!sheets.isConfigured()) return sendJSON(res, 500, { error: SHEETS_NOT_CONFIGURED });
  withJSONBody(req, res, 5e4, async (data) => {
    const char = cleanText(data.char, 30);
    if (!char) return sendJSON(res, 400, { error: "char is required" });
    const target = resolveLanguageTarget(String(data.languageId || ""));
    if (target.error) return sendJSON(res, target.status, { error: target.error });

    const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
    const hanViet = has("hanViet") ? cleanText(data.hanViet, MAX_HANVIET) : undefined;
    const chietu = has("chietu") ? cleanText(data.chietu, MAX_CHIETU) : undefined;
    const grammar = has("grammar") ? cleanGrammar(data.grammar) : undefined;
    if (hanViet === undefined && chietu === undefined && grammar === undefined) {
      return sendJSON(res, 400, { error: "nothing to save — send hanViet, chietu and/or grammar" });
    }

    try {
      const entries = await sheets.readEntries(target.sheetId, target.tab);
      const rows = entries.filter((e) => e.char === char);
      if (!rows.length) return sendJSON(res, 404, { error: `${char} isn't in the sheet` });

      if (hanViet !== undefined && chietu !== undefined && grammar !== undefined) {
        // All three at once (regenerate): one write per row.
        for (const row of rows) {
          await sheets.updateWordInfo(target.sheetId, target.tab, row.rowNumber, { hanViet, chietu, grammar });
        }
      } else {
        for (const row of rows) {
          if (hanViet !== undefined) await sheets.updateHanViet(target.sheetId, target.tab, row.rowNumber, hanViet);
          if (chietu !== undefined) await sheets.updateChietu(target.sheetId, target.tab, row.rowNumber, chietu);
        }
        if (grammar) {
          await sheets.updateGrammarBatch(
            target.sheetId,
            target.tab,
            rows.map((row) => ({ rowNumber: row.rowNumber, grammar }))
          );
        }
      }
      sendJSON(res, 200, { ok: true, rows: rows.length });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "save failed" });
    }
  });
}

// POST /api/save-grammar { languageId, words: [{ char, grammar }] } — records
// a grammar scan: each listed word's not-yet-scanned rows get its structures
// (an empty array means "scanned, none found"). Rows that already have
// grammar are left alone. Returns how many rows were written.
function handleSaveGrammar(req, res) {
  if (!sheets.isConfigured()) return sendJSON(res, 500, { error: SHEETS_NOT_CONFIGURED });
  withJSONBody(req, res, 1e6, async (data) => {
    const target = resolveLanguageTarget(String(data.languageId || ""));
    if (target.error) return sendJSON(res, target.status, { error: target.error });

    const byChar = new Map();
    (Array.isArray(data.words) ? data.words : []).slice(0, 2000).forEach((w) => {
      const char = cleanText(w && w.char, 30);
      const grammar = cleanGrammar(w && w.grammar);
      if (char && grammar) byChar.set(char, grammar);
    });
    if (!byChar.size) return sendJSON(res, 400, { error: "words (array of { char, grammar }) is required" });

    try {
      const entries = await sheets.readEntries(target.sheetId, target.tab);
      const updates = entries
        .filter((e) => e.grammar === null && byChar.has(e.char))
        .map((e) => ({ rowNumber: e.rowNumber, grammar: byChar.get(e.char) }));
      await sheets.updateGrammarBatch(target.sheetId, target.tab, updates);
      sendJSON(res, 200, { ok: true, rows: updates.length });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "save failed" });
    }
  });
}

// Files that must never be served to the browser: server-side config and any
// credentials. Word data now lives in Google Sheets, so the old .md files (if
// still present) and languages.json are no longer client-fetched. The bridge
// script and the Claude Code installer are local tools, not app assets.
const BLOCKED_STATIC = new Set([
  "languages.json", "package.json", "package-lock.json", ".env",
  "server.js", "sheets.js", "migrate-to-sheet.js", "local-bridge.js", "install.cmd", "render.yaml",
]);

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  // Block config/credential files and any service-account key JSON.
  if (BLOCKED_STATIC.has(base) || ext === ".md" || base.includes("service-account") || base.includes("credentials")) {
    res.writeHead(404);
    return res.end("not found");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Learn Languages"' });
    return res.end("Authentication required");
  }

  const parsedUrl = new URL(req.url, "http://localhost");
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/languages") return handleGetLanguages(req, res);
  if (req.method === "GET" && pathname === "/api/words") return handleGetWords(req, res, parsedUrl.searchParams);
  if (req.method === "POST" && pathname === "/api/pinyin") return handlePinyin(req, res);
  if (req.method === "POST" && pathname === "/api/add-word") return handleAddWord(req, res);
  if (req.method === "POST" && pathname === "/api/save-word-info") return handleSaveWordInfo(req, res);
  if (req.method === "POST" && pathname === "/api/save-grammar") return handleSaveGrammar(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405);
  res.end("method not allowed");
});

if (!process.env.APP_USERNAME || !process.env.APP_PASSWORD) {
  console.warn(
    "WARNING: APP_USERNAME / APP_PASSWORD not set — the app is running with no login. " +
      "Fine for local-only use; set both before deploying anywhere reachable from the internet."
  );
}

if (!sheets.isConfigured()) {
  console.warn(
    "WARNING: Google Sheets credentials not set (GOOGLE_SERVICE_ACCOUNT_JSON or " +
      "GOOGLE_SERVICE_ACCOUNT_FILE) — loading and adding words will fail until they're set. See README."
  );
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Learn Languages running at http://localhost:${PORT}`);
});
