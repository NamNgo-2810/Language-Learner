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

module.exports = { toPinyin };
