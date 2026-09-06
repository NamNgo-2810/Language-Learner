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

function recordResult(languageId, char, known) {
  const stats = loadStats();
  stats[languageId] = stats[languageId] || {};
  const rec = stats[languageId][char] || { seen: 0, wrong: 0 };
  rec.seen += 1;
  if (!known) rec.wrong += 1;
  stats[languageId][char] = rec;
  saveStats(stats);
}

// weight favors words you've gotten wrong before, words never quizzed yet,
// and words from the most recent class session(s)
function computeWeight(entry, maxSessionIndex) {
  const stats = loadStats();
  const rec = stats[state.currentLanguage.id] && stats[state.currentLanguage.id][entry.char];
  const wrongBoost = rec ? rec.wrong * 3 : 0;
  const unseenBoost = rec ? 0 : 2;
  let recencyBoost = 0;
  if (entry.sessionIndex >= 0 && maxSessionIndex >= 0) {
    if (entry.sessionIndex === maxSessionIndex) recencyBoost = 4;
    else if (entry.sessionIndex === maxSessionIndex - 1) recencyBoost = 2;
  }
  return 1 + wrongBoost + unseenBoost + recencyBoost;
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
  const res = await fetch("languages.json");
  state.languages = await res.json();
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
  const res = await fetch(lang.file);
  const raw = await res.text();
  state.currentLanguage = lang;
  state.entries = parseEntries(raw);
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
  el("add-pinyin").addEventListener("input", updateConfusableWarning);
  el("add-char").addEventListener("input", updateConfusableWarning);
  el("generate-sentence-btn").addEventListener("click", generateSentenceForAdd);

  el("regenerate-story-btn").addEventListener("click", generateReviewStory);
  el("back-from-story-btn").addEventListener("click", () => showScreen("mode"));
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
    const pool = state.entries.filter((e) => e.sentence);
    if (!pool.length) {
      alert("No example sentences yet — add one when creating a character (or edit mandarin.md) to unlock this mode.");
      return;
    }
    beginQuiz(mode, pool);
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
  setSubprompt(null);

  if (state.mode === "flashcard") {
    el("quiz-prompt").className = "prompt";
    el("quiz-prompt").textContent = entry.char;
    el("flashcard-area").classList.remove("hidden");
    el("flashcard-answer").textContent = "";
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
    el("quiz-prompt").className = "prompt pinyin-prompt";
    el("quiz-prompt").textContent = entry.pinyin;
    if (entry.sentence) setSubprompt(sentenceBlankHTML(entry));
    renderMultipleChoice(entry, "char", confusablesFor(entry, state.entries));
  } else if (state.mode === "sentence") {
    el("quiz-prompt").className = "prompt pinyin-prompt";
    el("quiz-prompt").innerHTML = sentenceBlankHTML(entry);
    setSubprompt(entry.pinyin);
    renderMultipleChoice(entry, "char", confusablesFor(entry, state.entries));
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

// Same weighting/cap as quizzes: wrong + new + recent-session words, capped
// unless "Study everything" is checked.
function selectReviewWords() {
  const studyAll = el("study-all-toggle").checked;
  let words = weightedShuffle(state.entries);
  if (!studyAll) words = words.slice(0, SESSION_CAP);
  return words;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function startReviewStory() {
  showScreen("story");
  generateReviewStory();
}

async function generateReviewStory() {
  const words = selectReviewWords();
  const btn = el("regenerate-story-btn");
  const textEl = el("story-text");
  const usedEl = el("story-used");
  const unusedEl = el("story-unused");

  if (!words.length) {
    textEl.textContent = "No words to build a story from yet — add some characters first.";
    usedEl.textContent = "";
    unusedEl.textContent = "";
    el("story-word-count").textContent = "";
    return;
  }

  el("story-word-count").textContent = `Using ${words.length} word${words.length === 1 ? "" : "s"} from your list`;
  textEl.textContent = "Generating your story...";
  usedEl.textContent = "";
  unusedEl.textContent = "";
  btn.disabled = true;

  try {
    const res = await fetch("/api/generate-review-story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        languageId: state.currentLanguage.id,
        words: words.map((w) => ({ char: w.char, pinyin: w.pinyin })),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "generation failed");
    renderReviewStory(data);
  } catch (err) {
    textEl.textContent = `Couldn't generate a story: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Highlights every word from the whole vocabulary (not just the ones the AI
// says it intentionally used) that actually appears in the text. Longest
// words are matched first so a multi-character word wins over a shorter
// word that happens to be one of its characters.
function highlightLearnedWords(text, entries) {
  const words = [...new Set(entries.map((e) => e.char).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  const escaped = escapeHtml(text);
  if (!words.length) return escaped;

  const pattern = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g"
  );
  return escaped.replace(pattern, '<span class="target">$1</span>');
}

function renderReviewStory(data) {
  el("story-text").innerHTML = highlightLearnedWords(data.story, state.entries);

  el("story-used").textContent = (data.used || []).length
    ? `✅ AI intentionally used: ${data.used.join("、")}`
    : "";
  el("story-unused").textContent = (data.unused || []).length
    ? `Not included this time: ${data.unused.join("、")}`
    : "";
}

// ---------- add new characters ----------

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
  const pinyin = pinyinInput.value.trim();
  const sentence = sentenceInput.value.trim();

  if (!char || !pinyin) {
    feedback.textContent = "Enter both a character and its pinyin.";
    feedback.className = "incorrect";
    return;
  }

  feedback.textContent = "Saving...";
  feedback.className = "";

  try {
    const res = await fetch("/api/add-word", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ languageId: state.currentLanguage.id, char, pinyin, sentence: sentence || undefined }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "save failed");

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

// ---------- typing ----------

function submitTyping() {
  const entry = currentEntry();
  const input = el("typing-input").value;
  const known = normalizePinyin(input) === normalizePinyin(entry.pinyin);
  const feedback = el("typing-feedback");
  feedback.textContent = known ? "Correct!" : `Answer: ${entry.pinyin}`;
  feedback.className = known ? "correct" : "incorrect";
  el("typing-input").disabled = true;
  el("typing-submit").disabled = true;
  recordResult(state.currentLanguage.id, entry.char, known);
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
  const total = state.queue.length;
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
