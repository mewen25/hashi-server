// Reading passages for the front-end 'read' page: pasted text, scraped
// articles, and video transcripts. Stored in cards.db alongside the SRS data.

import { Database } from "bun:sqlite";

const db = new Database(Bun.env.CARDS_DB_PATH ?? "cards.db");
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS passages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    source_url TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT '',
    char_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_passages_created ON passages(created_at)`);

export type PassageKind = "text" | "article" | "video";

export interface Passage {
  id: number;
  title: string;
  kind: PassageKind;
  source_url: string;
  content: string;
  lang: string;
  char_count: number;
  created_at: number;
}

// List view omits the full content but carries a short preview.
export type PassageSummary = Omit<Passage, "content"> & { preview: string };

const PREVIEW_LEN = 160;

function preview(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN) + "…" : flat;
}

export function listPassages(): PassageSummary[] {
  const rows = db
    .query<Omit<Passage, "content"> & { content: string }, []>(
      `SELECT id, title, kind, source_url, content, lang, char_count, created_at
       FROM passages ORDER BY created_at DESC`,
    )
    .all();
  return rows.map(({ content, ...rest }) => ({ ...rest, preview: preview(content) }));
}

export function getPassage(id: number): Passage | null {
  return (
    db
      .query<Passage, [number]>(`SELECT * FROM passages WHERE id = ?`)
      .get(id) ?? null
  );
}

export function createPassage(input: {
  content: string;
  title?: string;
  kind?: PassageKind;
  source_url?: string;
  lang?: string;
}): Passage {
  const content = input.content;
  if (!content.trim()) throw new Error("content is empty");
  const created_at = Date.now();
  const { lastInsertRowid } = db.run(
    `INSERT INTO passages (title, kind, source_url, content, lang, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title?.trim() ?? "",
      input.kind ?? "text",
      input.source_url ?? "",
      content,
      input.lang ?? "",
      content.length,
      created_at,
    ],
  );
  return getPassage(Number(lastInsertRowid))!;
}

export function deletePassage(id: number): boolean {
  return db.run(`DELETE FROM passages WHERE id = ?`, [id]).changes > 0;
}
