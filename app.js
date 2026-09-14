const STORAGE_KEY = "lang-learner-stats-v1";
const SESSION_CAP = 20;

const state = {
  languages: [],
  currentLanguage: null,
  entries: [],       // [{char, pinyin, sentence, sessionIndex, sessionLabel}] for the active language
  mode: null,
  queue: [],         // question objects for the current run
  index: 0,
  missed: [],        // entries missed during this run
  correctCount: 0,
};

const el = (id) => document.getElementById(id);

const screens = {
  language: el("screen-language"),
  mode: el("screen-mode"),
  add: el("screen-add"),
  quiz: el("screen-quiz"),
  story: el("screen-story"),
  results: el("screen-results"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// ---------- stats persistence ----------

function loadStats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

// How fast a "fluent" recall is (ms) vs. a "struggling" one. Answers at or
// under FAST_MS count as fully fast; at or over SLOW_MS as fully slow; linear
// in between. Tuned for typing tone-marked/numbered pinyin.
const FAST_MS = 2500;
const SLOW_MS = 12000;

// Records a quiz result. `elapsedMs` (optional) is how long a *correct* typed
// answer took; it feeds a running average (EMA) used for the remembering score
// and to resurface slow-but-correct words. Old records ({seen,wrong}) upgrade
// transparently.
function recordResult(languageId, char, known, elapsedMs) {
  const stats = loadStats();
  stats[languageId] = stats[languageId] || {};
  const rec = stats[languageId][char] || { seen: 0, wrong: 0 };
  rec.seen += 1;
  if (!known) rec.wrong += 1;

  if (typeof elapsedMs === "number" && isFinite(elapsedMs) && elapsedMs > 0) {
    const clamped = Math.min(elapsedMs, 60000); // ignore afk-long outliers
    // Exponential moving average so recent speed matters more than ancient reps.
    rec.avgMs = rec.avgMs ? Math.round(rec.avgMs * 0.6 + clamped * 0.4) : Math.round(clamped);
    rec.timedReps = (rec.timedReps || 0) + 1;
  }

  rec.lastSeen = Date.now();
  stats[languageId][char] = rec;
  saveStats(stats);
}

// 0 (fast) .. 1 (slow) from an average response time; 0 if never timed.
function slownessFactor(rec) {
  if (!rec || !rec.avgMs) return 0;
  const t = (rec.avgMs - FAST_MS) / (SLOW_MS - FAST_MS);
  return Math.max(0, Math.min(1, t));
}

// A 0-100 "how well do I remember this" score, combining accuracy and speed.
// Returns null for words with no quiz history so the UI can show "new".
function rememberingLevel(rec) {
  if (!rec || !rec.seen) return null;
  const accuracy = (rec.seen - rec.wrong) / rec.seen; // 0..1
  const speed = 1 - slownessFactor(rec); // 1 fast .. 0 slow
  // If we have timing, weight accuracy 60% / speed 40%; otherwise accuracy only.
  const score = rec.avgMs ? accuracy * 0.6 + speed * 0.4 : accuracy;
  return Math.round(score * 100);
}

function statFor(char) {
  const stats = loadStats();
  return (stats[state.currentLanguage.id] && stats[state.currentLanguage.id][char]) || null;
}

// weight favors words you've gotten wrong before, words never quizzed yet,
// words you're slow to recall, and words from the most recent class session(s)
function computeWeight(entry, maxSessionIndex) {
  const rec = statFor(entry.char);
  const wrongBoost = rec ? rec.wrong * 3 : 0;
  const unseenBoost = rec ? 0 : 2;
  const slowBoost = rec ? slownessFactor(rec) * 3 : 0; // slow-but-correct resurfaces
  let recencyBoost = 0;
  if (entry.sessionIndex >= 0 && maxSessionIndex >= 0) {
    if (entry.sessionIndex === maxSessionIndex) recencyBoost = 4;
    else if (entry.sessionIndex === maxSessionIndex - 1) recencyBoost = 2;
  }
  return 1 + wrongBoost + unseenBoost + slowBoost + recencyBoost;
}

// ---------- parsing ----------
// Format per line: "char pinyin" or "char pinyin | example sentence"
// Optional "## label" lines mark the start of a new class session, used to
// figure out which words were learned most recently.

function parseEntries(raw) {
  const entries = [];
  let sessionIndex = -1;
  let sessionLabel = null;

  raw.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      sessionIndex++;
      sessionLabel = headerMatch[1].trim();
      return;
    }

    // strip common markdown list prefixes like "1. ", "- ", "* "
    const cleaned = line.replace(/^(\d+[.)]|[-*])\s*/, "");
    const [main, sentencePart] = cleaned.split("|").map((s) => s.trim());
    const match = main.match(/^(\S+)\s+(.+)$/);
    if (!match) return;

    entries.push({
      char: match[1],
      pinyin: match[2].trim(),
      sentence: sentencePart || null,
      sessionIndex,
      sessionLabel,
    });
  });

  return entries;
}

function maxSessionIndex(entries) {
  return entries.reduce((max, e) => Math.max(max, e.sessionIndex), -1);
}

// groups of entries that share the same pinyin once tones are stripped
function confusableGroups(entries) {
  const byPinyin = new Map();
  entries.forEach((e) => {
    const key = normalizePinyin(e.pinyin);
    if (!byPinyin.has(key)) byPinyin.set(key, []);
    byPinyin.get(key).push(e);
  });
  return [...byPinyin.values()].filter((group) => group.length > 1);
}

