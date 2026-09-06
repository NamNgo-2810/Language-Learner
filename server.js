require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

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

// Appends "char pinyin" (optionally "| sentence") to the file, opening a new
// "## YYYY-MM-DD" session header if the file's last header isn't today's.
function appendEntry(filePath, char, pinyin, sentence) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    content = "";
  }

  const headerRegex = /^##\s+(.+)$/gm;
  let lastHeader = null;
  let match;
  while ((match = headerRegex.exec(content))) {
    lastHeader = match[1].trim();
  }

  const today = todayLabel();
  const newSession = lastHeader !== today;

  let toAppend = "";
  if (content.length > 0 && !content.endsWith("\n")) toAppend += "\n";
  if (newSession) {
    if (content.trim().length > 0) toAppend += "\n";
    toAppend += `## ${today}\n`;
  }
  const line = sentence ? `${char} ${pinyin} | ${sentence}` : `${char} ${pinyin}`;
  toAppend += `${line}\n`;

  fs.appendFileSync(filePath, toAppend);
  return { newSession, sessionLabel: today };
}

function handleAddWord(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e5) req.destroy();
  });
  req.on("end", () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return sendJSON(res, 400, { error: "invalid JSON" });
    }

    const languageId = String(data.languageId || "");
    const char = String(data.char || "").replace(/[\r\n\t]/g, "").trim();
    const pinyin = String(data.pinyin || "").replace(/[\r\n\t]/g, "").trim();
    const sentence = String(data.sentence || "").replace(/[\r\n\t|]/g, "").trim();

    if (!languageId || !char || !pinyin) {
      return sendJSON(res, 400, { error: "languageId, char and pinyin are required" });
    }

    let languages;
    try {
      languages = loadLanguages();
    } catch {
      return sendJSON(res, 500, { error: "could not read languages.json" });
    }

    const lang = languages.find((l) => l.id === languageId);
    if (!lang) return sendJSON(res, 404, { error: "unknown language" });

    const filePath = path.join(ROOT, lang.file);
    if (!filePath.startsWith(ROOT)) return sendJSON(res, 400, { error: "invalid file" });

    try {
      const { newSession, sessionLabel } = appendEntry(filePath, char, pinyin, sentence);
      sendJSON(res, 200, { ok: true, newSession, sessionLabel });
    } catch {
      sendJSON(res, 500, { error: "write failed" });
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

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, relative);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("forbidden");
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

  if (req.method === "POST" && req.url === "/api/add-word") {
    return handleAddWord(req, res);
  }
  if (req.method === "POST" && req.url === "/api/generate-sentence") {
    return handleGenerateSentence(req, res);
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Learn Languages running at http://localhost:${PORT}`);
});
