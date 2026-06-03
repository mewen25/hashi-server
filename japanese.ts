// Strip non-Japanese text from reading passages. Works line-by-line so that
// mixed pages/transcripts (Japanese interleaved with English UI text, credits,
// ads, romaji, etc.) collapse down to just the Japanese sections.
//
// Granularity is intentionally whole-line: a line that is *substantially*
// Japanese is kept verbatim (stray Latin words or numbers inside a Japanese
// sentence survive), while lines that are predominantly non-Japanese are
// dropped entirely.

// Hiragana, katakana (incl. the ー prolonged-sound mark) and half-width kana.
const KANA = "\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC\\uFF66-\\uFF9D";
// CJK ideographs (kanji), extension A, and the 々〇〻 iteration marks.
const CJK = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\u3005\\u3007\\u303B";

const KANA_CHAR = new RegExp(`[${KANA}]`, "u");
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const JA_CHAR = new RegExp(`[${KANA}${CJK}]`, "u");
// Counts toward the "meaningful" denominator: letters (any script) and digits.
// Punctuation, symbols and whitespace are ignored so a line is judged on its
// actual words, not on how much punctuation it carries.
const WORD_CHAR = /[\p{L}\p{N}]/u;

// For kana-less lines (e.g. a pure-kanji heading), the fraction of word
// characters that must be CJK to count as Japanese. Lines with any kana are
// always kept, since kana is an unambiguous Japanese signal that English text
// never carries — this keeps Japanese sentences that embed English terms.
const CJK_RATIO = 0.5;

export function containsJapanese(text: string): boolean {
  return JA_CHAR.test(text);
}

// Decide whether a single line is "substantially Japanese". Blank lines are
// kept as structural separators (collapsed afterwards by filterJapanese).
export function isJapaneseLine(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  let kana = 0;
  let cjk = 0;
  let meaningful = 0;
  for (const ch of s) {
    if (!WORD_CHAR.test(ch)) continue; // skip punctuation / symbols / spaces
    meaningful++;
    if (KANA_CHAR.test(ch)) kana++;
    else if (CJK_CHAR.test(ch)) cjk++;
  }
  if (meaningful === 0) return false; // numbers/punctuation-only line: drop
  if (kana > 0) return true; // any kana → Japanese (keeps mixed lines intact)
  return cjk / meaningful >= CJK_RATIO; // kana-less: keep only kanji-dominant lines
}

// Keep only the Japanese lines of a passage, preserving paragraph breaks.
// Returns "" when there is no Japanese content at all.
export function filterJapanese(text: string): string {
  return text
    .split("\n")
    .filter(isJapaneseLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // close gaps left where lines were removed
    .trim();
}