function confusablesFor(entry, entries) {
  const key = normalizePinyin(entry.pinyin);
  return entries.filter((e) => e.char !== entry.char && normalizePinyin(e.pinyin) === key);
}

// ---------- init ----------

async function init() {
  try {
    const res = await fetch("/api/languages");
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "could not load languages");
    state.languages = data.languages;
  } catch (err) {
    state.languages = [];
    console.error("Failed to load languages:", err);
  }
  renderLanguageList();
  showScreen("language");
  bindStaticEvents();
}

function renderLanguageList() {
  const container = el("language-list");
  container.innerHTML = "";
  state.languages.forEach((lang) => {
    const btn = document.createElement("button");
    btn.className = "lang-card";
    btn.innerHTML = `<span style="font-size:1.4rem">\u{1F5E3}️</span><span>${lang.name}</span>`;
    btn.addEventListener("click", () => selectLanguage(lang));
    container.appendChild(btn);
  });
}

async function selectLanguage(lang) {
  state.currentLanguage = lang;
  try {
    const res = await fetch(`/api/words?languageId=${encodeURIComponent(lang.id)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "could not load words");
    state.entries = data.entries || [];
  } catch (err) {
    state.entries = [];
    alert(`Couldn't load words for ${lang.name}: ${err.message}`);
  }
  refreshModeScreen();
  showScreen("mode");
}

function refreshModeScreen() {
  el("mode-lang-title").textContent = state.currentLanguage.name;
  const withSentence = state.entries.filter((e) => e.sentence).length;
  const confusableCount = confusableGroups(state.entries).reduce((sum, g) => sum + g.length, 0);
  el("mode-count").textContent =
    `${state.entries.length} characters loaded · ${withSentence} with example sentences · ${confusableCount} in confusable pairs`;
}

function bindStaticEvents() {
  el("back-to-language").addEventListener("click", () => showScreen("language"));
  el("back-to-modes").addEventListener("click", () => showScreen("mode"));
  el("quit-quiz").addEventListener("click", () => showScreen("mode"));

  document.querySelectorAll(".mode-card").forEach((btn) => {
    btn.addEventListener("click", () => launchMode(btn.dataset.mode));
  });

  el("flip-btn").addEventListener("click", flipFlashcard);
  document.querySelectorAll(".fc-rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => answerFlashcard(btn.dataset.know === "1"));
  });

  el("typing-submit").addEventListener("click", submitTyping);
  el("typing-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitTyping();
  });

  el("hint-btn").addEventListener("click", showWritingHint);
  el("show-answer-btn").addEventListener("click", showWritingAnswer);
  el("writing-sentence-btn").addEventListener("click", showWritingSentenceHint);
  document.querySelectorAll(".wr-rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => answerWriting(btn.dataset.know === "1"));
  });

  el("dnd-check-btn").addEventListener("click", checkSentenceOrder);
  el("dnd-reset-btn").addEventListener("click", resetSentenceBuilder);
  el("dnd-next-btn").addEventListener("click", advance);

  el("retry-missed").addEventListener("click", () => {
    const missed = state.missed.map((e) => e);
    beginQuiz(state.mode, missed, { skipCap: true });
  });

  el("go-to-add").addEventListener("click", () => {
    el("add-lang-name").textContent = state.currentLanguage.name;
    el("add-feedback").textContent = "";
    el("add-feedback").className = "";
    el("add-recent").innerHTML = "";
    el("add-char").value = "";
    el("add-pinyin").value = "";
    el("add-sentence").value = "";
    el("add-confusable-warning").classList.add("hidden");
    showScreen("add");
    el("add-char").focus();
  });
  el("back-to-modes-from-add").addEventListener("click", () => {
    refreshModeScreen();
    showScreen("mode");
  });
  el("add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitNewCharacter();
  });
  el("add-char").addEventListener("input", autoFillPinyin);
  el("generate-sentence-btn").addEventListener("click", generateSentenceForAdd);

  el("generate-story-btn").addEventListener("click", generateReviewStory);
  el("story-format").addEventListener("change", updateStoryLengthLabel);
  el("speak-story-btn").addEventListener("click", toggleSpeakStory);
  el("back-from-story-btn").addEventListener("click", () => {
    stopSpeaking();
    showScreen("mode");
  });

  bindStoryPinyinLookup();
}

// ---------- mode launch (filters the pool per mode, then starts the quiz) ----------

function launchMode(mode) {
  if (mode === "story") {
    startReviewStory();
  } else if (mode === "confusables") {
    const pool = confusableGroups(state.entries).flat();
    if (!pool.length) {
      alert("No confusable pairs found yet — add more characters that share a pinyin to unlock this mode.");
      return;
    }
    beginQuiz(mode, pool);
  } else if (mode === "sentence") {
    if (!state.entries.length) {
      alert("No words yet — add some characters first.");
      return;
    }
    beginQuiz(mode, state.entries);
  } else {
    beginQuiz(mode, state.entries);
  }
}

// ---------- quiz setup ----------

function weightedShuffle(entries) {
  const maxIdx = maxSessionIndex(state.entries);
  const withWeight = entries.map((e) => ({ e, w: computeWeight(e, maxIdx) }));
  const result = [];
  const pool = [...withWeight];
  while (pool.length) {
    const total = pool.reduce((sum, item) => sum + item.w, 0);
    let r = Math.random() * total;
    let i = 0;
    while (r > pool[i].w) {
      r -= pool[i].w;
      i++;
    }
    result.push(pool[i].e);
    pool.splice(i, 1);
  }
  return result;
}

