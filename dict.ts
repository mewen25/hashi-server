import { Database } from "bun:sqlite";

interface RawEntry {
  p?: string;
  ro?: string;
  alt?: string;
  en?: string;
  sound?: string | null;
}

interface OutputEntry {
  id: string;
  p: string;
  ro: string;
  alt: string;
  en: string;
  sound?: string;
}

const jmdict = new Database("jmdict.db", { readonly: true });
const ftsDb = new Database("dict_fts.db", { readonly: true });

const byWord = jmdict.query<
  { kanji: string; reading: string; gloss: string; pos: string },
  [string, string]
>(
  "SELECT kanji, reading, gloss, pos FROM entries WHERE kanji = ? OR reading = ? LIMIT 1"
);

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

let raw: Record<string, RawEntry> = {};
try {
  raw = JSON.parse(await Bun.file("output.json").text());
} catch (e) {
  console.error("Failed to load output.json:", e);
}

const entries: OutputEntry[] = [];
const byAlt = new Map<string, OutputEntry>();
const byReading = new Map<string, OutputEntry>();

for (const [id, val] of Object.entries(raw)) {
  if (!val.p) continue;
  const alt = val.alt || val.p;
  const entry: OutputEntry = {
    id,
    p: val.p,
    ro: val.ro || "",
    alt,
    en: val.en || "",
    sound: val.sound || undefined,
  };
  entries.push(entry);
  // For duplicate alt/reading, prefer the entry that has a sound file
  const existingAlt = byAlt.get(alt);
  if (!existingAlt || (!existingAlt.sound && entry.sound)) {
    byAlt.set(alt, entry);
  }
  const existingReading = byReading.get(val.p);
  if (!existingReading || (!existingReading.sound && entry.sound)) {
    byReading.set(val.p, entry);
  }
}

export function lookupOutputEntry(text: string): OutputEntry | null {
  const norm = text.trim();
  return byAlt.get(norm) ?? byReading.get(norm) ?? null;
}

export interface EnSuggestion {
  jp: string;
  r: string;
  en: string;
}

export interface WordEntry {
  kanji: string;
  reading: string;
  gloss: string;
  pos: string;
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
  if (!norm) return [];
  const terms = norm.split(/[^a-z0-9]+/).filter(Boolean);
  if (!terms.length) return [];

  // output.json results (prioritised)
  const local = entries
    .map(e => {
      if (!e.en) return null;
      const en = e.en.toLowerCase();
      if (!terms.every(t => en.includes(t))) return null;

      let score = terms.reduce((s, t) => {
        if (en.startsWith(t)) return s + 1;
        if (en.includes(` ${t}`) || en.includes(`; ${t}`)) return s + 2;
        if (en === t) return s + 0;
        return s + 3;
      }, 0);

      score += en.length / 100;

      return { jp: e.alt || e.p, r: e.ro || "", en: e.en, score };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map(({ jp, r, en }) => ({ jp, r, en }));

  // JMdict FTS results
  const fts = ftsQuery(q);
  const jmdictResults = fts
    ? suggestStmt.all(fts, norm, norm, norm).map((row) => ({
        jp: row.kanji,
        r: row.reading,
        en: row.gloss,
      }))
    : [];

  // Deduplicate: prefer output.json entries, append JMdict ones not already present
  const seen = new Set(local.map((s) => s.jp + s.r));
  const combined = [...local];
  for (const r of jmdictResults) {
    if (!seen.has(r.jp + r.r)) {
      combined.push(r);
      seen.add(r.jp + r.r);
    }
  }

  return combined.slice(0, 10);
}

export interface VocabEntry {
  id: string;
  kanji: string;
  reading: string;
  romaji: string;
  en: string;
  sound?: string;
}

function toVocabEntry(id: string, e: RawEntry): VocabEntry | null {
  if (!e.p) return null;
  return {
    id,
    kanji: e.alt || e.p,
    reading: e.p,
    romaji: e.ro || "",
    en: e.en || "",
    sound: e.sound || undefined,
  };
}

const vocabList: VocabEntry[] = Object.entries(raw)
  .map(([id, v]) => toVocabEntry(id, v))
  .filter((v): v is VocabEntry => v !== null)
  .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

export function getVocabulary(id: string): VocabEntry | null {
  const e = raw[id];
  return e ? toVocabEntry(id, e) : null;
}

export function listVocabulary(): VocabEntry[] {
  return vocabList;
}

export async function getWord(word: string): Promise<WordEntry | null> {
  const entry = lookupOutputEntry(word);
  if (entry) {
    return {
      kanji: entry.alt,
      reading: entry.p,
      gloss: entry.en || "",
      pos: "",
    };
  }
  const row = byWord.get(word, word);
  if (!row) return null;
  return {
    kanji: row.kanji,
    reading: row.reading,
    gloss: row.gloss,
    pos: row.pos,
  };
}
