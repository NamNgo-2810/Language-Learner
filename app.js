const STORAGE_KEY = "lang-learner-stats-v1";
const HANVIET_PREF_KEY = "lang-learner-show-hanviet";
const CHIETU_PREF_KEY = "lang-learner-show-chietu";
const SESSION_CAP = 20;
const SENTENCE_SESSION_LENGTH = 10; // sentence builder isn't tied to the vocab list, so it's a fixed-length run

// Whether to show the Hán Việt reading on flashcards. Defaults to on, persisted
// across sessions.
function isHanVietEnabled() {
  const stored = localStorage.getItem(HANVIET_PREF_KEY);
  return stored === null ? true : stored === "1";
}

function setHanVietEnabled(enabled) {
  localStorage.setItem(HANVIET_PREF_KEY, enabled ? "1" : "0");
}

// Whether to show the chiết tự (character component) breakdown on
// flashcards. Defaults to on, persisted across sessions.
function isChietuEnabled() {
  const stored = localStorage.getItem(CHIETU_PREF_KEY);
  return stored === null ? true : stored === "1";
}

function setChietuEnabled(enabled) {
  localStorage.setItem(CHIETU_PREF_KEY, enabled ? "1" : "0");
}

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
  compose: el("screen-compose"),
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
  const hadHistory = rec.seen > 0;
  const prevErr = recentErrorRate(rec);
  rec.seen += 1;
  if (!known) rec.wrong += 1;
  // Recent-weighted error rate: each answer moves it 40% of the way toward
  // 1 (missed) or 0 (knew it), so a few correct answers in a row cool down a
  // word you used to miss, and a fresh miss heats it right back up.
  const miss = known ? 0 : 1;
  rec.errEma = hadHistory ? prevErr * 0.6 + miss * 0.4 : miss;

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