function beginQuiz(mode, entries, { skipCap = false } = {}) {
  if (!entries.length) return;
  const studyAll = skipCap || el("study-all-toggle").checked;
  let queue = weightedShuffle(entries);
  if (!studyAll) queue = queue.slice(0, SESSION_CAP);

  state.mode = mode;
  state.queue = queue;
  state.index = 0;
  state.missed = [];
  state.correctCount = 0;
  showScreen("quiz");
  renderQuestion();
}

function currentEntry() {
  return state.queue[state.index];
}

function updateProgress() {
  const pct = (state.index / state.queue.length) * 100;
  el("progress-fill").style.width = `${pct}%`;
  el("progress-label").textContent = `${state.index + 1} / ${state.queue.length}`;
}

function sentenceBlankHTML(entry) {
  const blanked = entry.sentence.split(entry.char).join('<span class="blank">___</span>');
  return blanked;
}

function sentenceHighlightHTML(entry) {
  return entry.sentence.split(entry.char).join(`<span class="target">${entry.char}</span>`);
}

function setSubprompt(html) {
  const sub = el("quiz-subprompt");
  if (!html) {
    sub.classList.add("hidden");
    sub.innerHTML = "";
  } else {
    sub.classList.remove("hidden");
    sub.innerHTML = html;
  }
}

function renderQuestion() {
  updateProgress();
  const entry = currentEntry();

  el("flashcard-area").classList.add("hidden");
  el("mc-area").classList.add("hidden");
  el("typing-area").classList.add("hidden");
  el("writing-area").classList.add("hidden");
  el("dragdrop-area").classList.add("hidden");
  setSubprompt(null);

  // Timestamp used to measure how long the learner takes to answer (used by the
  // typing mode's timing-based remembering score).
  state.questionStart = Date.now();

  if (state.mode === "flashcard") {
    el("quiz-prompt").className = "prompt";
    el("quiz-prompt").textContent = entry.char;
    el("flashcard-area").classList.remove("hidden");
    el("flashcard-answer").textContent = "";
    el("flashcard-hanviet").classList.add("hidden");
    el("flashcard-hanviet").textContent = "";
    el("flashcard-sentence").classList.add("hidden");
    el("flashcard-sentence").innerHTML = "";
    el("flip-btn").classList.remove("hidden");
    el("flashcard-rate").classList.add("hidden");
  } else if (state.mode === "mc-pinyin") {
    el("quiz-prompt").className = "prompt";
    el("quiz-prompt").textContent = entry.char;
    renderMultipleChoice(entry, "pinyin");
  } else if (state.mode === "mc-char") {
    el("quiz-prompt").className = "prompt pinyin-prompt";
    el("quiz-prompt").textContent = entry.pinyin;
    renderMultipleChoice(entry, "char");
  } else if (state.mode === "typing") {
    el("quiz-prompt").className = "prompt";
    el("quiz-prompt").textContent = entry.char;
    el("typing-area").classList.remove("hidden");
    el("typing-input").value = "";
    el("typing-feedback").textContent = "";
    el("typing-feedback").className = "";
    el("typing-input").focus();
  } else if (state.mode === "writing") {
    el("quiz-prompt").className = "prompt pinyin-prompt";
    el("quiz-prompt").textContent = entry.pinyin;
    el("writing-area").classList.remove("hidden");
    el("writing-hint").textContent = entry.char;
    el("writing-hint").classList.add("hidden");
    el("writing-answer").textContent = "";
    el("writing-answer").classList.add("hidden");
    el("writing-sentence").classList.add("hidden");
    el("writing-sentence").innerHTML = "";
    el("writing-sentence-btn").classList.toggle("hidden", !entry.sentence);
    el("writing-controls").classList.remove("hidden");
    el("hint-btn").disabled = false;
    el("writing-rate").classList.add("hidden");
  } else if (state.mode === "confusables") {
    renderConfusableContext(entry);
  } else if (state.mode === "sentence") {
    renderSentenceBuilder(entry);
  }
}

function normalizePinyin(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip tone mark diacritics
    .replace(/[0-9]/g, "") // strip tone numbers like ni3
    .replace(/\s+/g, "")
    .trim();
}

// ---------- flashcard ----------

function flipFlashcard() {
  const entry = currentEntry();
  el("flashcard-answer").textContent = entry.pinyin;
  if (entry.sentence) {
    el("flashcard-sentence").innerHTML = sentenceHighlightHTML(entry);
    el("flashcard-sentence").classList.remove("hidden");
  }
  el("flip-btn").classList.add("hidden");
  el("flashcard-rate").classList.remove("hidden");
  showHanVietFor(entry);
}

// Fetches (and caches, per entry) the Hán Việt reading and shows it under the
// pinyin answer. Guards against a slow response landing after the learner has
// already moved to a different card.
async function showHanVietFor(entry) {
  const box = el("flashcard-hanviet");
  if (entry.hanViet) {
    box.textContent = `Hán Việt: ${entry.hanViet}`;
    box.classList.remove("hidden");
    return;
  }
  try {
    const res = await fetch("/api/hanviet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: entry.char }),
    });
    const data = await res.json();
    if (res.ok && data.ok && data.hanViet) {
      entry.hanViet = data.hanViet;
      if (currentEntry() === entry) {
        box.textContent = `Hán Việt: ${entry.hanViet}`;
        box.classList.remove("hidden");
      }
    }
  } catch {
    // ignore — Hán Việt is a nice-to-have, not critical to the flashcard
  }
}

