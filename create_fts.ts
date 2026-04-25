import { Database } from "bun:sqlite";

const jmdict = new Database("jmdict.db", { readonly: true });
const ftsDb = new Database("dict_fts.db");

ftsDb.exec("DROP TABLE IF EXISTS entries_fts");
ftsDb.exec(`
  CREATE VIRTUAL TABLE entries_fts USING fts5(
    kanji, reading, gloss, pos,
    first_gloss UNINDEXED,
    top_glosses UNINDEXED,
    priority UNINDEXED
  );
`);

const rows = jmdict
  .prepare(
    "SELECT kanji, reading, gloss, pos, first_gloss, top_glosses, priority FROM entries"
  )
  .all() as Array<{
    kanji: string;
    reading: string;
    gloss: string;
    pos: string;
    first_gloss: string;
    top_glosses: string;
    priority: number;
  }>;

ftsDb.exec("BEGIN TRANSACTION");

const insert = ftsDb.prepare(`
  INSERT INTO entries_fts (kanji, reading, gloss, pos, first_gloss, top_glosses, priority)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

for (const row of rows) {
  insert.run(
    row.kanji,
    row.reading,
    row.gloss,
    row.pos,
    row.first_gloss,
    row.top_glosses,
    row.priority
  );
}

ftsDb.exec("COMMIT");

console.log("FTS database created with", rows.length, "entries");

ftsDb.close();
jmdict.close();
