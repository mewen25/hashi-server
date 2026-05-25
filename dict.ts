import { Database } from "bun:sqlite";

interface RawEntry {
  p?: string;
  ro?: string;
  alt?: string;
  en?: string;
  sound?: string | null;
  image?: string | null;
}

interface OutputEntry {
  id: string;
  p: string;
  ro: string;
  alt: string;
  en: string;
  sound?: string;
  image?: string;
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

// Strip ASCII + JP punctuation and whitespace so phrases stored with a
// trailing 。 (e.g. "わかりません。") still match a query of "わかりません".
function normaliseKey(s: string): string {
  return s.replace(/[\s　]+/g, "").replace(/[。、！？!?.,]+$/u, "").trim();
}

function indexUnder(map: Map<string, OutputEntry>, key: string, entry: OutputEntry) {
  const existing = map.get(key);
  if (!existing || (!existing.sound && entry.sound)) map.set(key, entry);
}

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
    image: val.image || undefined,
  };
  entries.push(entry);
  // Index under both raw and normalised forms so callers that didn't
  // already strip punctuation still hit. The "prefer the one with a sound"
  // tiebreak applies independently to each key.
  indexUnder(byAlt, alt, entry);
  indexUnder(byReading, val.p, entry);
  const altNorm = normaliseKey(alt);
  if (altNorm && altNorm !== alt) indexUnder(byAlt, altNorm, entry);
  const readingNorm = normaliseKey(val.p);
  if (readingNorm && readingNorm !== val.p) indexUnder(byReading, readingNorm, entry);
}

export function lookupOutputEntry(text: string): OutputEntry | null {
  const raw = text.trim();
  const hit = byAlt.get(raw) ?? byReading.get(raw);
  if (hit) return hit;
  const norm = normaliseKey(text);
  if (!norm || norm === raw) return null;
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

export type VocabSearchField = "kana" | "romaji" | "en" | "kanji" | "any";

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// Sliding-window distance so a short query (e.g. "konichi") can match a
// longer target ("konnichiwa") without being penalised for the extra chars.
function fuzzyScore(query: string, target: string): number {
  if (!query || !target) return Infinity;
  if (target === query) return 0;
  if (target.includes(query)) return 0;
  if (target.length <= query.length + 2) return levenshtein(query, target);
  const win = query.length + 1;
  let best = levenshtein(query, target.slice(0, win));
  for (let i = 1; i + win <= target.length; i++) {
    const d = levenshtein(query, target.slice(i, i + win));
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

function fieldsOf(v: VocabEntry, field: VocabSearchField): string[] {
  switch (field) {
    case "kana": return [v.reading];
    case "romaji": return [v.romaji];
    case "en": return [v.en];
    case "kanji": return [v.kanji];
    default: return [v.reading, v.romaji, v.en, v.kanji];
  }
}

export function searchVocabulary(opts: {
  q: string;
  field?: VocabSearchField;
  fuzzy?: boolean;
}): { entries: VocabEntry[]; scores?: number[] } {
  const q = opts.q.trim().toLowerCase();
  const field = opts.field ?? "any";
  if (!q) return { entries: vocabList };
  if (!opts.fuzzy) {
    const entries = vocabList.filter((v) =>
      fieldsOf(v, field).some((s) => s.toLowerCase().includes(q)),
    );
    return { entries };
  }
  const threshold = Math.max(2, Math.floor(q.length / 2));
  const scored: { v: VocabEntry; score: number }[] = [];
  for (const v of vocabList) {
    let best = Infinity;
    for (const f of fieldsOf(v, field)) {
      if (!f) continue;
      const d = fuzzyScore(q, f.toLowerCase());
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= threshold) scored.push({ v, score: best });
  }
  scored.sort((a, b) => a.score - b.score || (Number(a.v.id) || 0) - (Number(b.v.id) || 0));
  return { entries: scored.map((s) => s.v), scores: scored.map((s) => s.score) };
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