function answerFlashcard(known) {
  const entry = currentEntry();
  recordResult(state.currentLanguage.id, entry.char, known);
  if (known) state.correctCount++;
  else state.missed.push(entry);
  advance();
}

// ---------- writing practice ----------

function showWritingHint() {
  el("writing-hint").classList.remove("hidden");
  el("hint-btn").disabled = true;
}

function showWritingSentenceHint() {
  const entry = currentEntry();
  el("writing-sentence").innerHTML = sentenceBlankHTML(entry);
  el("writing-sentence").classList.remove("hidden");
  el("writing-sentence-btn").classList.add("hidden");
}

function showWritingAnswer() {
  const entry = currentEntry();
  el("writing-answer").textContent = entry.char;
  el("writing-answer").classList.remove("hidden");
  if (entry.sentence) {
    el("writing-sentence").innerHTML = sentenceHighlightHTML(entry);
    el("writing-sentence").classList.remove("hidden");
  }
  el("writing-sentence-btn").classList.add("hidden");
  el("writing-controls").classList.add("hidden");
  el("writing-rate").classList.remove("hidden");
}

function answerWriting(known) {
  const entry = currentEntry();
  recordResult(state.currentLanguage.id, entry.char, known);
  if (known) state.correctCount++;
  else state.missed.push(entry);
  advance();
}

// ---------- review story ----------

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Holds the plain text of the current story so TTS can read it and so the
// speak-along highlighter can map spoken character offsets back to the DOM.
let currentStoryText = "";

function startReviewStory() {
  stopSpeaking();
  currentStoryText = "";
  el("speak-story-btn").disabled = true;
  el("story-text").textContent = "Choose a difficulty and length, then generate a story.";
  el("story-word-count").textContent = state.entries.length
    ? `${state.entries.length} word${state.entries.length === 1 ? "" : "s"} in your list to draw from`
    : "";
  showScreen("story");
}

// Keeps the length control's label in sync with the chosen format.
function updateStoryLengthLabel() {
  const format = el("story-format").value;
  el("story-length-label").textContent =
    format === "conversation" ? "Length (lines)" : "Length (sentences)";
}

