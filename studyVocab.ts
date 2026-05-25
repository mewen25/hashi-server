// Study vocabulary management: chapters + word lifecycle (intro → MC → review).
// Stores in cards.db alongside the SRS cards.

import { Database } from "bun:sqlite";
import { lookupOutputEntry } from "./dict";

const db = new Database(Bun.env.CARDS_DB_PATH ?? "cards.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sv_chapters (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sv_vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id TEXT NOT NULL REFERENCES sv_chapters(id) ON DELETE CASCADE,
    output_id TEXT,
    kanji TEXT NOT NULL,
    reading TEXT NOT NULL,
    gloss TEXT NOT NULL DEFAULT '',
    pos TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    example_jp TEXT NOT NULL DEFAULT '',
    example_en TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'intro',
    learning_streak INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER,
    created_at INTEGER NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_sv_vocab_chapter ON sv_vocab(chapter_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sv_vocab_state ON sv_vocab(state)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sv_vocab_due ON sv_vocab(due_at)`);

// ── Types ─────────────────────────────────────────────────────────────

export type WordState = "intro" | "learning" | "review" | "parked";
export type Rating = "again" | "hard" | "good" | "easy";
export type VocabAction = "hurry" | "slow" | "park" | "unpark";

export interface SvChapter {
  id: string;
  title: string;
  subtitle: string;
  counts: { intro: number; learning: number; review: number; parked: number };
}

export interface SvVocab {
  id: number;
  chapter_id: string;
  kanji: string;
  reading: string;
  gloss: string;
  pos?: string;
  note?: string;
  example_jp?: string;
  example_en?: string;
  state: WordState;
  learning_streak: number;
  due_at?: number;
  sound?: string;
  // Relative path to the illustration SVG, e.g. "svg/<hash>.svg".
  // Clients prefix with the server base URL to fetch it.
  image?: string;
}

type DbVocab = {
  id: number;
  chapter_id: string;
  output_id: string | null;
  kanji: string;
  reading: string;
  gloss: string;
  pos: string;
  note: string;
  example_jp: string;
  example_en: string;
  state: string;
  learning_streak: number;
  due_at: number | null;
  created_at: number;
};

export interface StudyCard {
  kind: "intro" | "mc" | "review";
  vocab: SvVocab;
  options?: string[];
  correct?: string;
}

export interface AnswerInput {
  vocab_id: number;
  kind: "intro" | "mc" | "review";
  correct?: boolean;
  rating?: Rating;
}

export interface BulkAddResult {
  added: SvVocab[];
  deduped: { kanji: string; reading?: string; gloss?: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;
const LEARNING_GRADUATE_STREAK = 3;
const INTRO_BATCH = 3;
const SESSION_LIMIT = 20;

const REVIEW_INTERVAL_MS: Record<Rating, number> = {
  again: 1 * MS_PER_MIN,
  hard: 6 * MS_PER_MIN,
  good: 4 * MS_PER_DAY,
  easy: 10 * MS_PER_DAY,
};

function toSvVocab(row: DbVocab): SvVocab {
  const entry = row.output_id ? lookupOutputEntry(row.kanji) ?? lookupOutputEntry(row.reading) : null;
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    kanji: row.kanji,
    reading: row.reading,
    gloss: row.gloss || undefined as unknown as string,
    pos: row.pos || undefined,
    note: row.note || undefined,
    example_jp: row.example_jp || undefined,
    example_en: row.example_en || undefined,
    state: row.state as WordState,
    learning_streak: row.learning_streak,
    due_at: row.due_at ?? undefined,
    sound: entry?.sound,
    image: entry?.image,
  };
}

function chapterCounts(chapterId: string): SvChapter["counts"] {
  const rows = db
    .query<{ state: string; n: number }, [string]>(
      `SELECT state, COUNT(*) as n FROM sv_vocab WHERE chapter_id = ? GROUP BY state`,
    )
    .all(chapterId);
  const c = { intro: 0, learning: 0, review: 0, parked: 0 };
  for (const r of rows) {
    if (r.state in c) (c as Record<string, number>)[r.state] = r.n;
  }
  return c;
}

function getChapterRow(id: string): { id: string; title: string; subtitle: string; created_at: number } | null {
  return (
    db
      .query<{ id: string; title: string; subtitle: string; created_at: number }, [string]>(
        `SELECT * FROM sv_chapters WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

function toSvChapter(row: { id: string; title: string; subtitle: string }): SvChapter {
  return { ...row, counts: chapterCounts(row.id) };
}

// ── Chapters ──────────────────────────────────────────────────────────

export function listChapters(): SvChapter[] {
  const rows = db
    .query<{ id: string; title: string; subtitle: string; created_at: number }, []>(
      `SELECT * FROM sv_chapters ORDER BY created_at ASC`,
    )
    .all();
  return rows.map(toSvChapter);
}

export function createChapter(input: { title: string; subtitle?: string }): SvChapter {
  const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();
  db.run(`INSERT INTO sv_chapters (id, title, subtitle, created_at) VALUES (?, ?, ?, ?)`, [
    id,
    input.title,
    input.subtitle ?? "",
    now,
  ]);
  return toSvChapter({ id, title: input.title, subtitle: input.subtitle ?? "" });
}

export function patchChapter(id: string, input: { title?: string; subtitle?: string }): SvChapter | null {
  const row = getChapterRow(id);
  if (!row) return null;
  const title = input.title ?? row.title;
  const subtitle = input.subtitle ?? row.subtitle;
  db.run(`UPDATE sv_chapters SET title = ?, subtitle = ? WHERE id = ?`, [title, subtitle, id]);
  return toSvChapter({ id, title, subtitle });
}

export function deleteChapter(id: string): boolean {
  const result = db.run(`DELETE FROM sv_chapters WHERE id = ?`, [id]);
  return result.changes > 0;
}

// ── Vocabulary ────────────────────────────────────────────────────────

const listVocabStmt = db.query<DbVocab, []>(`SELECT * FROM sv_vocab ORDER BY id ASC`);

export function listVocabulary(opts: {
  chapter?: string;
  state?: WordState;
  q?: string;
  limit?: number;
}): SvVocab[] {
  let rows = listVocabStmt.all();
  if (opts.chapter) rows = rows.filter((r) => r.chapter_id === opts.chapter);
  if (opts.state) rows = rows.filter((r) => r.state === opts.state);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.kanji.includes(opts.q!) ||
        r.reading.includes(opts.q!) ||
        r.gloss.toLowerCase().includes(q),
    );
  }
  if (opts.limit != null) rows = rows.slice(0, opts.limit);
  return rows.map(toSvVocab);
}

