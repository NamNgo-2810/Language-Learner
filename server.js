require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const sheets = require("./sheets");
const { toPinyin } = require("./pinyin");

const ROOT = __dirname;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
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
// chietu, rowNumber }].
function handleGetWords(req, res, query) {
  if (!sheets.isConfigured()) {
    return sendJSON(res, 500, {
      error: "Google Sheets credentials are not set on the server — see README (GOOGLE_SERVICE_ACCOUNT_JSON)",
    });
  }
  const languageId = String(query.get("languageId") || "");
  if (!languageId) return sendJSON(res, 400, { error: "languageId is required" });

  const target = resolveLanguageTarget(languageId);
  if (target.error) return sendJSON(res, target.status, { error: target.error });

  sheets
    .readEntries(target.sheetId, target.tab)
    .then((entries) => sendJSON(res, 200, { ok: true, entries }))
    .catch((err) => sendJSON(res, 502, { error: err.message || "could not read sheet" }));
}

// POST /api/pinyin { char } — converts a character/word to tone-marked pinyin.
// Pure/local (no network), so it works even without Sheets configured.
function handlePinyin(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    const char = String(data.char || "").trim();
    if (!char) return sendJSON(res, 400, { error: "char is required" });
    try {
      const pinyin = toPinyin(char);
      sendJSON(res, 200, { ok: true, pinyin });
    } catch (err) {
      sendJSON(res, 500, { error: err.message || "pinyin conversion failed" });
    }
  });
}

// POST /api/add-word { languageId, char, sentence? } — appends a row to the
// language's sheet. Pinyin is generated automatically from the character
// server-side; a client-supplied `pinyin` is accepted only as a fallback if
// auto-conversion yields nothing.
function handleAddWord(req, res) {
  if (!sheets.isConfigured()) {
    return sendJSON(res, 500, {
      error: "Google Sheets credentials are not set on the server — see README (GOOGLE_SERVICE_ACCOUNT_JSON)",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e5) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }

    const languageId = String(data.languageId || "");
    const char = String(data.char || "").replace(/[\r\n\t]/g, "").trim();
    const sentence = String(data.sentence || "").replace(/[\r\n\t]/g, "").trim();

    if (!languageId || !char) {
      return sendJSON(res, 400, { error: "languageId and char are required" });
    }

    // Auto-generate pinyin; fall back to a client-provided value if the
    // converter produced nothing (e.g. a non-Han input).
    let pinyin = toPinyin(char);
    if (!pinyin) pinyin = String(data.pinyin || "").replace(/[\r\n\t]/g, "").trim();
    if (!pinyin) {
      return sendJSON(res, 422, { error: "could not derive pinyin for that input" });
    }

    const target = resolveLanguageTarget(languageId);
    if (target.error) return sendJSON(res, target.status, { error: target.error });

    // Generate the chiết tự breakdown once, up front, so it's cached in the
    // sheet from the start and never needs to be requested from Claude again.
    // Best-effort: a failure here (or no API key configured) shouldn't block
    // adding the word — it can still be generated lazily later.
    let chietu = "";
    if (anthropic) {
      try {
        chietu = (await generateChietu(char)).chietu;
      } catch {
        // ignore — will be generated on first flashcard view instead
      }
    }

    try {
      const today = todayLabel();
      const last = await sheets.lastSessionLabel(target.sheetId, target.tab);
      const newSession = last !== today;
      await sheets.appendEntry(target.sheetId, target.tab, {
        char,
        pinyin,
        sentence,
        session: today,
        chietu,
      });
      sendJSON(res, 200, { ok: true, char, pinyin, newSession, sessionLabel: today, chietu: chietu || null });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "write failed" });
    }
  });
}

// Asks Claude for one short beginner-level example sentence using the given
// character/word. Thinking is disabled and effort is low since this is a
// small, low-stakes generation task with no tool use — keeps cost minimal
// (well under a cent per call at Claude Opus 5 list pricing).
async function generateSentence(char, pinyin) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 300,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { sentence: { type: "string" } },
          required: ["sentence"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You write one short, simple example sentence for a Mandarin Chinese beginner (HSK 1-2 level) that naturally uses the given character or word. Reply with only the Chinese sentence itself — no pinyin, no translation, no extra commentary.",
    messages: [
      { role: "user", content: `Character or word: ${char} (pinyin: ${pinyin})` },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate a sentence for this input");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no sentence returned");
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.sentence) throw new Error("no sentence returned");
  return parsed.sentence;
}