async function generateReviewStory() {
  stopSpeaking();
  const words = state.entries; // no cap — the whole list is fair game
  const btn = el("generate-story-btn");
  const textEl = el("story-text");

  if (!words.length) {
    textEl.textContent = "No words to build a story from yet — add some characters first.";
    return;
  }

  const hskLevel = Number(el("story-hsk").value) || 3;
  const length = Number(el("story-length").value) || 5;
  const format = el("story-format").value === "conversation" ? "conversation" : "story";

  textEl.textContent = format === "conversation" ? "Generating your conversation..." : "Generating your story...";
  el("speak-story-btn").disabled = true;
  btn.disabled = true;

  try {
    const res = await fetch("/api/generate-review-story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        languageId: state.currentLanguage.id,
        words: words.map((w) => ({ char: w.char, pinyin: w.pinyin })),
        hskLevel,
        length,
        format,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "generation failed");
    renderReviewStory(data.story);
  } catch (err) {
    textEl.textContent = `Couldn't generate a story: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Renders the story one character per <span> so we can (a) highlight words the
// learner has in their vocabulary, and (b) support right-click pinyin lookup
// and speak-along highlighting on any character, learned or not.
function renderReviewStory(story) {
  currentStoryText = story;
  const learned = new Set(state.entries.map((e) => e.char).filter((c) => c && c.length === 1));
  // Also collect multi-character learned words to mark their characters.
  const learnedMulti = state.entries.map((e) => e.char).filter((c) => c && c.length > 1);

  const container = el("story-text");
  container.innerHTML = "";

  const chars = [...story];
  chars.forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "story-char";
    span.dataset.index = String(i);
    span.textContent = ch;
    if (learned.has(ch)) span.classList.add("target");
    container.appendChild(span);
  });

  // Mark characters that are part of a learned multi-character word.
  learnedMulti.forEach((word) => {
    let from = 0;
    let idx;
    while ((idx = story.indexOf(word, from)) !== -1) {
      for (let k = 0; k < [...word].length; k++) {
        const span = container.querySelector(`.story-char[data-index="${idx + k}"]`);
        if (span) span.classList.add("target");
      }
      from = idx + word.length;
    }
  });

  el("speak-story-btn").disabled = !story;
}

// ---------- story text-to-speech ----------

const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

// Picks the best available Mandarin voice, if the browser has one.
function pickChineseVoice() {
  if (!speechSupported) return null;
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => /^zh(-|_)?(cn|hans)?/i.test(v.lang)) ||
    voices.find((v) => /^zh/i.test(v.lang)) ||
    null
  );
}

function clearSpeakingHighlight() {
  document.querySelectorAll(".story-char.speaking").forEach((s) => s.classList.remove("speaking"));
}

function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
  clearSpeakingHighlight();
  const btn = el("speak-story-btn");
  if (btn) btn.textContent = "🔊 Speak";
}

function toggleSpeakStory() {
  if (!speechSupported) {
    alert("Your browser doesn't support speech synthesis.");
    return;
  }
  // If already speaking, treat the button as Stop.
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    stopSpeaking();
    return;
  }
  if (!currentStoryText) return;

  const utter = new SpeechSynthesisUtterance(currentStoryText);
  utter.lang = "zh-CN";
  const voice = pickChineseVoice();
  if (voice) utter.voice = voice;
  utter.rate = 0.9;

  // Highlight the character currently being spoken (where the browser reports
  // boundary events — support varies, so this is a best-effort nicety).
  utter.onboundary = (e) => {
    if (typeof e.charIndex !== "number") return;
    clearSpeakingHighlight();
    const span = el("story-text").querySelector(`.story-char[data-index="${e.charIndex}"]`);
    if (span) span.classList.add("speaking");
  };
  utter.onend = stopSpeaking;
  utter.onerror = stopSpeaking;

  el("speak-story-btn").textContent = "⏹ Stop";
  window.speechSynthesis.speak(utter);
}

// Some browsers load voices asynchronously; nudge the list to populate.
if (speechSupported) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

// ---------- right-click pinyin lookup on story text ----------

let pinyinPopupTimer = null;

function hidePinyinPopup() {
  const popup = el("pinyin-popup");
  popup.classList.add("hidden");
  popup.innerHTML = "";
}

async function showPinyinPopupFor(text, x, y) {
  const clean = String(text || "").trim();
  if (!clean) return;

  const popup = el("pinyin-popup");
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  popup.innerHTML = `<span class="popup-char">${escapeHtml(clean)}</span>…`;
  popup.classList.remove("hidden");

  if (pinyinPopupTimer) clearTimeout(pinyinPopupTimer);

  try {
    const res = await fetch("/api/pinyin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: clean }),
    });
    const data = await res.json();
    if (res.ok && data.ok && data.pinyin) {
      popup.innerHTML = `<span class="popup-char">${escapeHtml(clean)}</span>${escapeHtml(data.pinyin)}`;
    } else {
      popup.innerHTML = `<span class="popup-char">${escapeHtml(clean)}</span>?`;
    }
  } catch {
    popup.innerHTML = `<span class="popup-char">${escapeHtml(clean)}</span>?`;
  }

  // Auto-dismiss after a few seconds.
  pinyinPopupTimer = setTimeout(hidePinyinPopup, 3500);
}

function bindStoryPinyinLookup() {
  const container = el("story-text");

  // Right-click a character (or a text selection) to look up its pinyin.
  container.addEventListener("contextmenu", (e) => {
    const selection = String(window.getSelection ? window.getSelection().toString() : "").trim();
    let target = selection;
    if (!target && e.target.classList && e.target.classList.contains("story-char")) {
      target = e.target.textContent;
    }
    if (!target) return; // let the normal menu show if there's nothing to look up
    e.preventDefault();
    showPinyinPopupFor(target, e.clientX, e.clientY);
  });

  // Long-press support for touch devices (no right-click there).
  let touchTimer = null;
  container.addEventListener(
    "touchstart",
    (e) => {
      const t = e.target;
      if (!(t.classList && t.classList.contains("story-char"))) return;
      const touch = e.touches[0];
      touchTimer = setTimeout(() => {
        showPinyinPopupFor(t.textContent, touch.clientX, touch.clientY);
      }, 450);
    },
    { passive: true }
  );
  const cancelTouch = () => {
    if (touchTimer) clearTimeout(touchTimer);
  };
  container.addEventListener("touchend", cancelTouch);
  container.addEventListener("touchmove", cancelTouch);

  // Dismiss the popup on any click/scroll elsewhere.
  document.addEventListener("click", hidePinyinPopup);
  document.addEventListener("scroll", hidePinyinPopup, true);
}

// ---------- add new characters ----------

// Auto-generates pinyin from the character field via the server (pinyin-pro).
// Debounced so we're not firing a request on every keystroke. The pinyin
// field is read-only in the UI — this is the only thing that fills it.
let pinyinDebounce = null;
function autoFillPinyin() {
  const char = el("add-char").value.trim();
  const pinyinField = el("add-pinyin");

  if (pinyinDebounce) clearTimeout(pinyinDebounce);

  if (!char) {
    pinyinField.value = "";
    updateConfusableWarning();
    return;
  }

  pinyinField.value = "…";
  pinyinDebounce = setTimeout(async () => {
    try {
      const res = await fetch("/api/pinyin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ char }),
      });
      const data = await res.json();
      // Ignore if the character field changed while we were waiting.
      if (el("add-char").value.trim() !== char) return;
      if (res.ok && data.ok) {
        pinyinField.value = data.pinyin || "";
      } else {
        pinyinField.value = "";
      }
    } catch {
      if (el("add-char").value.trim() === char) pinyinField.value = "";
    }
    updateConfusableWarning();
  }, 250);
}

function updateConfusableWarning() {
  const pinyin = el("add-pinyin").value.trim();
  const warning = el("add-confusable-warning");
  if (!pinyin) {
    warning.classList.add("hidden");
    return;
  }
  const key = normalizePinyin(pinyin);
  const matches = state.entries.filter((e) => normalizePinyin(e.pinyin) === key);
  if (!matches.length) {
    warning.classList.add("hidden");
    return;
  }
  const list = matches.map((e) => `${e.char} ${e.pinyin}`).join(", ");
  warning.textContent = `⚠️ Similar pinyin already in your list: ${list} — consider adding an example sentence to tell them apart.`;
  warning.classList.remove("hidden");
}

async function generateSentenceForAdd() {
  const char = el("add-char").value.trim();
  const pinyin = el("add-pinyin").value.trim();
  const feedback = el("add-feedback");

  if (!char || !pinyin) {
    feedback.textContent = "Enter the character and pinyin first, then generate.";
    feedback.className = "incorrect";
    return;
  }

  const btn = el("generate-sentence-btn");
  btn.disabled = true;
  btn.textContent = "Generating...";

  try {
    const res = await fetch("/api/generate-sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char, pinyin }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "generation failed");

    el("add-sentence").value = data.sentence;
    feedback.textContent = "Sentence generated — feel free to edit it before adding.";
    feedback.className = "correct";
  } catch (err) {
    feedback.textContent = `Couldn't generate a sentence: ${err.message}`;
    feedback.className = "incorrect";
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate";
  }
}

