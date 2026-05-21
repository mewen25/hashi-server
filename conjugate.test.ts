import { test, expect } from "bun:test";
import { conjugate } from "./conjugate";

test("ichidan: 食べる", () => {
  const r = conjugate("食べる");
  expect(r.class).toBe("ichidan");
  expect(r.masu).toBe("食べます");
  expect(r.masuNeg).toBe("食べません");
  expect(r.te).toBe("食べて");
  expect(r.ta).toBe("食べた");
  expect(r.nai).toBe("食べない");
  expect(r.tai).toBe("食べたい");
  expect(r.conditional).toBe("食べれば");
  expect(r.potential).toBe("食べられる");
  expect(r.volitional).toBe("食べよう");
  expect(r.imperative).toBe("食べろ");
  expect(r.passive).toBe("食べられる");
  expect(r.causative).toBe("食べさせる");
});

test("ichidan: 見る", () => {
  const r = conjugate("見る");
  expect(r.class).toBe("ichidan");
  expect(r.masu).toBe("見ます");
  expect(r.te).toBe("見て");
  expect(r.ta).toBe("見た");
});

test("godan -u: 買う", () => {
  const r = conjugate("買う");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("買います");
  expect(r.te).toBe("買って");
  expect(r.ta).toBe("買った");
  expect(r.nai).toBe("買わない"); // not 買あない
  expect(r.conditional).toBe("買えば");
  expect(r.volitional).toBe("買おう");
});

test("godan -ku: 書く", () => {
  const r = conjugate("書く");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("書きます");
  expect(r.te).toBe("書いて");
  expect(r.ta).toBe("書いた");
  expect(r.nai).toBe("書かない");
  expect(r.conditional).toBe("書けば");
});

test("godan -gu: 泳ぐ", () => {
  const r = conjugate("泳ぐ");
  expect(r.class).toBe("godan");
  expect(r.te).toBe("泳いで");
  expect(r.ta).toBe("泳いだ");
});

test("godan -su: 話す", () => {
  const r = conjugate("話す");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("話します");
  expect(r.te).toBe("話して");
  expect(r.ta).toBe("話した");
});

test("godan -tsu: 待つ", () => {
  const r = conjugate("待つ");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("待ちます");
  expect(r.te).toBe("待って");
  expect(r.ta).toBe("待った");
});

test("godan -nu: 死ぬ", () => {
  const r = conjugate("死ぬ");
  expect(r.class).toBe("godan");
  expect(r.te).toBe("死んで");
  expect(r.ta).toBe("死んだ");
});

test("godan -bu: 遊ぶ", () => {
  const r = conjugate("遊ぶ");
  expect(r.class).toBe("godan");
  expect(r.te).toBe("遊んで");
  expect(r.ta).toBe("遊んだ");
});

test("godan -mu: 読む", () => {
  const r = conjugate("読む");
  expect(r.class).toBe("godan");
  expect(r.te).toBe("読んで");
  expect(r.ta).toBe("読んだ");
});

test("godan -ru: 売る", () => {
  const r = conjugate("売る");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("売ります");
  expect(r.te).toBe("売って");
  expect(r.ta).toBe("売った");
});

test("godan -ru exception: 帰る", () => {
  const r = conjugate("帰る");
  expect(r.class).toBe("godan");
  expect(r.masu).toBe("帰ります");
  expect(r.te).toBe("帰って");
  expect(r.ta).toBe("帰った");
  expect(r.nai).toBe("帰らない"); // not 帰ない
});

test("godan -ru exception: 知る", () => {
  const r = conjugate("知る");
  expect(r.class).toBe("godan");
  expect(r.te).toBe("知って");
});

test("irregular: する", () => {
  const r = conjugate("する");
  expect(r.class).toBe("irregular");
  expect(r.masu).toBe("します");
  expect(r.te).toBe("して");
  expect(r.ta).toBe("した");
  expect(r.nai).toBe("しない");
  expect(r.potential).toBe("できる");
  expect(r.volitional).toBe("しよう");
  expect(r.imperative).toBe("しろ");
});

test("irregular suru-compound: 勉強する", () => {
  const r = conjugate("勉強する");
  expect(r.class).toBe("irregular");
  expect(r.masu).toBe("勉強します");
  expect(r.te).toBe("勉強して");
  expect(r.ta).toBe("勉強した");
  expect(r.potential).toBe("勉強できる");
});

test("irregular: 来る (kanji)", () => {
  const r = conjugate("来る");
  expect(r.class).toBe("irregular");
  expect(r.masu).toBe("来ます");
  expect(r.te).toBe("来て");
  expect(r.ta).toBe("来た");
  expect(r.nai).toBe("来ない");
  expect(r.imperative).toBe("来い"); // not 来ろ
});

test("irregular: くる (kana)", () => {
  const r = conjugate("くる");
  expect(r.class).toBe("irregular");
  expect(r.masu).toBe("きます");
  expect(r.te).toBe("きて");
  expect(r.nai).toBe("こない");
  expect(r.imperative).toBe("こい");
});

test("irregular: 行く (te-form exception)", () => {
  const r = conjugate("行く");
  expect(r.class).toBe("irregular");
  expect(r.masu).toBe("行きます");
  expect(r.te).toBe("行って"); // not 行いて
  expect(r.ta).toBe("行った"); // not 行いた
  expect(r.nai).toBe("行かない");
});
