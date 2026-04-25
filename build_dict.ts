import { Database } from "bun:sqlite";
import { XMLParser } from "fast-xml-parser";

const SOURCE_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz";
const GZ_PATH = "JMdict_e.gz";
const XML_PATH = "JMdict_e.xml";
const DB_PATH = "jmdict.db";

async function ensureXml() {
  if (await Bun.file(XML_PATH).exists()) return;
  if (!(await Bun.file(GZ_PATH).exists())) {
    console.log(`Downloading ${SOURCE_URL}...`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await Bun.write(GZ_PATH, await res.bytes());
  }
  console.log("Decompressing JMdict_e.gz...");
  const gz = await Bun.file(GZ_PATH).bytes();
  const xml = Bun.gunzipSync(gz);
  await Bun.write(XML_PATH, xml);
}

await ensureXml();

console.log("Reading XML...");
let xml = await Bun.file(XML_PATH).text();

const entities: Record<string, string> = {};
const dtdMatch = xml.match(/<!DOCTYPE[\s\S]*?\]>/);
if (dtdMatch) {
  for (const m of dtdMatch[0].matchAll(/<!ENTITY\s+(\S+)\s+"([^"]+)">/g)) {
    entities[m[1]] = m[2];
  }
  xml = xml.replace(dtdMatch[0], "");
}
console.log(`Found ${Object.keys(entities).length} DTD entities.`);

const xmlBuiltins = new Set(["amp", "lt", "gt", "quot", "apos"]);
xml = xml.replace(/&([a-zA-Z][a-zA-Z0-9-]*);/g, (match, name) => {
  if (xmlBuiltins.has(name)) return match;
  return entities[name] ?? match;
});

console.log("Parsing XML...");
const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) =>
    [
      "entry",
      "k_ele",
      "r_ele",
      "sense",
      "ke_inf",
      "ke_pri",
      "re_inf",
      "re_pri",
      "pos",
      "gloss",
      "misc",
      "field",
      "lsource",
      "stagk",
      "stagr",
      "xref",
      "ant",
    ].includes(name),
});

const doc = parser.parse(xml);
const entries: any[] = doc.JMdict.entry;
console.log(`Parsed ${entries.length} entries.`);

function priorityScore(priList: string[]): number {
  let best = 9999;
  for (const pri of priList) {
    let s = 9999;
    if (pri.startsWith("nf")) {
      const n = parseInt(pri.slice(2), 10);
      if (!Number.isNaN(n)) s = n;
    } else if (pri === "ichi1" || pri === "spec1" || pri === "gai1" || pri === "news1") {
      s = 24;
    } else if (pri === "spec2" || pri === "news2" || pri === "ichi2" || pri === "gai2") {
      s = 32;
    }
    if (s < best) best = s;
  }
  return best;
}

// Strip parenthetical clarifiers so "dog (Canis lupus familiaris)" matches a
// search for "dog". Used for the matching-only columns; the full gloss kept
// for display retains the parens.
function normalizeForMatch(s: string): string {
  let prev = "";
  let cur = s.toLowerCase();
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/\([^()]*\)/g, "");
  }
  return cur.replace(/\s+/g, " ").trim();
}

function extractGlossText(g: any): string | null {
  if (g == null) return null;
  if (typeof g === "string") return g;
  if (typeof g === "number") return String(g);
  if (typeof g === "object") {
    const lang = g["@_xml:lang"];
    if (lang && lang !== "eng") return null;
    const t = g["#text"];
    if (typeof t === "string") return t;
    if (typeof t === "number") return String(t);
  }
  return null;
}

const db = new Database(DB_PATH);
db.exec("DROP TABLE IF EXISTS entries");
db.exec(`
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    kanji TEXT,
    reading TEXT,
    pos TEXT,
    gloss TEXT,
    first_gloss TEXT,
    top_glosses TEXT,
    priority INTEGER NOT NULL DEFAULT 9999
  )
`);
db.exec("CREATE INDEX idx_kanji ON entries(kanji)");
db.exec("CREATE INDEX idx_reading ON entries(reading)");
db.exec("CREATE INDEX idx_priority ON entries(priority)");

const insert = db.prepare(`
  INSERT INTO entries (kanji, reading, pos, gloss, first_gloss, top_glosses, priority)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

db.exec("BEGIN");
let count = 0;
for (const entry of entries) {
  const kanjiElems: any[] = entry.k_ele ?? [];
  const readingElems: any[] = entry.r_ele ?? [];
  const senses: any[] = entry.sense ?? [];

  const allPris: string[] = [];
  for (const k of kanjiElems) for (const p of k.ke_pri ?? []) allPris.push(p);
  for (const r of readingElems) for (const p of r.re_pri ?? []) allPris.push(p);
  const priority = priorityScore(allPris);

  const kanji = kanjiElems[0]?.keb ?? "";
  const reading = readingElems[0]?.reb ?? "";
  const pos = (senses[0]?.pos ?? []).join("; ");

  const allGlosses: string[] = [];
  for (const sense of senses) {
    for (const g of sense.gloss ?? []) {
      const t = extractGlossText(g);
      if (t) allGlosses.push(t);
    }
  }
  const gloss = allGlosses.join("; ");
  const firstGloss = normalizeForMatch(allGlosses[0] ?? "");

  // Top 3 glosses of sense 1 — used as a "primary meaning" boost in ranking,
  // so words with the search term as a tertiary or later-sense gloss don't
  // outrank ones where it's a primary meaning.
  const sense1: string[] = [];
  if (senses[0]) {
    for (const g of senses[0].gloss ?? []) {
      const t = extractGlossText(g);
      if (t) sense1.push(t);
    }
  }
  const topGlosses = sense1
    .slice(0, 3)
    .map(normalizeForMatch)
    .filter(Boolean)
    .join("; ");

  insert.run(kanji, reading, pos, gloss, firstGloss, topGlosses, priority);
  count++;
  if (count % 50000 === 0) console.log(`  inserted ${count}`);
}
db.exec("COMMIT");
db.exec("VACUUM");

console.log(`Inserted ${count} entries into ${DB_PATH}.`);
db.close();