async function submitNewCharacter() {
  const charInput = el("add-char");
  const pinyinInput = el("add-pinyin");
  const sentenceInput = el("add-sentence");
  const feedback = el("add-feedback");
  const char = charInput.value.trim();
  const sentence = sentenceInput.value.trim();

  if (!char) {
    feedback.textContent = "Enter a character.";
    feedback.className = "incorrect";
    return;
  }

  feedback.textContent = "Saving...";
  feedback.className = "";

  try {
    // Pinyin is generated server-side from the character; no need to send it.
    const res = await fetch("/api/add-word", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ languageId: state.currentLanguage.id, char, sentence: sentence || undefined }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "save failed");

    const pinyin = data.pinyin || pinyinInput.value.trim();

    state.entries.push({
      char,
      pinyin,
      sentence: sentence || null,
      sessionIndex: maxSessionIndex(state.entries) + (data.newSession ? 1 : 0),
      sessionLabel: data.sessionLabel || null,
    });
    feedback.textContent = `Added ${char} ${pinyin}`;
    feedback.className = "correct";

    const row = document.createElement("div");
    row.className = "added-row";
    row.innerHTML = `<span>${char}</span><span class="added-pinyin">${pinyin}${sentence ? " · " + sentence : ""}</span>`;
    el("add-recent").prepend(row);

    charInput.value = "";
    pinyinInput.value = "";
    sentenceInput.value = "";
    el("add-confusable-warning").classList.add("hidden");
    charInput.focus();
  } catch (err) {
    feedback.textContent = `Couldn't save: ${err.message}. Is the server running (npm start)?`;
    feedback.className = "incorrect";
  }
}

// ---------- multiple choice ----------

function buildOptions(entry, field, preferredPool) {
  const usedChars = new Set([entry.char]);
  const distractors = [];

  shuffle((preferredPool || []).filter((e) => e.char !== entry.char)).forEach((e) => {
    if (distractors.length >= 3 || usedChars.has(e.char)) return;
    distractors.push(e[field]);
    usedChars.add(e.char);
  });

  if (distractors.length < 3) {
    shuffle(state.entries.filter((e) => !usedChars.has(e.char))).forEach((e) => {
      if (distractors.length >= 3) return;
      distractors.push(e[field]);
      usedChars.add(e.char);
    });
  }

  return shuffle([entry[field], ...distractors]);
}

function renderMultipleChoice(entry, field, preferredPool) {
  const container = el("mc-area");
  container.classList.remove("hidden");
  container.innerHTML = "";

  const options = buildOptions(entry, field, preferredPool);

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = opt;
    btn.addEventListener("click", () => choose(btn, opt, entry[field], entry));
    container.appendChild(btn);
  });
}

function choose(btn, chosen, correct, entry) {
  const known = chosen === correct;
  document.querySelectorAll(".option-btn").forEach((b) => {
    b.disabled = true;
    if (b.textContent === correct) b.classList.add("correct");
    else if (b === btn) b.classList.add("incorrect");
  });
  recordResult(state.currentLanguage.id, entry.char, known);
  if (known) state.correctCount++;
  else state.missed.push(entry);
  setTimeout(advance, 700);
}

// ---------- confusables (pick the right character for the pinyin context) ----------

// Fetches an AI sentence whose pinyin is shown with the target word blanked out,
// then asks the learner to pick the character that fits — choices are the
// same-pinyin confusables. Falls back to the plain pinyin prompt if the AI call
// fails, so the mode still works offline / without an API key.
async function renderConfusableContext(entry) {
  const token = ++currentQuestionToken;
  el("quiz-prompt").className = "prompt pinyin-prompt";
  el("quiz-prompt").textContent = "…";
  setSubprompt("Loading a sentence…");
  el("mc-area").classList.add("hidden");

  let pinyinContext = null;
  try {
    const res = await fetch("/api/generate-confusable-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: entry.char, pinyin: entry.pinyin }),
    });
    const data = await res.json();
    if (res.ok && data.ok) pinyinContext = data.pinyinContext;
  } catch {
    // ignore — fall back below
  }

  // A newer question started while we were waiting; abandon this render.
  if (token !== currentQuestionToken) return;

  if (pinyinContext) {
    el("quiz-prompt").className = "prompt pinyin-context";
    el("quiz-prompt").textContent = pinyinContext;
    setSubprompt("Which character fills the blank (＿)?");
  } else {
    // Fallback: no context sentence available.
    el("quiz-prompt").className = "prompt pinyin-prompt";
    el("quiz-prompt").textContent = entry.pinyin;
    setSubprompt("Pick the matching character");
  }
  renderMultipleChoice(entry, "char", confusablesFor(entry, state.entries));
}

// ---------- sentence builder (drag the shuffled words into order) ----------

// Per-question token so a slow AI response for a previous question doesn't
// overwrite the current one after the learner advances.
let currentQuestionToken = 0;

