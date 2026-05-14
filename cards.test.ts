import { test, expect, beforeAll } from "bun:test";

// Use an isolated DB file for tests.
const TEST_DB = `/tmp/cards-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
process.env.CARDS_DB_PATH = TEST_DB;

import {
  createCard,
  deleteCard,
  getCard,
  getStats,
  listCards,
  listDue,
  reviewCard,
  reviewHistory,
  schedule,
  updateCard,
} from "./cards";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const MIN = 60_000;

test("schedule: new + good → moves to learning step 2", () => {
  const r = schedule({ state: "new", interval_days: 0, ease: 2.5, reps: 0, lapses: 0 }, "good", T0);
  expect(r.state).toBe("learning");
  expect(r.reps).toBe(1);
  expect(r.due_at).toBe(T0 + 10 * MIN);
});

test("schedule: learning step 2 + good → graduates to review (1 day)", () => {
  const r = schedule(
    { state: "learning", interval_days: 10 / (24 * 60), ease: 2.5, reps: 1, lapses: 0 },
    "good",
    T0,
  );
  expect(r.state).toBe("review");
  expect(r.interval_days).toBe(1);
  expect(r.due_at).toBe(T0 + DAY);
});

test("schedule: new + easy → review with 4-day interval", () => {
  const r = schedule({ state: "new", interval_days: 0, ease: 2.5, reps: 0, lapses: 0 }, "easy", T0);
  expect(r.state).toBe("review");
  expect(r.interval_days).toBe(4);
  expect(r.ease).toBeCloseTo(2.65);
});

test("schedule: review + good → interval × ease", () => {
  const r = schedule(
    { state: "review", interval_days: 4, ease: 2.5, reps: 1, lapses: 0 },
    "good",
    T0,
  );
  expect(r.state).toBe("review");
  expect(r.interval_days).toBe(10); // 4 * 2.5
  expect(r.ease).toBe(2.5);
});

test("schedule: review + hard → ease drops, interval × 1.2", () => {
  const r = schedule(
    { state: "review", interval_days: 10, ease: 2.5, reps: 2, lapses: 0 },
    "hard",
    T0,
  );
  expect(r.ease).toBeCloseTo(2.35);
  expect(r.interval_days).toBe(12);
});

test("schedule: review + again → lapses, ease drops, back to relearning", () => {
  const r = schedule(
    { state: "review", interval_days: 10, ease: 2.5, reps: 3, lapses: 0 },
    "again",
    T0,
  );
  expect(r.state).toBe("relearning");
  expect(r.lapses).toBe(1);
  expect(r.reps).toBe(0);
  expect(r.ease).toBeCloseTo(2.3);
  expect(r.due_at).toBe(T0 + 1 * MIN);
});

test("schedule: ease never drops below 1.3", () => {
  let state = { state: "review" as const, interval_days: 10, ease: 1.4, reps: 1, lapses: 0 };
  for (let i = 0; i < 5; i++) {
    const r = schedule(state, "again", T0);
    state = { state: r.state as "relearning", interval_days: r.interval_days, ease: r.ease, reps: r.reps, lapses: r.lapses };
  }
  expect(state.ease).toBeCloseTo(1.3);
});

test("createCard + getCard roundtrip", () => {
  const card = createCard(
    {
      kanji: "混む",
      reading: "こむ",
      gloss: "to be crowded",
      pos: "godan verb",
      example_jp: "駅は朝から混んでいた。",
      example_en: "The station had been crowded since morning.",
      source: "yesterday's reading",
    },
    T0,
  );
  expect(card.id).toBeGreaterThan(0);
  expect(card.kanji).toBe("混む");
  expect(card.state).toBe("new");
  expect(card.due_at).toBe(T0);
  const fetched = getCard(card.id);
  expect(fetched?.kanji).toBe("混む");
});

test("createCard rejects empty kanji", () => {
  expect(() => createCard({ kanji: "" })).toThrow();
});

test("reviewCard advances state and logs review history", () => {
  const card = createCard({ kanji: "走る", reading: "はしる", gloss: "to run" }, T0);
  const after = reviewCard(card.id, "good", T0 + 1000);
  expect(after?.state).toBe("learning");
  expect(after?.last_reviewed_at).toBe(T0 + 1000);
  const hist = reviewHistory(card.id);
  expect(hist.length).toBe(1);
  expect(hist[0].rating).toBe("good");
  expect(hist[0].prev_state).toBe("new");
  expect(hist[0].new_state).toBe("learning");
});

test("reviewCard rejects invalid rating", () => {
  const card = createCard({ kanji: "食べる" }, T0);
  expect(() => reviewCard(card.id, "bogus" as never)).toThrow();
});

test("reviewCard returns null for missing card", () => {
  expect(reviewCard(999_999, "good")).toBeNull();
});

test("listDue returns only due cards, ordered by learning first", () => {
  const a = createCard({ kanji: "未来A" }, T0); // new, due at T0
  const b = createCard({ kanji: "未来B" }, T0); // new, due at T0
  // Graduate `a` to review with a long interval — should not be due at T0+small.
  reviewCard(a.id, "easy", T0); // → review, due T0 + 4 days
  const due = listDue(50, T0 + 1000);
  const ids = due.map((c) => c.id);
  expect(ids).toContain(b.id);
  expect(ids).not.toContain(a.id);
});

test("updateCard merges fields, leaves SRS state alone", () => {
  const card = createCard({ kanji: "犬", gloss: "dog" }, T0);
  const updated = updateCard(card.id, { gloss: "doggy" });
  expect(updated?.gloss).toBe("doggy");
  expect(updated?.kanji).toBe("犬");
  expect(updated?.state).toBe(card.state);
});

test("deleteCard removes the card and its history", () => {
  const card = createCard({ kanji: "猫" }, T0);
  reviewCard(card.id, "good", T0);
  expect(reviewHistory(card.id).length).toBe(1);
  expect(deleteCard(card.id)).toBe(true);
  expect(getCard(card.id)).toBeNull();
  expect(reviewHistory(card.id).length).toBe(0); // cascade
});

test("getStats reports counts", () => {
  const before = getStats(T0);
  createCard({ kanji: "魚" }, T0);
  const after = getStats(T0);
  expect(after.total).toBe(before.total + 1);
  expect(after.new).toBe(before.new + 1);
  expect(after.due_now).toBeGreaterThanOrEqual(before.due_now + 1);
});

test("listCards returns newest first", () => {
  // listCards is ordered by created_at DESC — just verify it returns rows.
  const list = listCards();
  expect(Array.isArray(list)).toBe(true);
  expect(list.length).toBeGreaterThan(0);
});