function handleGenerateSentence(req, res) {
  if (!anthropic) {
    return sendJSON(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }

    const char = String(data.char || "").trim();
    const pinyin = String(data.pinyin || "").trim();
    if (!char || !pinyin) {
      return sendJSON(res, 400, { error: "char and pinyin are required" });
    }

    try {
      const sentence = await generateSentence(char, pinyin);
      sendJSON(res, 200, { ok: true, sentence });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

// Asks Claude for a short sentence that uses the given target word, broken into
// its word-level chunks in the correct order. The client shuffles `chunks` and
// asks the learner to drag them back into order. `chunks` joined together must
// equal `sentence`, so ordering can be checked exactly.
async function generatePracticeSentence(char, pinyin) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 500,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            sentence: { type: "string" },
            chunks: { type: "array", items: { type: "string" } },
          },
          required: ["sentence", "chunks"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You write one short, simple Mandarin Chinese sentence (HSK 1-3 level) that naturally uses the given character or word. " +
      "Then split that exact sentence into its natural word-level chunks, in order — each chunk is a word or short unit (punctuation may stay attached to the preceding chunk). " +
      "The chunks concatenated in order MUST exactly equal the sentence, with no characters added or removed. Aim for between 3 and 8 chunks. " +
      "Reply with the Chinese sentence and the ordered chunks — no pinyin, no translation, no commentary.",
    messages: [
      { role: "user", content: `Target word: ${char} (pinyin: ${pinyin})` },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate a sentence for this input");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no sentence returned");
  const parsed = JSON.parse(textBlock.text);
  let { sentence, chunks } = parsed;
  if (!sentence || !Array.isArray(chunks) || !chunks.length) {
    throw new Error("no sentence returned");
  }
  // Guard: if the chunks don't reassemble to the sentence, fall back to a
  // per-character split so the drag-and-drop check stays exact.
  if (chunks.join("") !== sentence) {
    chunks = [...sentence];
  }
  return { sentence, chunks, sentencePinyin: toPinyin(sentence) };
}

function handleGeneratePracticeSentence(req, res) {
  if (!anthropic) {
    return sendJSON(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    const char = String(data.char || "").trim();
    const pinyin = String(data.pinyin || "").trim();
    if (!char || !pinyin) {
      return sendJSON(res, 400, { error: "char and pinyin are required" });
    }
    try {
      const result = await generatePracticeSentence(char, pinyin);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

// Asks Claude for a natural sentence that uses the target word, returned as the
// full-pinyin reading of the sentence with the target word's position marked by
// a "＿" blank placeholder. The learner reads the pinyin context and picks the
// correct character (from a set of same-pinyin confusables) that fits.
async function generateConfusableContext(char, pinyin) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 500,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            sentence: { type: "string" },
            pinyin: { type: "string" },
          },
          required: ["sentence", "pinyin"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You write one short, natural Mandarin Chinese sentence (HSK 1-3 level) that uses the given target word in a way that makes its meaning clear from context. " +
      "Return two things: `sentence` = the sentence in Chinese characters, and `pinyin` = the full sentence written in pinyin with tone marks, BUT with the target word replaced by the placeholder ＿ (a full-width underscore). " +
      "Keep pinyin word-spacing natural. Do not reveal the target character anywhere. No translation or commentary.",
    messages: [
      { role: "user", content: `Target word: ${char} (pinyin: ${pinyin})` },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate a sentence for this input");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no sentence returned");
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.sentence || !parsed.pinyin) throw new Error("no sentence returned");
  return { sentence: parsed.sentence, pinyinContext: parsed.pinyin };
}

function handleGenerateConfusableContext(req, res) {
  if (!anthropic) {
    return sendJSON(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    const char = String(data.char || "").trim();
    const pinyin = String(data.pinyin || "").trim();
    if (!char || !pinyin) {
      return sendJSON(res, 400, { error: "char and pinyin are required" });
    }
    try {
      const result = await generateConfusableContext(char, pinyin);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

// Asks Claude for the Hán Việt (Sino-Vietnamese) reading of a Chinese character
// or word — the Vietnamese pronunciation historically borrowed for that Han
// character, distinct from its Mandarin pinyin. Used to help Vietnamese-speaking
// learners recognize the character via a reading they may already know.
async function generateHanViet(char) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 100,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { hanViet: { type: "string" } },
          required: ["hanViet"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You give the Hán Việt (Sino-Vietnamese) reading of a Chinese character or word — the traditional Vietnamese pronunciation for that Han character, NOT a translation of its meaning. " +
      "For a multi-character word, give the Hán Việt reading of each character in order, separated by spaces. Reply with just the reading, no commentary.",
    messages: [{ role: "user", content: char }],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate a Hán Việt reading for this input");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no reading returned");
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.hanViet) throw new Error("no reading returned");
  return { hanViet: parsed.hanViet };
}

// Asks Claude for a chiết tự (character component) breakdown of a Chinese
// character or word — how it decomposes into its radical/component parts and
// how those parts combine to give the character's meaning. Used to help
// learners memorize characters through their structure rather than rote
// repetition.
async function generateChietu(char) {
  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 300,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { chietu: { type: "string" } },
          required: ["chietu"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You give a chiết tự (character component / radical) breakdown of a Chinese character or word, for a Vietnamese-speaking learner of Chinese. " +
      "For each character, list its components (radicals/parts) with their individual meaning, then briefly explain how those components combine to suggest the character's overall meaning. " +
      "For a multi-character word, do this for each character in order, separated by ' | '. " +
      "Keep it concise — a phrase or short sentence per character, not a lecture. Reply with just the breakdown, no extra commentary.",
    messages: [{ role: "user", content: char }],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate a component breakdown for this input");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no breakdown returned");
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.chietu) throw new Error("no breakdown returned");
  return { chietu: parsed.chietu };
}

// POST /api/chietu { languageId, char } — returns the chiết tự breakdown for
// a character, preferring the cache stored in the word's sheet row (column H)
// over asking Claude again. Only new characters (no cached value yet) hit the
// model; the result is then written back to that row so it's cached for
// every future view, in this session and beyond.
function handleGenerateChietu(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    const char = String(data.char || "").trim();
    const languageId = String(data.languageId || "").trim();
    if (!char) return sendJSON(res, 400, { error: "char is required" });

    // Look up the word's row so we can reuse an already-cached breakdown, or
    // save a freshly generated one back to it.
    let target = null;
    let row = null;
    if (languageId && sheets.isConfigured()) {
      target = resolveLanguageTarget(languageId);
      if (target.error) target = null; // fall through to a stateless generation below
      if (target) {
        try {
          const entries = await sheets.readEntries(target.sheetId, target.tab);
          row = entries.find((e) => e.char === char) || null;
        } catch {
          // sheet read failed — fall back to a stateless generation below
        }
      }
    }

    if (row && row.chietu) {
      return sendJSON(res, 200, { ok: true, chietu: row.chietu });
    }

    if (!anthropic) {
      return sendJSON(res, 500, {
        error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
      });
    }
    try {
      const result = await generateChietu(char);
      if (target && row) {
        try {
          await sheets.updateChietu(target.sheetId, target.tab, row.rowNumber, result.chietu);
        } catch {
          // the learner still gets their answer even if the write-back fails;
          // it'll just be regenerated next time
        }
      }
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

function handleGenerateHanViet(req, res) {
  if (!anthropic) {
    return sendJSON(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e4) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }
    const char = String(data.char || "").trim();
    if (!char) return sendJSON(res, 400, { error: "char is required" });
    try {
      const result = await generateHanViet(char);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

// Asks Claude for a story or conversation that weaves in the given vocabulary.
// Caller-controlled: `hskLevel` (1-6) sets the vocabulary/grammar ceiling,
// `length` is the target number of sentences (or exchanges for a conversation),
// and `format` is "story" or "conversation". Thinking is left on (the default)
// since fitting many words together at a target level is a real
// constraint-satisfaction task, unlike the single-word sentence generator.
async function generateReviewStory(words, hskLevel, length, format) {
  const wordList = words.map((w) => `${w.char} (${w.pinyin})`).join(", ");

  const message = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { story: { type: "string" } },
          required: ["story"],
          additionalProperties: false,
        },
      },
    },
    system:
      (format === "conversation"
        ? `You write a short, natural conversation (dialogue) in Mandarin Chinese between two people at approximately HSK level ${hskLevel} (on the 1-6 scale, where 1 is absolute beginner and 6 is advanced) — keep the vocabulary and grammar at or below that level. ` +
          `Aim for about ${length} lines of dialogue. Prefix each line with the speaker, e.g. "A：" and "B：", each line on its own line. `
        : `You write a short story in Mandarin Chinese at approximately HSK level ${hskLevel} (on the 1-6 scale, where 1 is absolute beginner and 6 is advanced) — keep the vocabulary and grammar at or below that level. ` +
          `Aim for about ${length} sentence${length === 1 ? "" : "s"}. `) +
      "Naturally weave in as many of the learner's vocabulary words as fit comfortably at that level — you don't have to use all of them, and you may freely use other words the text needs. Never force an awkward line just to include a word. " +
      "Reply with the Chinese characters only — no pinyin, no translation, no extra commentary.",
    messages: [
      { role: "user", content: `The learner's vocabulary words: ${wordList}` },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("the model declined to generate text for this word list");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no story returned");
  const parsed = JSON.parse(textBlock.text);
  if (!parsed.story) throw new Error("no story returned");
  return { story: parsed.story };
}

function handleGenerateReviewStory(req, res) {
  if (!anthropic) {
    return sendJSON(res, 500, {
      error: "ANTHROPIC_API_KEY is not set on the server — export it before running npm start",
    });
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2e5) req.destroy();
  });
  req.on("end", async () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }

    const words = Array.isArray(data.words) ? data.words : [];
    const cleaned = words
      .map((w) => ({
        char: String((w && w.char) || "").trim(),
        pinyin: String((w && w.pinyin) || "").trim(),
      }))
      .filter((w) => w.char && w.pinyin);

    if (!cleaned.length) {
      return sendJSON(res, 400, { error: "words (array of {char, pinyin}) is required" });
    }

    // Difficulty controls, clamped to sane ranges regardless of client input.
    const hskLevel = Math.min(6, Math.max(1, Math.round(Number(data.hskLevel) || 3)));
    const length = Math.min(20, Math.max(1, Math.round(Number(data.length) || 5)));
    const format = data.format === "conversation" ? "conversation" : "story";

    try {
      const result = await generateReviewStory(cleaned, hskLevel, length, format);
      sendJSON(res, 200, { ok: true, format, ...result });
    } catch (err) {
      sendJSON(res, 502, { error: err.message || "generation failed" });
    }
  });
}

// Files that must never be served to the browser: server-side config and any
// credentials. Word data now lives in Google Sheets, so the old .md files (if
// still present) and languages.json are no longer client-fetched.
const BLOCKED_STATIC = new Set(["languages.json", "package.json", "package-lock.json", ".env"]);

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

  if (req.method === "GET" && pathname === "/api/languages") {
    return handleGetLanguages(req, res);
  }
  if (req.method === "GET" && pathname === "/api/words") {
    return handleGetWords(req, res, parsedUrl.searchParams);
  }
  if (req.method === "POST" && pathname === "/api/pinyin") {
    return handlePinyin(req, res);
  }
  if (req.method === "POST" && pathname === "/api/add-word") {
    return handleAddWord(req, res);
  }
  if (req.method === "POST" && pathname === "/api/generate-sentence") {
    return handleGenerateSentence(req, res);
  }
  if (req.method === "POST" && pathname === "/api/generate-practice-sentence") {
    return handleGeneratePracticeSentence(req, res);
  }
  if (req.method === "POST" && pathname === "/api/generate-confusable-context") {
    return handleGenerateConfusableContext(req, res);
  }
  if (req.method === "POST" && pathname === "/api/hanviet") {
    return handleGenerateHanViet(req, res);
  }
  if (req.method === "POST" && pathname === "/api/chietu") {
    return handleGenerateChietu(req, res);
  }
  if (req.method === "POST" && pathname === "/api/generate-review-story") {
    return handleGenerateReviewStory(req, res);
  }
  if (req.method === "GET") {
    return serveStatic(req, res);
  }
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
