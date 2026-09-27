// Converts Chinese characters to pinyin with tone marks (e.g. 你好 -> "nǐ hǎo").
// Uses pinyin-pro, which is context-aware for polyphonic characters
// (e.g. 银行 correctly reads "yín háng", not "yín xíng").

const { pinyin } = require("pinyin-pro");

// Returns tone-marked pinyin for the given text, or "" if there's nothing
// convertible (e.g. input was empty or had no Han characters).
function toPinyin(text) {
  const input = String(text || "").trim();
  if (!input) return "";
  const result = pinyin(input, { toneType: "symbol" });
  return typeof result === "string" ? result.trim() : "";
}

const TONE_MARKS = /[̄́̌̀]/g;

function toneless(syllable) {
  return syllable.normalize("NFD").replace(TONE_MARKS, "");
}

function isNeutralTone(syllable) {
  return !syllable.normalize("NFD").match(TONE_MARKS);
}

// For a multi-character word, returns wrong-but-plausible readings made by
// swapping one character's reading for another reading that character has
// elsewhere (音乐 yīn yuè -> "yīn lè", since 乐 on its own is usually lè).
// Used as multiple-choice distractors: they test exactly the "this character
// reads differently inside this word" knowledge. Readings that differ only by
// a neutral tone (朋友 péng you vs yǒu) are skipped, since both are acceptable.
function pinyinVariants(word, wordPinyin) {
  const chars = [...String(word || "").trim()];
  const syllables = String(wordPinyin || "").trim().split(/\s+/);
  if (chars.length < 2 || syllables.length !== chars.length) return [];

  const variants = new Set();
  chars.forEach((ch, i) => {
    const readings = pinyin(ch, { multiple: true, type: "array" }) || [];
    if (readings.length < 2) return; // not polyphonic (or not a Han character)
    readings.slice(0, 3).forEach((alt) => {
      const current = syllables[i];
      if (alt === current) return;
      if (toneless(alt) === toneless(current) && (isNeutralTone(alt) || isNeutralTone(current))) return;
      const next = syllables.slice();
      next[i] = alt;
      variants.add(next.join(" "));
    });
  });
  return [...variants];
}

module.exports = { toPinyin, pinyinVariants };