// Holds the correct chunk order (and its pinyin) for the current sentence-builder question.
let dndCorrect = [];
let dndCorrectPinyin = "";

async function renderSentenceBuilder(entry) {
  const token = ++currentQuestionToken;
  el("dragdrop-area").classList.remove("hidden");
  el("quiz-prompt").className = "prompt";
  el("quiz-prompt").textContent = entry.char;

  el("dnd-status").textContent = "Generating a sentence…";
  el("dnd-slots").innerHTML = "";
  el("dnd-bank").innerHTML = "";
  el("dnd-feedback").textContent = "";
  el("dnd-feedback").className = "";
  el("dnd-answer").classList.add("hidden");
  el("dnd-answer").innerHTML = "";
  el("dnd-next-btn").classList.add("hidden");
  el("dnd-check-btn").classList.remove("hidden");
  el("dnd-reset-btn").classList.remove("hidden");
  el("dnd-check-btn").disabled = true;

  let sentence = null;
  let chunks = null;
  let sentencePinyin = "";
  try {
    const res = await fetch("/api/generate-practice-sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: entry.char, pinyin: entry.pinyin }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      sentence = data.sentence;
      chunks = data.chunks;
      sentencePinyin = data.sentencePinyin || "";
    }
  } catch {
    // ignore — handled below
  }

  if (token !== currentQuestionToken) return;

  if (!sentence || !Array.isArray(chunks) || chunks.length < 2) {
    el("dnd-status").textContent = "Couldn't generate a sentence for this word — skipping.";
    el("dnd-check-btn").classList.add("hidden");
    el("dnd-reset-btn").classList.add("hidden");
    el("dnd-next-btn").classList.remove("hidden");
    return;
  }

  dndCorrect = chunks.slice();
  dndCorrectPinyin = sentencePinyin;
  el("dnd-status").textContent = `Arrange the words to use 「${entry.char}」 in a sentence:`;
  buildDndUI(chunks);
}

// Builds the drop-slots (one per chunk) and the shuffled word bank.
function buildDndUI(chunks) {
  const slots = el("dnd-slots");
  const bank = el("dnd-bank");
  slots.innerHTML = "";
  bank.innerHTML = "";

  // One empty slot per chunk.
  chunks.forEach((_, i) => {
    const slot = document.createElement("div");
    slot.className = "dnd-slot";
    slot.dataset.slot = String(i);
    bindSlotDrop(slot);
    slots.appendChild(slot);
  });

  // Shuffled chips in the bank. Keep shuffling until it isn't already correct
  // (unless there's no other arrangement).
  let order = shuffle(chunks.map((_, i) => i));
  let guard = 0;
  while (order.every((v, i) => v === i) && chunks.length > 1 && guard++ < 10) {
    order = shuffle(chunks.map((_, i) => i));
  }
  order.forEach((idx) => {
    bank.appendChild(makeChip(chunks[idx], idx));
  });

  bindBankDrop(bank);
  updateDndCheckState();
}

function makeChip(text, idx) {
  const chip = document.createElement("div");
  chip.className = "dnd-chip";
  chip.textContent = text;
  chip.draggable = true;
  chip.dataset.idx = String(idx);
  chip.dataset.text = text;

  chip.addEventListener("dragstart", (e) => {
    chip.classList.add("dragging");
    e.dataTransfer.setData("text/plain", chip.dataset.idx);
    e.dataTransfer.effectAllowed = "move";
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));

  // Touch support: tap a chip to place it in the first empty slot; tap a placed
  // chip to send it back to the bank.
  chip.addEventListener("click", () => onChipTap(chip));

  return chip;
}

function onChipTap(chip) {
  const inSlot = chip.parentElement && chip.parentElement.classList.contains("dnd-slot");
  if (inSlot) {
    el("dnd-bank").appendChild(chip);
  } else {
    const emptySlot = [...el("dnd-slots").children].find((s) => !s.querySelector(".dnd-chip"));
    if (emptySlot) emptySlot.appendChild(chip);
  }
  updateDndCheckState();
}

function bindSlotDrop(slot) {
  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    slot.classList.add("drop-hover");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("drop-hover"));
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    slot.classList.remove("drop-hover");
    const idx = e.dataTransfer.getData("text/plain");
    const chip = el("dragdrop-area").querySelector(`.dnd-chip[data-idx="${idx}"]`);
    if (!chip) return;
    // If the slot already holds a chip, swap it back to the bank.
    const existing = slot.querySelector(".dnd-chip");
    if (existing && existing !== chip) el("dnd-bank").appendChild(existing);
    slot.appendChild(chip);
    updateDndCheckState();
  });
}

function bindBankDrop(bank) {
  bank.addEventListener("dragover", (e) => {
    e.preventDefault();
    bank.classList.add("drop-hover");
  });
  bank.addEventListener("dragleave", () => bank.classList.remove("drop-hover"));
  bank.addEventListener("drop", (e) => {
    e.preventDefault();
    bank.classList.remove("drop-hover");
    const idx = e.dataTransfer.getData("text/plain");
    const chip = el("dragdrop-area").querySelector(`.dnd-chip[data-idx="${idx}"]`);
    if (chip) bank.appendChild(chip);
    updateDndCheckState();
  });
}

// The check button is enabled only once every slot is filled.
function updateDndCheckState() {
  const slots = [...el("dnd-slots").children];
  const allFilled = slots.every((s) => s.querySelector(".dnd-chip"));
  el("dnd-check-btn").disabled = !allFilled;
}

