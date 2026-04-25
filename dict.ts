import { Database } from "bun:sqlite";

const jmdict = new Database("jmdict.db", { readonly: true });
const ftsDb = new Database("dict_fts.db", { readonly: true });

const byWord = jmdict.query<
  { kanji: string; reading: string; gloss: string; pos: string },
  [string, string]
>(
  "SELECT kanji, reading, gloss, pos FROM entries WHERE kanji = ? OR reading = ? LIMIT 1"
);

// Composite score, lower = better. Sums:
//   - priority (1=most common in JMdict's wordfreq, 9999=untagged)
//   - +24 if the term isn't a complete item in top_glosses (top 3 glosses of
//          sense 1) — pushes 玉's 31st-sense "beautiful" below 綺麗.
//   - +24 if the term isn't the entry's first gloss (Jisho-style headword boost)
//   - +8  if the term doesn't appear as a complete `; `-separated gloss item
//          anywhere (so "beautiful woman" doesn't match "beautiful")
//   - +32 if the entry has no kanji form (demotes katakana-only loanwords)
const suggestStmt = ftsDb.query<
  {
    kanji: string;
    reading: string;
    gloss: string;
    first_gloss: string;
    pri: number;
  },
  [string, string, string, string]
>(`
  SELECT kanji, reading, gloss, first_gloss, CAST(priority AS INTEGER) AS pri
  FROM entries_fts
  WHERE entries_fts MATCH ?
  ORDER BY
    CAST(priority AS INTEGER)
    + CASE
        WHEN '; ' || lower(top_glosses) || ';' LIKE '%; ' || ? || ';%' THEN 0
        ELSE 24
      END
    + CASE WHEN lower(first_gloss) = ? THEN 0 ELSE 24 END
    + CASE
        WHEN '; ' || lower(gloss) || ';' LIKE '%; ' || ? || ';%' THEN 0
        ELSE 8
      END
    + CASE WHEN kanji = '' THEN 32 ELSE 0 END
    ASC,
    rank
  LIMIT 10
`);

export interface EnSuggestion {
  jp: string;
  r: string;
  en: string;
}

function ftsQuery(q: string): string {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" ");
}

export async function suggestEn(q: string): Promise<EnSuggestion[]> {
  const norm = q.toLowerCase().trim();
  const fts = ftsQuery(q);
  if (!fts) return [];
  const rows = suggestStmt.all(fts, norm, norm, norm);
  return rows.map((row) => ({
    jp: row.kanji,
    r: row.reading,
    en: row.gloss,
  }));
}

export interface WordEntry {
  kanji: string;
  reading: string;
  gloss: string;
  pos: string;
}

export async function getWord(word: string): Promise<WordEntry | null> {
  const row = byWord.get(word, word);
  if (!row) return null;
  return {
    kanji: row.kanji,
    reading: row.reading,
    gloss: row.gloss,
    pos: row.pos,
  };
}