export function bulkAddVocabulary(input: {
  chapter_id: string;
  words: { kanji: string; reading?: string; gloss?: string }[];
}): BulkAddResult {
  const added: SvVocab[] = [];
  const deduped: typeof input.words = [];
  const now = Date.now();

  const chapterExists = !!getChapterRow(input.chapter_id);
  if (!chapterExists) throw new Error("chapter not found");

  const insertStmt = db.prepare<{ id: number }, [string, string | null, string, string, string, number]>(
    `INSERT INTO sv_vocab (chapter_id, output_id, kanji, reading, gloss, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  );

  const existsStmt = db.query<{ id: number }, [string, string]>(
    `SELECT id FROM sv_vocab WHERE chapter_id = ? AND kanji = ? LIMIT 1`,
  );

  for (const w of input.words) {
    if (existsStmt.get(input.chapter_id, w.kanji)) {
      deduped.push(w);
      continue;
    }

    // Try to enrich from output.json
    const entry = lookupOutputEntry(w.kanji) ?? (w.reading ? lookupOutputEntry(w.reading) : null);
    const kanji = w.kanji;
    const reading = w.reading ?? entry?.p ?? w.kanji;
    const gloss = w.gloss ?? entry?.en ?? "";
    const outputId = entry?.id ?? null;

    const row = insertStmt.get(input.chapter_id, outputId, kanji, reading, gloss, now);
    if (row) {
      const full = db.query<DbVocab, [number]>(`SELECT * FROM sv_vocab WHERE id = ?`).get(row.id);
      if (full) added.push(toSvVocab(full));
    }
  }

  return { added, deduped };
}

export function patchVocabulary(
  id: number,
  input: { action?: VocabAction; state?: WordState },
): SvVocab | null {
  const row = db.query<DbVocab, [number]>(`SELECT * FROM sv_vocab WHERE id = ?`).get(id);
  if (!row) return null;

  let { state, learning_streak } = row as { state: string; learning_streak: number };
  let due_at = row.due_at;

  if (input.action) {
    const action = input.action;
    if (action === "park") {
      state = "parked";
    } else if (action === "unpark") {
      state = "learning";
      learning_streak = 0;
    } else if (action === "hurry") {
      if (state === "intro") state = "learning";
      else if (state === "learning") {
        state = "review";
        due_at = Date.now();
      }
      learning_streak = 0;
    } else if (action === "slow") {
      if (state === "review") { state = "learning"; learning_streak = 0; }
      else if (state === "learning") { state = "intro"; learning_streak = 0; }
    }
  }

  if (input.state) state = input.state;

  db.run(
    `UPDATE sv_vocab SET state = ?, learning_streak = ?, due_at = ? WHERE id = ?`,
    [state, learning_streak, due_at, id],
  );
  return toSvVocab(db.query<DbVocab, [number]>(`SELECT * FROM sv_vocab WHERE id = ?`).get(id)!);
}

export function deleteVocabulary(id: number): boolean {
  const result = db.run(`DELETE FROM sv_vocab WHERE id = ?`, [id]);
  return result.changes > 0;
}

// ── Session ───────────────────────────────────────────────────────────

function shuffled<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T; out[i] = out[j] as T; out[j] = tmp;
  }
  return out;
}

function pickDistractors(target: DbVocab, pool: DbVocab[]): string[] {
  const siblings = shuffled(
    pool.filter((v) => v.id !== target.id && v.chapter_id === target.chapter_id && v.gloss && v.gloss !== target.gloss),
  ).map((v) => v.gloss);
  const unique = Array.from(new Set(siblings));
  const picked = unique.slice(0, 3);
  if (picked.length < 3) {
    const global = shuffled(
      pool.filter((v) => v.gloss !== target.gloss && !picked.includes(v.gloss)).map((v) => v.gloss),
    );
    for (const g of global) {
      if (picked.length >= 3) break;
      if (!picked.includes(g)) picked.push(g);
    }
  }
  return picked;
}

export function getStudyToday(opts: { chapter?: string; limit?: number }): StudyCard[] {
  const now = Date.now();
  const allRows = listVocabStmt.all();
  const pool = opts.chapter ? allRows.filter((r) => r.chapter_id === opts.chapter) : allRows;

  const intros = pool.filter((r) => r.state === "intro").slice(0, INTRO_BATCH);
  const learning = pool.filter((r) => r.state === "learning");
  const reviews = pool.filter((r) => r.state === "review" && (r.due_at == null || r.due_at <= now));

  const cards: StudyCard[] = [];
  for (const v of intros) cards.push({ kind: "intro", vocab: toSvVocab(v) });
  for (const v of learning) {
    const distractors = pickDistractors(v, pool);
    const options = shuffled([v.gloss, ...distractors]);
    cards.push({ kind: "mc", vocab: toSvVocab(v), options, correct: v.gloss });
  }
  for (const v of reviews) cards.push({ kind: "review", vocab: toSvVocab(v) });

  return cards.slice(0, opts.limit ?? SESSION_LIMIT);
}

export function postStudyAnswer(input: AnswerInput): SvVocab | null {
  const row = db.query<DbVocab, [number]>(`SELECT * FROM sv_vocab WHERE id = ?`).get(input.vocab_id);
  if (!row) return null;

  let { state, learning_streak } = row as { state: string; learning_streak: number };
  let due_at = row.due_at;
  const now = Date.now();

  if (input.kind === "intro") {
    state = "learning";
    learning_streak = 0;
  } else if (input.kind === "mc") {
    if (input.correct) {
      learning_streak += 1;
      if (learning_streak >= LEARNING_GRADUATE_STREAK) {
        state = "review";
        due_at = now;
      }
    } else {
      learning_streak = Math.max(0, learning_streak - 1);
    }
  } else if (input.kind === "review") {
    const rating = input.rating ?? "good";
    due_at = now + REVIEW_INTERVAL_MS[rating];
    if (rating === "again") {
      state = "learning";
      learning_streak = 0;
    }
  }

  db.run(
    `UPDATE sv_vocab SET state = ?, learning_streak = ?, due_at = ? WHERE id = ?`,
    [state, learning_streak, due_at, input.vocab_id],
  );
  return toSvVocab(db.query<DbVocab, [number]>(`SELECT * FROM sv_vocab WHERE id = ?`).get(input.vocab_id)!);
}