// 0 (never missed lately) .. 1 (missed every recent time). Records from before
// errEma existed fall back to their lifetime miss ratio.
function recentErrorRate(rec) {
  if (!rec || !rec.seen) return 0;
  if (typeof rec.errEma === "number") return rec.errEma;
  return rec.wrong / rec.seen;
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

// A learner-set "I don't really remember this" flag, independent of the
// auto-tracked accuracy/speed stats. Persisted the same way (localStorage,
// per language) so it survives across sessions until the learner unflags it.
function isFlagged(char) {
  const rec = statFor(char);
  return Boolean(rec && rec.flagged);
}

function setFlagged(char, flagged) {
  const stats = loadStats();
  stats[state.currentLanguage.id] = stats[state.currentLanguage.id] || {};
  const rec = stats[state.currentLanguage.id][char] || { seen: 0, wrong: 0 };
  rec.flagged = flagged;
  stats[state.currentLanguage.id][char] = rec;
  saveStats(stats);
}

// Sentence Builder's questions are whole generated sentences, not vocab words
// (see launchMode), so there's nothing meaningful to flag there — hide the button.
function updateFlagButton(entry) {
  const btn = el("flag-word-btn");
  if (state.mode === "sentence" || !entry || !entry.char) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  btn.classList.toggle("active", isFlagged(entry.char));
}

function toggleCurrentFlag() {
  const entry = currentEntry();
  if (!entry || !entry.char) return;
  setFlagged(entry.char, !isFlagged(entry.char));
  updateFlagButton(entry);
}

// weight favors words you've gotten wrong before, words never quizzed yet,
// words you're slow to recall, words from the most recent class session(s),
// and words the learner has manually flagged as hard to remember
function computeWeight(entry, maxSessionIndex) {
  const rec = statFor(entry.char);
  const wrongBoost = recentErrorRate(rec) * 8;
  const unseenBoost = rec ? 0 : 2;
  const slowBoost = rec ? slownessFactor(rec) * 3 : 0; // slow-but-correct resurfaces
  const flaggedBoost = rec && rec.flagged ? 8 : 0; // a strong, deliberate boost
  let recencyBoost = 0;
  if (entry.sessionIndex >= 0 && maxSessionIndex >= 0) {
    if (entry.sessionIndex === maxSessionIndex) recencyBoost = 4;
    else if (entry.sessionIndex === maxSessionIndex - 1) recencyBoost = 2;
  }
  return 1 + wrongBoost + unseenBoost + slowBoost + flaggedBoost + recencyBoost;
}

// "New" = from the two most recent class sessions.
const RECENT_SESSIONS = 2;

function isRecentEntry(entry, maxIdx = maxSessionIndex(state.entries)) {
  return entry.sessionIndex >= 0 && entry.sessionIndex > maxIdx - RECENT_SESSIONS;
}

function recentEntries() {
  const maxIdx = maxSessionIndex(state.entries);
  return state.entries.filter((e) => isRecentEntry(e, maxIdx));
}

// A word you're currently struggling with: flagged, missed recently, or with
// a low remembering score.
function isWeak(rec) {
  if (!rec) return false;
  if (rec.flagged) return true;
  if (!rec.seen) return false;
  return recentErrorRate(rec) >= 0.3 || rememberingLevel(rec) < 60;
}

// Older, solid words: resurface the ones you haven't seen in longest.
function reviewWeight(entry) {
  const rec = statFor(entry.char);
  if (!rec || !rec.lastSeen) return 4;
  const days = (Date.now() - rec.lastSeen) / 86400000;
  return 1 + Math.min(days, 14) / 2;
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
    `${state.entries.length} words loaded · ${withSentence} with example sentences · ${confusableCount} in confusable pairs`;
}

function bindStaticEvents() {
  el("back-to-language").addEventListener("click", () => showScreen("language"));
  el("back-to-modes").addEventListener("click", () => showScreen("mode"));
  el("quit-quiz").addEventListener("click", () => showScreen("mode"));

  document.querySelectorAll(".mode-card").forEach((btn) => {
    btn.addEventListener("click", () => launchMode(btn.dataset.mode));
  });

  el("flag-word-btn").addEventListener("click", toggleCurrentFlag);

  el("flip-btn").addEventListener("click", flipFlashcard);
  document.querySelectorAll(".fc-rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => answerFlashcard(btn.dataset.know === "1"));
  });

  const hanvietToggle = el("hanviet-toggle");
  hanvietToggle.checked = isHanVietEnabled();
  hanvietToggle.addEventListener("change", () => {
    setHanVietEnabled(hanvietToggle.checked);
    const alreadyFlipped = el("flip-btn").classList.contains("hidden");
    if (!hanvietToggle.checked) {
      el("flashcard-hanviet").classList.add("hidden");
    } else if (alreadyFlipped) {
      // card is already flipped — show it right away if we have it cached,
      // otherwise fetch it now
      const entry = currentEntry();
      if (entry) {
        ensureHanViet(entry).then(() => {
          if (currentEntry() !== entry || !entry.hanViet || !isHanVietEnabled()) return;
          el("flashcard-hanviet").textContent = `Hán Việt: ${entry.hanViet}`;
          el("flashcard-hanviet").classList.remove("hidden");
        });
      }
    }
  });

  const chietuToggle = el("chietu-toggle");
  chietuToggle.checked = isChietuEnabled();
  chietuToggle.addEventListener("change", () => {
    setChietuEnabled(chietuToggle.checked);
    const alreadyFlipped = el("flip-btn").classList.contains("hidden");
    if (!chietuToggle.checked) {
      el("flashcard-chietu").classList.add("hidden");
    } else if (alreadyFlipped) {
      // card is already flipped — show it right away if we have it cached,
      // otherwise fetch it now
      const entry = currentEntry();
      if (entry) {
        ensureChietu(entry).then(() => {
          if (currentEntry() !== entry || !entry.chietu || !isChietuEnabled()) return;
          el("flashcard-chietu").textContent = `Chiết tự: ${entry.chietu}`;
          el("flashcard-chietu").classList.remove("hidden");
        });
      }
    }
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

  el("compose-new-btn").addEventListener("click", newComposeTask);
  el("compose-check-btn").addEventListener("click", checkComposition);
  el("compose-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) checkComposition();
  });
  ["compose-kind", "compose-hsk", "compose-lang"].forEach((id) => el(id).addEventListener("change", saveComposePrefs));
  el("back-from-compose-btn").addEventListener("click", () => showScreen("mode"));

  bindPinyinLookup(el("story-text"), ".story-char");
  bindPinyinLookup(el("compose-feedback"), ".story-char");
  bindPinyinLookup(el("dragdrop-area"), ".dnd-chip");
  bindGlobalPinyinPopupDismiss();
}

// ---------- mode launch (filters the pool per mode, then starts the quiz) ----------

function launchMode(mode) {
  if (mode === "story") {
    startReviewStory();
  } else if (mode === "compose") {
    startCompose();
  } else if (mode === "confusables") {
    const pool = confusableGroups(state.entries).flat();
    if (!pool.length) {
      alert("No confusable pairs found yet — add more characters that share a pinyin to unlock this mode.");
      return;
    }
    beginQuiz(mode, pool);
  } else if (mode === "sentence") {
    // Each question is a freshly generated sentence built around 1-2 of the
    // learner's words: one cycled through the newest words (so each new word
    // gets its turn instead of the same one repeating), sometimes plus one
    // drawn from the whole list.
    const recentCycle = shuffle(recentEntries());
    const anyCycle = weightedShuffle(state.entries);
    const placeholders = Array.from({ length: SENTENCE_SESSION_LENGTH }, (_, i) => {
      const words = [];
      if (recentCycle.length) words.push(recentCycle[i % recentCycle.length]);
      const extra = anyCycle.length ? anyCycle[i % anyCycle.length] : null;
      if (extra && !words.includes(extra) && (!words.length || Math.random() < 0.6)) words.push(extra);
      return { id: i, words: words.map((w) => ({ char: w.char, pinyin: w.pinyin })) };
    });
    beginQuiz(mode, placeholders, { skipCap: true });
  } else {
    beginQuiz(mode, state.entries);
  }
}

// ---------- quiz setup ----------

function weightedShuffle(entries, weightFn) {
  const maxIdx = maxSessionIndex(state.entries);
  const weigh = weightFn || ((e) => computeWeight(e, maxIdx));
  const withWeight = entries.map((e) => ({ e, w: weigh(e) }));
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

// Share of a capped session reserved for each bucket; the rest goes to older
// words you know, least-recently-seen first. Unused share spills over.
const RECENT_SHARE = 0.4;
const WEAK_SHARE = 0.4;

// Builds a capped session from explicit buckets instead of one weighted draw
// over the whole list — with a long list, 150 old words at weight ~1 would
// otherwise still outvote 15 new words at weight ~5.
function buildStudyQueue(entries, cap) {
  if (entries.length <= cap) return weightedShuffle(entries);
  const maxIdx = maxSessionIndex(state.entries);
  const recent = [];
  const weak = [];
  const rest = [];
  entries.forEach((e) => {
    if (isRecentEntry(e, maxIdx)) recent.push(e);
    else if (isWeak(statFor(e.char))) weak.push(e);
    else rest.push(e);
  });

  const recentPicks = weightedShuffle(recent);
  const weakPicks = weightedShuffle(weak);
  const restPicks = weightedShuffle(rest, reviewWeight);
  const nRecent = Math.round(cap * RECENT_SHARE);
  const nWeak = Math.round(cap * WEAK_SHARE);
  const picked = [
    ...recentPicks.slice(0, nRecent),
    ...weakPicks.slice(0, nWeak),
    ...restPicks.slice(0, cap - nRecent - nWeak),
  ];
  // Top up from whatever buckets still have words, new and weak first.
  const leftovers = [
    ...recentPicks.slice(nRecent),
    ...weakPicks.slice(nWeak),
    ...restPicks.slice(cap - nRecent - nWeak),
  ];
  for (const e of leftovers) {
    if (picked.length >= cap) break;
    picked.push(e);
  }
  return shuffle(picked);
}

function beginQuiz(mode, entries, { skipCap = false } = {}) {
  if (!entries.length) return;
  const studyAll = skipCap || el("study-all-toggle").checked;
  const queue = studyAll ? weightedShuffle(entries) : buildStudyQueue(entries, SESSION_CAP);

  state.mode = mode;
  state.queue = queue;
  state.index = 0;
  state.requeued = new Set();
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

  updateFlagButton(entry);

  if (state.mode === "flashcard") {
    el("quiz-prompt").className = "prompt";
    el("quiz-prompt").textContent = entry.char;
    el("flashcard-area").classList.remove("hidden");
    el("flashcard-answer").textContent = "";
    el("flashcard-hanviet").classList.add("hidden");
    el("flashcard-hanviet").textContent = "";
    el("flashcard-chietu").classList.add("hidden");
    el("flashcard-chietu").textContent = "";
    el("flashcard-sentence").classList.add("hidden");
    el("flashcard-sentence").innerHTML = "";
    el("flip-btn").classList.remove("hidden");
    el("flashcard-rate").classList.add("hidden");
    if (isHanVietEnabled()) ensureHanViet(entry);
    if (isChietuEnabled()) ensureChietu(entry);
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

// Tone-aware comparison used for grading typed pinyin answers, so "wu3"/"w\u01d4"
// count as correct but a toneless "wu" does not. Converts each syllable to a
// base + tone-number form (e.g. "w\u01d4" -> "wu3", untoned "de" -> "de5" for the
// neutral tone) so diacritic and numbered input compare equal.
const TONE_MARK_TO_NUMBER = {
  "\u0304": "1", // macron
  "\u0301": "2", // acute
  "\u030c": "3", // caron
  "\u0300": "4", // grave
};

function toneNumberedSyllable(syllable) {
  let base = "";
  let tone = "";
  for (const ch of syllable.normalize("NFD")) {
    if (TONE_MARK_TO_NUMBER[ch]) tone = TONE_MARK_TO_NUMBER[ch];
    else if (/[0-9]/.test(ch)) tone = ch; // already numbered, e.g. "wu3"
    else base += ch;
  }
  return base + (tone || "5"); // no mark/number found -> neutral tone
}

function normalizePinyinStrict(str) {
  return str
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(toneNumberedSyllable)
    .join(" ");
}

// Typed answers for multi-syllable words often come without spaces. Numbered
// input ("yin1yue4") is split after each tone number; unspaced tone-mark input
// ("yīnyuè") is checked as same letters + same tones in the same order.
function tonesOf(str) {
  let tones = "";
  for (const ch of str.normalize("NFD")) {
    if (TONE_MARK_TO_NUMBER[ch]) tones += TONE_MARK_TO_NUMBER[ch];
    else if (/[1-4]/.test(ch)) tones += ch;
  }
  return tones;
}

function pinyinAnswerMatches(input, expected) {
  const spaced = input.trim().replace(/([1-5])(?=[a-zü])/gi, "$1 ");
  if (normalizePinyinStrict(spaced) === normalizePinyinStrict(expected)) return true;
  if (/\s/.test(input.trim())) return false;
  return normalizePinyin(input) === normalizePinyin(expected) && tonesOf(input) === tonesOf(expected);
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
  if (isHanVietEnabled()) {
    ensureHanViet(entry).then(() => {
      if (currentEntry() !== entry || !entry.hanViet || !isHanVietEnabled()) return;
      const box = el("flashcard-hanviet");
      box.textContent = `Hán Việt: ${entry.hanViet}`;
      box.classList.remove("hidden");
    });
  }
  if (isChietuEnabled()) {
    ensureChietu(entry).then(() => {
      if (currentEntry() !== entry || !entry.chietu || !isChietuEnabled()) return;
      const box = el("flashcard-chietu");
      box.textContent = `Chiết tự: ${entry.chietu}`;
      box.classList.remove("hidden");
    });
  }
}

// Fetches (and caches, per entry) the Hán Việt reading, so it's already in
// hand by the time the learner flips the card instead of making them wait.
// Called as soon as a flashcard question is shown. Dedupes concurrent calls
// for the same entry via a cached in-flight promise.
function ensureHanViet(entry) {
  if (entry.hanViet) return Promise.resolve();
  if (entry._hanVietPromise) return entry._hanVietPromise;
  entry._hanVietPromise = fetch("/api/hanviet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ char: entry.char }),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (ok && data.ok && data.hanViet) entry.hanViet = data.hanViet;
    })
    .catch(() => {
      // ignore — Hán Việt is a nice-to-have, not critical to the flashcard
    })
    .finally(() => {
      entry._hanVietPromise = null;
    });
  return entry._hanVietPromise;
}

// Fetches (and caches, per entry) the chiết tự (character component)
// breakdown, so it's already in hand by the time the learner flips the card.
// Called as soon as a flashcard question is shown. Dedupes concurrent calls
// for the same entry via a cached in-flight promise.
function ensureChietu(entry) {
  if (entry.chietu) return Promise.resolve();
  if (entry._chietuPromise) return entry._chietuPromise;
  entry._chietuPromise = fetch("/api/chietu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ char: entry.char, languageId: state.currentLanguage.id }),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (ok && data.ok && data.chietu) entry.chietu = data.chietu;
    })
    .catch(() => {
      // ignore — chiết tự is a nice-to-have, not critical to the flashcard
    })
    .finally(() => {
      entry._chietuPromise = null;
    });
  return entry._chietuPromise;
}

// How many cards later a missed flashcard comes back within the same run.
const RELEARN_GAP = 4;

function answerFlashcard(known) {
  const entry = currentEntry();
  recordResult(state.currentLanguage.id, entry.char, known);
  if (known) {
    state.correctCount++;
  } else {
    if (!state.missed.includes(entry)) state.missed.push(entry);
    // Show a missed card once more a few cards later, while it's still fresh.
    if (!state.requeued.has(entry)) {
      state.requeued.add(entry);
      const at = Math.min(state.index + 1 + RELEARN_GAP, state.queue.length);
      state.queue.splice(at, 0, entry);
    }
  }
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

// Each story gets a fresh random handful of words rather than the same list
// every time: up to STORY_FOCUS_MAX "focus" words from the newest sessions
// (the model is told to use all of them), topped up with a weighted-random
// mix from the whole list (favoring weak words). Longer stories get more.
const STORY_FOCUS_MAX = 5;

function pickStoryWords(length) {
  const toWord = (e, focus) => ({ char: e.char, pinyin: e.pinyin, focus });
  const recent = recentEntries();
  if (el("study-all-toggle").checked) {
    return state.entries.map((e) => toWord(e, recent.includes(e)));
  }
  const target = Math.min(state.entries.length, Math.max(6, Math.min(16, length * 2 + 2)));
  const focus = shuffle(recent).slice(0, Math.min(STORY_FOCUS_MAX, Math.ceil(target / 2)));
  const others = weightedShuffle(state.entries.filter((e) => !focus.includes(e))).slice(0, target - focus.length);
  return [...focus.map((e) => toWord(e, true)), ...others.map((e) => toWord(e, false))];
}

function startReviewStory() {
  stopSpeaking();
  currentStoryText = "";
  el("speak-story-btn").disabled = true;
  el("story-text").textContent = "Choose a difficulty and length, then generate a story.";
  const n = state.entries.length;
  el("story-word-count").textContent = n
    ? el("study-all-toggle").checked
      ? `Each story tries to use all ${n} words in your list`
      : `Each story picks a fresh mix: your newest words, plus a random handful of the other ${n} words`
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
  const btn = el("generate-story-btn");
  const textEl = el("story-text");

  if (!state.entries.length) {
    textEl.textContent = "No words to build a story from yet — add some characters first.";
    return;
  }

  const hskLevel = Number(el("story-hsk").value) || 3;
  const length = Number(el("story-length").value) || 5;
  const words = pickStoryWords(length);
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
        words,
        hskLevel,
        length,
        format,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "generation failed");
    renderReviewStory(data.story);
    const used = words.filter((w) => data.story.includes(w.char));
    const skippedFocus = words.filter((w) => w.focus && !data.story.includes(w.char));
    el("story-word-count").textContent =
      `Used ${used.length} of ${words.length} picked words` +
      (skippedFocus.length ? ` · new words it skipped: ${skippedFocus.map((w) => w.char).join(" ")}` : "");
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

// ---------- write in Chinese ----------

const COMPOSE_PREFS_KEY = "lang-learner-compose-prefs";
const GRAMMAR_STATS_KEY = "lang-learner-grammar-stats-v1";

// The task on screen, and whether its result was already recorded — checking
// an edited answer again shouldn't count the same task twice in the stats.
let composeTask = null;
let composeRecorded = false;

function loadComposePrefs() {
  try {
    return JSON.parse(localStorage.getItem(COMPOSE_PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveComposePrefs() {
  localStorage.setItem(
    COMPOSE_PREFS_KEY,
    JSON.stringify({
      kind: el("compose-kind").value,
      hsk: el("compose-hsk").value,
      lang: el("compose-lang").value,
    })
  );
}

// Per-language grammar pattern stats, kept separately from word stats but with
// the same recent-weighted error rate, so a pattern you keep getting wrong is
// picked for more tasks until you get it right a few times.
function loadGrammarStats() {
  try {
    return JSON.parse(localStorage.getItem(GRAMMAR_STATS_KEY)) || {};
  } catch {
    return {};
  }
}

function recordPatternResult(pattern, ok) {
  if (!pattern) return;
  const stats = loadGrammarStats();
  const langStats = (stats[state.currentLanguage.id] = stats[state.currentLanguage.id] || {});
  const rec = langStats[pattern] || { seen: 0, wrong: 0 };
  const miss = ok ? 0 : 1;
  rec.errEma = rec.seen ? rec.errEma * 0.6 + miss * 0.4 : miss;
  rec.seen += 1;
  if (!ok) rec.wrong += 1;
  rec.lastSeen = Date.now();
  langStats[pattern] = rec;
  localStorage.setItem(GRAMMAR_STATS_KEY, JSON.stringify(stats));
}

function weakPatterns() {
  const langStats = loadGrammarStats()[state.currentLanguage.id] || {};
  return Object.keys(langStats).filter((p) => langStats[p].errEma >= 0.3);
}

// 1-2 of the newest words plus one from the whole list (weighted toward weak
// ones) — few enough that a short paragraph can use them all naturally.
function pickComposeWords() {
  const focus = shuffle(recentEntries()).slice(0, Math.random() < 0.5 ? 1 : 2);
  const others = weightedShuffle(state.entries.filter((e) => !focus.includes(e)));
  return [...focus, ...others.slice(0, focus.length ? 1 : 2)].map((e) => ({ char: e.char, pinyin: e.pinyin }));
}

function startCompose() {
  const prefs = loadComposePrefs();
  if (prefs.kind) el("compose-kind").value = prefs.kind;
  if (prefs.hsk) el("compose-hsk").value = prefs.hsk;
  if (prefs.lang) el("compose-lang").value = prefs.lang;
  showScreen("compose");
}

async function newComposeTask() {
  saveComposePrefs();
  const kind = el("compose-kind").value;
  const btn = el("compose-new-btn");
  const words = pickComposeWords();
  if (kind === "translate" && !words.length) {
    el("compose-task-text").textContent = "Add some words first — translation tasks are built from your vocabulary.";
    return;
  }

  btn.disabled = true;
  el("compose-check-btn").disabled = true;
  el("compose-task-text").textContent = kind === "translate" ? "Writing a passage for you to translate…" : "Picking a topic…";
  el("compose-source").classList.add("hidden");
  el("compose-targets").classList.add("hidden");
  el("compose-feedback").classList.add("hidden");

  try {
    const res = await fetch("/api/compose-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        words,
        hskLevel: Number(el("compose-hsk").value),
        lang: el("compose-lang").value,
        weakPatterns: weakPatterns(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "couldn't create a task");
    composeTask = data;
    composeRecorded = false;
    renderComposeTask(data);
  } catch (err) {
    el("compose-task-text").textContent = `Couldn't create a task: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderComposeTask(task) {
  el("compose-task-text").textContent = task.task;
  const source = el("compose-source");
  source.textContent = task.source || "";
  source.classList.toggle("hidden", !task.source);

  const words = task.words
    .map((w) => `<span class="compose-word">${escapeHtml(w.char)} <small>${escapeHtml(w.pinyin)}</small></span>`)
    .join("");
  const targets = el("compose-targets");
  targets.innerHTML =
    (words ? `<div><span class="compose-label">Use</span>${words}</div>` : "") +
    `<div><span class="compose-label">Grammar</span>${escapeHtml(task.pattern)}</div>`;
  targets.classList.remove("hidden");

  const input = el("compose-input");
  input.value = "";
  input.disabled = false;
  input.focus();
  el("compose-check-btn").disabled = false;
}

async function checkComposition() {
  const text = el("compose-input").value.trim();
  if (!composeTask || !text) return;
  const btn = el("compose-check-btn");
  const feedbackEl = el("compose-feedback");
  btn.disabled = true;
  feedbackEl.classList.remove("hidden");
  feedbackEl.innerHTML = `<p class="subtle">Checking your writing…</p>`;

  try {
    const res = await fetch("/api/compose-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: composeTask.kind,
        task: composeTask.task,
        source: composeTask.source,
        text,
        words: composeTask.words,
        pattern: composeTask.pattern,
        hskLevel: Number(el("compose-hsk").value),
        lang: el("compose-lang").value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "grading failed");
    renderComposeFeedback(data, text);
    if (!composeRecorded) {
      recordComposeResults(data);
      composeRecorded = true;
    }
  } catch (err) {
    feedbackEl.innerHTML = `<p class="compose-error">Couldn't check it: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// Target words used correctly count as a correct answer, misused ones as a
// miss (so they surface as weak words in other modes). Words left out aren't
// recorded, since skipping a word isn't evidence you don't know it. The
// pattern counts as a miss if it was wrong or avoided.
function recordComposeResults(feedback) {
  const targets = new Set(composeTask.words.map((w) => w.char));
  (feedback.words || []).forEach((w) => {
    if (!targets.has(w.char) || w.status === "missing") return;
    recordResult(state.currentLanguage.id, w.char, w.status === "correct");
  });
  if (feedback.pattern) recordPatternResult(composeTask.pattern, feedback.pattern.status === "correct");
}

// Character-level diff (LCS) between the learner's text and the corrected
// version: [{ type: "same" | "del" | "ins", text }], adjacent runs merged.
function diffChars(before, after) {
  const a = [...before];
  const b = [...after];
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  const push = (type, ch) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += ch;
    else ops.push({ type, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("del", a[i++]);
    } else {
      push("ins", b[j++]);
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return ops;
}

// One span per character so right-click pinyin lookup works on feedback text.
function charSpansHTML(text) {
  return [...text].map((ch) => `<span class="story-char">${escapeHtml(ch)}</span>`).join("");
}

function renderComposeFeedback(fb, original) {
  const parts = [];
  if (fb.summary) parts.push(`<p class="compose-summary">${escapeHtml(fb.summary)}</p>`);

  if (fb.corrected.trim() === original) {
    parts.push(`<h3>Your text</h3><div class="compose-text">${charSpansHTML(original)}</div>`);
    parts.push(`<p class="compose-perfect">No corrections needed 🎉</p>`);
  } else {
    const diff = diffChars(original, fb.corrected.trim())
      .map((op) => {
        const html = charSpansHTML(op.text);
        if (op.type === "del") return `<del class="diff-del">${html}</del>`;
        if (op.type === "ins") return `<ins class="diff-ins">${html}</ins>`;
        return html;
      })
      .join("");
    parts.push(`<h3>Corrections</h3><div class="compose-text">${diff}</div>`);
  }

  if (fb.issues && fb.issues.length) {
    const items = fb.issues
      .map(
        (iss) => `<li class="compose-issue">
          <span class="issue-cat">${escapeHtml(iss.category)}</span>
          <span class="diff-del">${escapeHtml(iss.original)}</span> → <span class="diff-ins">${escapeHtml(iss.correction)}</span>
          <div class="issue-why">${escapeHtml(iss.explanation)}</div>
        </li>`
      )
      .join("");
    parts.push(`<h3>Mistakes</h3><ul class="compose-issues">${items}</ul>`);
  }

  const checks = [];
  if (fb.pattern) {
    const icon = { correct: "✅", incorrect: "❌", missing: "➖" }[fb.pattern.status] || "";
    checks.push(
      `<li>${icon} <b>${escapeHtml(composeTask.pattern)}</b>${fb.pattern.note ? ` — ${escapeHtml(fb.pattern.note)}` : ""}</li>`
    );
  }
  (fb.words || []).forEach((w) => {
    const icon = { correct: "✅", misused: "❌", missing: "➖" }[w.status] || "";
    checks.push(`<li>${icon} <b>${escapeHtml(w.char)}</b>${w.note ? ` — ${escapeHtml(w.note)}` : ""}</li>`);
  });
  if (checks.length) parts.push(`<h3>Targets</h3><ul class="compose-checks">${checks.join("")}</ul>`);

  if (fb.natural && fb.natural.trim() !== fb.corrected.trim()) {
    parts.push(`<h3>How a native speaker might write it</h3><div class="compose-text">${charSpansHTML(fb.natural)}</div>`);
  }
  if (composeTask.reference) {
    parts.push(`<h3>Model translation</h3><div class="compose-text">${charSpansHTML(composeTask.reference)}</div>`);
  }
  parts.push(`<p class="subtle story-hint-text">Edit your text above and check again, or start a new task. Right-click (or long-press) any character for its pinyin.</p>`);

  el("compose-feedback").innerHTML = parts.join("");
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

// Right-click (or long-press on touch) any element matching `selector` inside
// `container` to look up its pinyin — used for both the story text and the
// sentence-builder word chips. A text selection takes priority over the
// element under the cursor, so selecting a multi-character span still works.
function bindPinyinLookup(container, selector) {
  container.addEventListener("contextmenu", (e) => {
    const selection = String(window.getSelection ? window.getSelection().toString() : "").trim();
    let target = selection;
    if (!target) {
      const matched = e.target.closest ? e.target.closest(selector) : null;
      if (matched) target = matched.textContent;
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
      const t = e.target.closest ? e.target.closest(selector) : null;
      if (!t) return;
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
}

function bindGlobalPinyinPopupDismiss() {
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
      chietu: data.chietu || null,
      pinyinVariants: data.pinyinVariants || [],
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

function charLength(word) {
  return [...String(word || "")].length;
}

// Fake words of the same length as `entry`, made by swapping one of its
// characters for a single character from the list. With `homophonesOnly`,
// only swaps that sound the same (ignoring tone) — 音乐 yīn yuè -> 因乐 —
// which make the sharpest "which one is it?" distractors.
function swappedWords(entry, homophonesOnly) {
  const chars = [...entry.char];
  const syllables = entry.pinyin.trim().split(/\s+/);
  if (chars.length < 2 || syllables.length !== chars.length) return [];
  const singles = state.entries.filter((e) => charLength(e.char) === 1);
  const result = [];
  chars.forEach((ch, i) => {
    singles.forEach((s) => {
      if (s.char === ch) return;
      if (homophonesOnly && normalizePinyin(s.pinyin) !== normalizePinyin(syllables[i])) return;
      const swappedChars = chars.slice();
      const swappedSyllables = syllables.slice();
      swappedChars[i] = s.char;
      swappedSyllables[i] = s.pinyin;
      result.push({ char: swappedChars.join(""), pinyin: swappedSyllables.join(" ") });
    });
  });
  return result;
}

// Options always have the same shape as the answer — a two-character word only
// competes with two-character options — so a compound like 音乐 never stands
// out among single characters. Sources, best first: the caller's preferred
// pool (confusables), targeted traps (other readings of a polyphonic character
// for pinyin, same-sounding swaps for characters), real same-length words,
// then made-up same-length swaps. Any-length words are a last resort.
function buildOptions(entry, field, preferredPool) {
  const len = charLength(entry.char);
  const keyOf = (value) => (field === "pinyin" ? normalizePinyinStrict(value) : value);
  const seen = new Set([keyOf(entry[field])]);
  const distractors = [];
  const add = (value) => {
    if (distractors.length >= 3 || !value || seen.has(keyOf(value))) return;
    seen.add(keyOf(value));
    distractors.push(value);
  };
  const sameLength = (e) => charLength(e.char) === len;

  shuffle((preferredPool || []).filter(sameLength)).forEach((e) => add(e[field]));
  if (field === "pinyin") {
    shuffle(entry.pinyinVariants || []).slice(0, 2).forEach(add);
  } else {
    shuffle(swappedWords(entry, true)).slice(0, 2).forEach((w) => add(w.char));
  }
  shuffle(state.entries.filter(sameLength)).forEach((e) => add(e[field]));
  shuffle(swappedWords(entry, false)).forEach((w) => add(w[field]));
  shuffle(state.entries).forEach((e) => add(e[field]));

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

// Holds the correct chunk order(s) (and pinyin) for the current sentence-builder
// question. dndValidOrders holds every grammatically valid ordering of the
// same chunks — the learner's arrangement is correct if it matches any of them.
let dndCorrect = [];
let dndValidOrders = [];
let dndCorrectPinyin = "";

// The last few generated sentences, kept across visits and sent back to the
// server so the model avoids repeating them.
const SENTENCE_HISTORY_KEY = "lang-learner-sentence-history";
const SENTENCE_HISTORY_MAX = 30;

function loadSentenceHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(SENTENCE_HISTORY_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberSentence(sentence) {
  const list = loadSentenceHistory();
  list.push(sentence);
  try {
    localStorage.setItem(SENTENCE_HISTORY_KEY, JSON.stringify(list.slice(-SENTENCE_HISTORY_MAX)));
  } catch {
    // ignore — this only helps variety
  }
}

async function renderSentenceBuilder(entry) {
  const token = ++currentQuestionToken;
  el("dragdrop-area").classList.remove("hidden");
  el("quiz-prompt").className = "prompt";
  el("quiz-prompt").textContent = "Sentence Builder";

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
  let validOrders = [];
  try {
    const res = await fetch("/api/generate-practice-sentence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: entry.words || [], avoid: loadSentenceHistory().slice(-15) }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      sentence = data.sentence;
      chunks = data.chunks;
      sentencePinyin = data.sentencePinyin || "";
      validOrders = Array.isArray(data.validOrders) && data.validOrders.length ? data.validOrders : [chunks];
    }
  } catch {
    // ignore — handled below
  }

  if (token !== currentQuestionToken) return;

  if (!sentence || !Array.isArray(chunks) || chunks.length < 2) {
    el("dnd-status").textContent = "Couldn't generate a sentence — skipping.";
    el("dnd-check-btn").classList.add("hidden");
    el("dnd-reset-btn").classList.add("hidden");
    el("dnd-next-btn").classList.remove("hidden");
    return;
  }

  rememberSentence(sentence);
  dndCorrect = chunks.slice();
  dndValidOrders = validOrders;
  dndCorrectPinyin = sentencePinyin;
  // Stash the answer on the placeholder entry so results/missed chips can show it.
  entry.char = sentence;
  entry.pinyin = sentencePinyin;
  el("dnd-status").textContent = "Arrange the words into a grammatically correct sentence:";
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
  const assembledText = assembled.join("");
  const matchedOrder = dndValidOrders.find((order) => order.join("") === assembledText);
  const known = Boolean(matchedOrder);
  const entry = currentEntry();
  // Highlight against whichever valid order the learner actually matched (or
  // the canonical one, if none matched) so a correct-but-reordered answer
  // doesn't get marked wrong chip-by-chip.
  const referenceOrder = matchedOrder || dndCorrect;

  slots.forEach((s, i) => {
    const chip = s.querySelector(".dnd-chip");
    if (!chip) return;
    chip.classList.toggle("correct", chip.dataset.text === referenceOrder[i]);
    chip.classList.toggle("incorrect", chip.dataset.text !== referenceOrder[i]);
  });

  const feedback = el("dnd-feedback");
  feedback.textContent = known ? "Correct!" : "Not quite — see the answer below.";
  feedback.className = known ? "correct" : "incorrect";

  const pinyinLine = dndCorrectPinyin
    ? `<div class="dnd-answer-pinyin">${escapeHtml(dndCorrectPinyin)}</div>`
    : "";
  // If the sentence allows more than one valid word order, list them all —
  // the learner may have matched an order other than the canonical one.
  const altOrders = dndValidOrders.filter((o) => o !== matchedOrder && o.join("") !== dndCorrect.join(""));
  const altLine = altOrders.length
    ? `<div class="dnd-answer-alt">Also correct: ${altOrders.map((o) => escapeHtml(o.join(""))).join(" · ")}</div>`
    : "";
  el("dnd-answer").innerHTML =
    `<span class="dnd-answer-label">Answer:</span> ${escapeHtml(dndCorrect.join(""))}${pinyinLine}${altLine}`;
  el("dnd-answer").classList.remove("hidden");

  el("dnd-check-btn").classList.add("hidden");
  el("dnd-reset-btn").classList.add("hidden");
  el("dnd-next-btn").classList.remove("hidden");
  el("dragdrop-area").querySelectorAll(".dnd-chip").forEach((c) => (c.draggable = false));

  // Not tied to the vocab list, so there's no per-character stat to update —
  // just track this run's score like the other AI-generated-content modes.
  if (known) state.correctCount++;
  else state.missed.push(entry);
}

// ---------- typing ----------

function submitTyping() {
  const entry = currentEntry();
  const input = el("typing-input").value;
  const known = pinyinAnswerMatches(input, entry.pinyin);
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
      chip.textContent = `${isFlagged(e.char) ? "🚩 " : ""}${e.char} ${e.pinyin}`;
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
      `<span class="rem-word">${isFlagged(e.char) ? "🚩 " : ""}${escapeHtml(e.char)} <span class="rem-pinyin">${escapeHtml(e.pinyin)}</span></span>` +
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
