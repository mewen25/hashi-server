import { Database } from "bun:sqlite";

const db = new Database("mozc_dict.db", { readonly: true });
const jmdict = new Database("jmdict.db", { readonly: true });

const byReading = db.query<{ surface: string; cost: number }, [string]>(
  "SELECT surface, cost FROM dictionary WHERE reading = ? ORDER BY cost ASC LIMIT 30"
);
const byKanjiReading = jmdict.query<{ gloss: string; pos: string }, [string, string]>(
  "SELECT gloss, pos FROM entries WHERE kanji = ? AND reading = ? LIMIT 1"
);
const byKanji = jmdict.query<{ gloss: string; pos: string }, [string]>(
  "SELECT gloss, pos FROM entries WHERE kanji = ? LIMIT 1"
);

function toHiragana(str: string): string {
  return str.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function lookupGloss(surface: string, reading: string) {
  return byKanjiReading.get(surface, reading) ?? byKanji.get(surface);
}

export interface Candidate {
  surface: string;
  cost: number;
  gloss: string | null;
  pos: string | null;
}

interface Edge {
  start: number;
  end: number;
  reading: string;
  cost: number;
  candidates: Candidate[];
}

const KBEST_PATHS = 10;
const KBEST_CANDIDATES = 8;
const FALLBACK_COST = 9999;
// Penalty added per edge during path search to prefer fewer, longer segments.
// Without this, splitting into single kana (all cost 0) always wins over
// meaningful kanji conversions like 楽しい (cost 1426).
const SEGMENT_PENALTY = 2200;

function buildEdges(input: string): Edge[] {
  const N = input.length;
  const edges: Edge[] = [];

  for (let i = 0; i < N; i++) {
    for (let L = 1; L <= N - i; L++) {
      const reading = input.slice(i, i + L);
      const rows = byReading.all(reading);
      if (rows.length === 0 && L > 1) continue;

      const bestBySurface = new Map<string, { surface: string; cost: number }>();
      for (const r of rows) {
        const prev = bestBySurface.get(r.surface);
        if (!prev || r.cost < prev.cost) bestBySurface.set(r.surface, r);
      }
      // Single-char fallback: always allow "type the kana as-is" so the lattice is connected.
      if (L === 1 && !bestBySurface.has(reading)) {
        bestBySurface.set(reading, { surface: reading, cost: FALLBACK_COST });
      }

      const candidates: Candidate[] = [...bestBySurface.values()]
        .sort((a, b) => a.cost - b.cost)
        .slice(0, KBEST_CANDIDATES)
        .map((c) => {
          const info = lookupGloss(c.surface, reading);
          return {
            surface: c.surface,
            cost: c.cost,
            gloss: info?.gloss ?? null,
            pos: info?.pos ?? null,
          };
        });

      if (candidates.length === 0) continue;

      edges.push({
        start: i,
        end: i + L,
        reading,
        cost: candidates[0].cost,
        candidates,
      });
    }
  }

  return edges;
}

export interface PathSegment {
  reading: string;
  surface: string;
  cost: number;
  candidates: Candidate[];
}

export interface Segmentation {
  totalCost: number;
  display: string;
  segments: PathSegment[];
}

export interface ConvertResult {
  input: string;
  segmentations: Segmentation[];
}

export function convert(rawInput: string): ConvertResult {
  const input = toHiragana(rawInput);
  const N = input.length;
  if (N === 0) return { input, segmentations: [] };

  const edges = buildEdges(input);
  const edgesByEnd: Edge[][] = Array.from({ length: N + 1 }, () => []);
  for (const e of edges) edgesByEnd[e.end].push(e);

  // K-best DP: best[j] = top-K paths ending at position j, sorted by score asc.
  // "score" = sum of edge costs + SEGMENT_PENALTY per edge, used only for ranking.
  // "rawCost" = sum of edge costs without penalty, reported in output.
  const best: { score: number; rawCost: number; path: Edge[] }[][] = Array.from(
    { length: N + 1 },
    () => []
  );
  best[0] = [{ score: 0, rawCost: 0, path: [] }];

  for (let j = 1; j <= N; j++) {
    const pool: { score: number; rawCost: number; path: Edge[] }[] = [];
    for (const edge of edgesByEnd[j]) {
      for (const prev of best[edge.start]) {
        pool.push({
          score: prev.score + edge.cost + SEGMENT_PENALTY,
          rawCost: prev.rawCost + edge.cost,
          path: [...prev.path, edge],
        });
      }
    }
    pool.sort((a, b) => a.score - b.score);
    best[j] = pool.slice(0, KBEST_PATHS);
  }

  const seen = new Set<string>();
  const segmentations: Segmentation[] = [];
  for (const { rawCost, path } of best[N]) {
    const display = path.map((e) => e.candidates[0].surface).join("");
    if (seen.has(display)) continue;
    seen.add(display);
    segmentations.push({
      totalCost: rawCost,
      display,
      segments: path.map((e) => ({
        reading: e.reading,
        surface: e.candidates[0].surface,
        cost: e.cost,
        candidates: e.candidates,
      })),
    });
  }

  return { input, segmentations };
}

if (import.meta.main) {
  const result = convert("たのして");
  console.log(JSON.stringify(result, null, 2));
}
