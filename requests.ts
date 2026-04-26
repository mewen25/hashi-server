import { Database } from "bun:sqlite";

const db = new Database(Bun.env.REQUESTS_DB_PATH ?? "requests.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    query TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    first_requested_at INTEGER NOT NULL,
    last_requested_at INTEGER NOT NULL
  )
`);

const upsert = db.prepare<
  unknown,
  [string, number]
>(`
  INSERT INTO requests (query, count, first_requested_at, last_requested_at)
  VALUES (?1, 1, ?2, ?2)
  ON CONFLICT(query) DO UPDATE SET
    count = count + 1,
    last_requested_at = excluded.last_requested_at
`);

export function logRequest(query: string): void {
  upsert.run(query, Date.now());
}
