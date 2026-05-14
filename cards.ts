import { Database } from "bun:sqlite";

const db = new Database(Bun.env.CARDS_DB_PATH ?? "cards.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kanji TEXT NOT NULL,
    reading TEXT NOT NULL DEFAULT '',
    gloss TEXT NOT NULL DEFAULT '',
    pos TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    example_jp TEXT NOT NULL DEFAULT '',
    example_en TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'new',
    due_at INTEGER NOT NULL,
    interval_days REAL NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at INTEGER
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_at INTEGER NOT NULL,
    rating TEXT NOT NULL,
    prev_state TEXT NOT NULL,
    new_state TEXT NOT NULL,
    prev_interval REAL NOT NULL,
    new_interval REAL NOT NULL,
    prev_ease REAL NOT NULL,
    new_ease REAL NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_card_id ON reviews(card_id)`);

export type Rating = "again" | "hard" | "good" | "easy";
export type CardState = "new" | "learning" | "review" | "relearning";

export interface Card {
  id: number;
  kanji: string;
  reading: string;
  gloss: string;
  pos: string;
  notes: string;
  example_jp: string;
  example_en: string;
  source: string;
  created_at: number;
  state: CardState;
  due_at: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_reviewed_at: number | null;
}

export interface NewCardInput {
  kanji: string;
  reading?: string;
  gloss?: string;
  pos?: string;
  notes?: string;
  example_jp?: string;
  example_en?: string;
  source?: string;
}

export interface UpdateCardInput {
  kanji?: string;
  reading?: string;
  gloss?: string;
  pos?: string;
  notes?: string;
  example_jp?: string;
  example_en?: string;
  source?: string;
}

// Anki-style learning steps (minutes) for new / lapsed cards.
const LEARNING_STEPS_MIN = [1, 10] as const;
const GRADUATING_INTERVAL_DAYS = 1;
const EASY_INTERVAL_DAYS = 4;
const MIN_EASE = 1.3;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export interface SchedulingResult {
  state: CardState;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  due_at: number;
}

// Pure scheduler — exposed for testing.
export function schedule(
  prev: {
    state: CardState;
    interval_days: number;
    ease: number;
    reps: number;
    lapses: number;
  },
  rating: Rating,
  now: number,
): SchedulingResult {
  let { state, interval_days, ease, reps, lapses } = prev;
  let due_at: number;

  if (rating === "again") {
    if (state === "review") lapses += 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
    reps = 0;
    state = state === "review" ? "relearning" : "learning";
    interval_days = LEARNING_STEPS_MIN[0] / (24 * 60);
    due_at = now + LEARNING_STEPS_MIN[0] * MIN_MS;
    return { state, interval_days, ease, reps, lapses, due_at };
  }

  if (state === "new" || state === "learning" || state === "relearning") {
    if (rating === "easy") {
      state = "review";
      interval_days = EASY_INTERVAL_DAYS;
      reps += 1;
      ease = Math.max(MIN_EASE, ease + 0.15);
      due_at = now + EASY_INTERVAL_DAYS * DAY_MS;
      return { state, interval_days, ease, reps, lapses, due_at };
    }
    if (rating === "good") {
      // Step through learning steps. reps counts completed learning steps.
      const nextStep = reps + 1;
      if (nextStep >= LEARNING_STEPS_MIN.length) {
        state = "review";
        interval_days = GRADUATING_INTERVAL_DAYS;
        reps = nextStep;
        due_at = now + GRADUATING_INTERVAL_DAYS * DAY_MS;
      } else {
        state = state === "new" ? "learning" : state;
        const stepMin = LEARNING_STEPS_MIN[nextStep];
        interval_days = stepMin / (24 * 60);
        reps = nextStep;
        due_at = now + stepMin * MIN_MS;
      }
      return { state, interval_days, ease, reps, lapses, due_at };
    }
    // hard during learning — repeat current step
    const stepMin = LEARNING_STEPS_MIN[Math.min(reps, LEARNING_STEPS_MIN.length - 1)];
    interval_days = stepMin / (24 * 60);
    state = state === "new" ? "learning" : state;
    due_at = now + stepMin * MIN_MS;
    return { state, interval_days, ease, reps, lapses, due_at };
  }

  // state === 'review'
  const base = interval_days > 0 ? interval_days : 1;
  let nextInterval: number;
  if (rating === "hard") {
    ease = Math.max(MIN_EASE, ease - 0.15);
    nextInterval = base * 1.2;
  } else if (rating === "good") {
    nextInterval = base * ease;
  } else {
    // easy
    ease = Math.max(MIN_EASE, ease + 0.15);
    nextInterval = base * ease * 1.3;
  }
  nextInterval = Math.max(1, Math.round(nextInterval * 100) / 100);
  reps += 1;
  due_at = now + nextInterval * DAY_MS;
  return { state: "review", interval_days: nextInterval, ease, reps, lapses, due_at };
}

const insertCardStmt = db.prepare<
  { id: number },
  [string, string, string, string, string, string, string, string, number, number]
>(`
  INSERT INTO cards
    (kanji, reading, gloss, pos, notes, example_jp, example_en, source, created_at, due_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING id
`);

const getCardStmt = db.query<Card, [number]>(`SELECT * FROM cards WHERE id = ?`);
const listCardsStmt = db.query<Card, []>(`SELECT * FROM cards ORDER BY created_at DESC`);
const listDueStmt = db.query<Card, [number, number]>(`
  SELECT * FROM cards
  WHERE due_at <= ?
  ORDER BY
    CASE state WHEN 'learning' THEN 0 WHEN 'relearning' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
    due_at ASC
  LIMIT ?
`);
const deleteCardStmt = db.prepare<unknown, [number]>(`DELETE FROM cards WHERE id = ?`);

const updateSchedStmt = db.prepare<
  unknown,
  [string, number, number, number, number, number, number, number]
>(`
  UPDATE cards
  SET state = ?, due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ?, last_reviewed_at = ?
  WHERE id = ?
`);

const insertReviewStmt = db.prepare<
  unknown,
  [number, number, string, string, string, number, number, number, number]
>(`
  INSERT INTO reviews
    (card_id, reviewed_at, rating, prev_state, new_state, prev_interval, new_interval, prev_ease, new_ease)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const reviewHistoryStmt = db.query<
  {
    id: number;
    card_id: number;
    reviewed_at: number;
    rating: string;
    prev_state: string;
    new_state: string;
    prev_interval: number;
    new_interval: number;
    prev_ease: number;
    new_ease: number;
  },
  [number]
>(`SELECT * FROM reviews WHERE card_id = ? ORDER BY reviewed_at ASC`);

export function createCard(input: NewCardInput, now: number = Date.now()): Card {
  if (!input.kanji?.trim()) throw new Error("kanji is required");
  const row = insertCardStmt.get(
    input.kanji,
    input.reading ?? "",
    input.gloss ?? "",
    input.pos ?? "",
    input.notes ?? "",
    input.example_jp ?? "",
    input.example_en ?? "",
    input.source ?? "",
    now,
    now,
  );
  return getCardStmt.get(row!.id)!;
}

export function getCard(id: number): Card | null {
  return getCardStmt.get(id) ?? null;
}

export function listCards(): Card[] {
  return listCardsStmt.all();
}

export function listDue(limit: number = 50, now: number = Date.now()): Card[] {
  return listDueStmt.all(now, Math.max(1, Math.min(500, limit)));
}

export function updateCard(id: number, patch: UpdateCardInput): Card | null {
  const existing = getCardStmt.get(id);
  if (!existing) return null;
  const merged: Card = {
    ...existing,
    kanji: patch.kanji ?? existing.kanji,
    reading: patch.reading ?? existing.reading,
    gloss: patch.gloss ?? existing.gloss,
    pos: patch.pos ?? existing.pos,
    notes: patch.notes ?? existing.notes,
    example_jp: patch.example_jp ?? existing.example_jp,
    example_en: patch.example_en ?? existing.example_en,
    source: patch.source ?? existing.source,
  };
  db.run(
    `UPDATE cards SET kanji=?, reading=?, gloss=?, pos=?, notes=?, example_jp=?, example_en=?, source=? WHERE id=?`,
    [
      merged.kanji,
      merged.reading,
      merged.gloss,
      merged.pos,
      merged.notes,
      merged.example_jp,
      merged.example_en,
      merged.source,
      id,
    ],
  );
  return getCardStmt.get(id)!;
}

export function deleteCard(id: number): boolean {
  const result = deleteCardStmt.run(id);
  return result.changes > 0;
}

const VALID_RATINGS: Rating[] = ["again", "hard", "good", "easy"];

export function reviewCard(
  id: number,
  rating: Rating,
  now: number = Date.now(),
): Card | null {
  if (!VALID_RATINGS.includes(rating)) {
    throw new Error(`invalid rating: ${rating}`);
  }
  const card = getCardStmt.get(id);
  if (!card) return null;
  const next = schedule(
    {
      state: card.state,
      interval_days: card.interval_days,
      ease: card.ease,
      reps: card.reps,
      lapses: card.lapses,
    },
    rating,
    now,
  );
  const tx = db.transaction(() => {
    updateSchedStmt.run(
      next.state,
      next.due_at,
      next.interval_days,
      next.ease,
      next.reps,
      next.lapses,
      now,
      id,
    );
    insertReviewStmt.run(
      id,
      now,
      rating,
      card.state,
      next.state,
      card.interval_days,
      next.interval_days,
      card.ease,
      next.ease,
    );
  });
  tx();
  return getCardStmt.get(id)!;
}

export function reviewHistory(cardId: number) {
  return reviewHistoryStmt.all(cardId);
}

export interface CardStats {
  total: number;
  new: number;
  learning: number;
  review: number;
  due_now: number;
  reviewed_today: number;
}

const countByStateStmt = db.query<{ state: string; n: number }, []>(
  `SELECT state, COUNT(*) AS n FROM cards GROUP BY state`,
);
const countDueStmt = db.query<{ n: number }, [number]>(
  `SELECT COUNT(*) AS n FROM cards WHERE due_at <= ?`,
);
const countReviewedSinceStmt = db.query<{ n: number }, [number]>(
  `SELECT COUNT(*) AS n FROM reviews WHERE reviewed_at >= ?`,
);

export function getStats(now: number = Date.now()): CardStats {
  const totals = { new: 0, learning: 0, relearning: 0, review: 0 } as Record<string, number>;
  for (const row of countByStateStmt.all()) totals[row.state] = row.n;
  const due_now = countDueStmt.get(now)?.n ?? 0;
  // Local "today" boundary — use UTC midnight of `now` for determinism.
  const startOfDay = now - (now % DAY_MS);
  const reviewed_today = countReviewedSinceStmt.get(startOfDay)?.n ?? 0;
  return {
    total: (totals.new ?? 0) + (totals.learning ?? 0) + (totals.relearning ?? 0) + (totals.review ?? 0),
    new: totals.new ?? 0,
    learning: (totals.learning ?? 0) + (totals.relearning ?? 0),
    review: totals.review ?? 0,
    due_now,
    reviewed_today,
  };
}
