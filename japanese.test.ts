import { test, expect } from "bun:test";
import { containsJapanese, isJapaneseLine, filterJapanese } from "./japanese";

test("containsJapanese detects kana and kanji", () => {
  expect(containsJapanese("これはテスト")).toBe(true);
  expect(containsJapanese("日本語")).toBe(true);
  expect(containsJapanese("hello world")).toBe(false);
  expect(containsJapanese("12345 !?")).toBe(false);
});

test("isJapaneseLine keeps Japanese and mixed lines", () => {
  expect(isJapaneseLine("今日はいい天気ですね。")).toBe(true);
  expect(isJapaneseLine("東京タワー is tall")).toBe(true); // mixed → kept
  expect(isJapaneseLine("彼は1番です")).toBe(true); // stray digit → kept
});

test("isJapaneseLine drops non-Japanese lines", () => {
  expect(isJapaneseLine("Subscribe to my channel!")).toBe(false);
  expect(isJapaneseLine("2024-01-01")).toBe(false);
  expect(isJapaneseLine("[Music]")).toBe(false);
});

test("isJapaneseLine treats blank lines as structural", () => {
  expect(isJapaneseLine("")).toBe(true);
  expect(isJapaneseLine("   ")).toBe(true);
});

test("filterJapanese strips non-Japanese lines and collapses gaps", () => {
  const input = [
    "Welcome to my channel",
    "",
    "今日は日本語を勉強します。",
    "Please like and subscribe",
    "難しいですが、頑張りましょう。",
    "",
    "[Applause]",
  ].join("\n");

  expect(filterJapanese(input)).toBe(
    "今日は日本語を勉強します。\n難しいですが、頑張りましょう。",
  );
});

test("filterJapanese returns empty when there is no Japanese", () => {
  expect(filterJapanese("Hello\nWorld\n2024")).toBe("");
});

test("filterJapanese keeps a Japanese paragraph with embedded English", () => {
  const input = "AIとは Artificial Intelligence の略です。\nThis line is English only.";
  expect(filterJapanese(input)).toBe("AIとは Artificial Intelligence の略です。");
});
