import { test, expect } from "bun:test";

// Use an isolated DB file for tests.
process.env.CARDS_DB_PATH = `/tmp/passages-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

import {
  createPassage,
  listPassages,
  getPassage,
  deletePassage,
  setPassageSeen,
} from "./passages";

test("createPassage stores text and returns the row", () => {
  const p = createPassage({ content: "これはテストです。", title: "test", lang: "ja" });
  expect(p.id).toBeGreaterThan(0);
  expect(p.kind).toBe("text");
  expect(p.title).toBe("test");
  expect(p.lang).toBe("ja");
  expect(p.char_count).toBe("これはテストです。".length);
  expect(p.created_at).toBeGreaterThan(0);
});

test("createPassage rejects empty content", () => {
  expect(() => createPassage({ content: "   " })).toThrow();
});

test("listPassages returns previews newest-first, without full content", () => {
  const long = "あ".repeat(500);
  const recent = createPassage({ content: long, title: "long" });
  const list = listPassages();
  expect(list.length).toBeGreaterThanOrEqual(2);
  expect(list[0]!.id).toBe(recent.id); // newest first
  expect((list[0] as unknown as { content?: string }).content).toBeUndefined();
  expect(list[0]!.preview.endsWith("…")).toBe(true);
  expect(list[0]!.preview.length).toBeLessThan(long.length);
});

test("getPassage returns full content, missing id returns null", () => {
  const p = createPassage({ content: "full body text", kind: "article", source_url: "https://x.test/a" });
  const got = getPassage(p.id);
  expect(got?.content).toBe("full body text");
  expect(got?.kind).toBe("article");
  expect(got?.source_url).toBe("https://x.test/a");
  expect(getPassage(999999)).toBeNull();
});

test("deletePassage removes the row", () => {
  const p = createPassage({ content: "delete me" });
  expect(deletePassage(p.id)).toBe(true);
  expect(getPassage(p.id)).toBeNull();
  expect(deletePassage(p.id)).toBe(false);
});

test("new passages start unseen; setPassageSeen toggles the flag", () => {
  const p = createPassage({ content: "mark me read" });
  expect(p.seen).toBe(0);
  expect(setPassageSeen(p.id, true)?.seen).toBe(1);
  expect(getPassage(p.id)?.seen).toBe(1);
  expect(setPassageSeen(p.id, false)?.seen).toBe(0);
  expect(setPassageSeen(999999, true)).toBeNull();
});