function resetSentenceBuilder() {
  const bank = el("dnd-bank");
  el("dragdrop-area").querySelectorAll(".dnd-slot .dnd-chip").forEach((chip) => bank.appendChild(chip));
  el("dnd-feedback").textContent = "";
  el("dnd-feedback").className = "";
  updateDndCheckState();
}

function checkSentenceOrder() {
  const slots = [...el("dnd-slots").children];
  const assembled = slots.map((s) => {
    const chip = s.querySelector(".dnd-chip");
    return chip ? chip.dataset.text : "";
  });
  const known = assembled.join("") === dndCorrect.join("");
  const entry = currentEntry();

  slots.forEach((s, i) => {
    const chip = s.querySelector(".dnd-chip");
    if (!chip) return;
    chip.classList.toggle("correct", chip.dataset.text === dndCorrect[i]);
    chip.classList.toggle("incorrect", chip.dataset.text !== dndCorrect[i]);
  });

  const feedback = el("dnd-feedback");
  feedback.textContent = known ? "Correct!" : "Not quite — see the answer below.";
  feedback.className = known ? "correct" : "incorrect";

  const pinyinLine = dndCorrectPinyin
    ? `<div class="dnd-answer-pinyin">${escapeHtml(dndCorrectPinyin)}</div>`
    : "";
  el("dnd-answer").innerHTML =
    `<span class="dnd-answer-label">Answer:</span> ${escapeHtml(dndCorrect.join(""))}${pinyinLine}`;
  el("dnd-answer").classList.remove("hidden");

  el("dnd-check-btn").classList.add("hidden");
  el("dnd-reset-btn").classList.add("hidden");
  el("dnd-next-btn").classList.remove("hidden");
  el("dragdrop-area").querySelectorAll(".dnd-chip").forEach((c) => (c.draggable = false));

  recordResult(state.currentLanguage.id, entry.char, known);
  if (known) state.correctCount++;
  else state.missed.push(entry);
}

// ---------- typing ----------

function submitTyping() {
  const entry = currentEntry();
  const input = el("typing-input").value;
  const known = normalizePinyin(input) === normalizePinyin(entry.pinyin);
  // How long this answer took, from when the question was shown.
  const elapsedMs = state.questionStart ? Date.now() - state.questionStart : null;
  const feedback = el("typing-feedback");
  if (known) {
    const secs = elapsedMs != null ? (elapsedMs / 1000).toFixed(1) : null;
    feedback.textContent = secs != null ? `Correct! (${secs}s)` : "Correct!";
  } else {
    feedback.textContent = `Answer: ${entry.pinyin}`;
  }
  feedback.className = known ? "correct" : "incorrect";
  el("typing-input").disabled = true;
  el("typing-submit").disabled = true;
  // Only feed timing into the score on correct answers — a wrong answer's time
  // is meaningless for "how fast do I recall this".
  recordResult(state.currentLanguage.id, entry.char, known, known ? elapsedMs : null);
  if (known) state.correctCount++;
  else state.missed.push(entry);
  setTimeout(() => {
    el("typing-input").disabled = false;
    el("typing-submit").disabled = false;
    advance();
  }, 900);
}

// ---------- flow ----------

function advance() {
  state.index++;
  if (state.index >= state.queue.length) {
    showResults();
  } else {
    renderQuestion();
  }
}

function showResults() {
  showScreen("results");
  const total = state.index; // questions actually answered this run
  el("results-summary").textContent = `${state.correctCount} / ${total} correct`;
  const missedContainer = el("results-missed");
  missedContainer.innerHTML = "";
  if (state.missed.length === 0) {
    missedContainer.textContent = "Nice, you missed nothing!";
    el("retry-missed").classList.add("hidden");
  } else {
    el("retry-missed").classList.remove("hidden");
    state.missed.forEach((e) => {
      const chip = document.createElement("span");
      chip.className = "missed-chip";
      chip.textContent = `${e.char} ${e.pinyin}`;
      missedContainer.appendChild(chip);
    });
  }

  renderRememberingLevels();
}

// Shows a "how well you remember these" bar for each word answered this run,
// weakest first, using the accuracy+speed remembering score.
function renderRememberingLevels() {
  const container = el("results-remembering");
  container.innerHTML = "";

  // Unique entries answered this run (the queue up to where we stopped).
  const seen = new Map();
  state.queue.slice(0, state.index).forEach((e) => seen.set(e.char, e));
  const rows = [...seen.values()]
    .map((e) => ({ e, level: rememberingLevel(statFor(e.char)) }))
    .filter((r) => r.level !== null)
    .sort((a, b) => a.level - b.level);

  if (!rows.length) return;

  const heading = document.createElement("h3");
  heading.className = "remembering-heading";
  heading.textContent = "Remembering level";
  container.appendChild(heading);

  rows.forEach(({ e, level }) => {
    const row = document.createElement("div");
    row.className = "remembering-row";
    const tier = level >= 75 ? "strong" : level >= 45 ? "medium" : "weak";
    row.innerHTML =
      `<span class="rem-word">${escapeHtml(e.char)} <span class="rem-pinyin">${escapeHtml(e.pinyin)}</span></span>` +
      `<span class="rem-bar"><span class="rem-fill ${tier}" style="width:${level}%"></span></span>` +
      `<span class="rem-pct">${level}%</span>`;
    container.appendChild(row);
  });
}

// ---------- utils ----------

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

init();
