// Japanese verb conjugator.
// Input: dictionary form (e.g. 食べる, 行く, 勉強する). Output: a table of common forms.
//
// Verb class inference: irregulars (する / 来る / 行く / -する compounds) first, then
// godan-exception suffix list, then -iru/-eru endings as ichidan, otherwise godan.

export type VerbClass = "ichidan" | "godan" | "irregular";

export interface ConjugationTable {
  dictionary: string;
  masu: string;
  masuNeg: string;
  te: string;
  ta: string;
  nai: string;
  tai: string;
  conditional: string;
  potential: string;
  volitional: string;
  imperative: string;
  passive: string;
  causative: string;
  class: VerbClass;
}

// Verbs that end in -iる or -eる but conjugate as godan. Common ones; not
// exhaustive but covers what learners actually trip over.
const GODAN_RU_EXCEPTIONS = new Set([
  // -iる / -eる godan exceptions (would otherwise look ichidan)
  "知る", "しる",
  "切る", "きる",
  "走る", "はしる",
  "帰る", "かえる",
  "入る", "はいる",
  "要る", "いる",
  "減る", "へる",
  "蹴る", "ける",
  "滑る", "すべる",
  "焦る", "あせる",
  "練る", "ねる",
  "喋る", "しゃべる",
  "嘲る", "あざける",
  "限る", "かぎる",
  "散る", "ちる",
  "茂る", "しげる",
  "捻る", "ひねる",
  "罵る", "ののしる",
  "握る", "にぎる",
  "覆る", "くつがえる",
  "陥る", "おちいる",
  "弄る", "いじる",
  // Common kanji-stem godan -ru verbs — without these the kanji-default-to-ichidan
  // heuristic misclassifies them. Pass a reading to bypass this list.
  "売る", "うる",
  "取る", "とる",
  "撮る",
  "振る", "ふる",
  "乗る", "のる",
  "縛る", "しばる",
  "守る", "まもる",
  "配る", "くばる",
  "残る", "のこる",
  "黙る", "だまる",
  "殴る", "なぐる",
  "怒る", "おこる",
  "困る", "こまる",
  "送る", "おくる",
  "探る", "さぐる",
  "操る", "あやつる",
  "始まる", "はじまる",
  "終わる", "おわる",
  "集まる", "あつまる",
  "留まる", "とまる",
  "止まる", "とまる",
  "詰まる", "つまる",
  "決まる", "きまる",
  "回る", "まわる",
  "降る", "ふる",
  "釣る", "つる",
  "刈る", "かる",
  "盛る", "もる",
  "脈る", "うねる",
]);

// Godan ending → stem-mora variants. Keys are the trailing dictionary-form kana.
// rowA = nai-stem, rowI = masu-stem, rowU = dict, rowE = conditional/imperative,
// rowO = volitional stem.
const GODAN_ROWS: Record<string, { a: string; i: string; u: string; e: string; o: string }> = {
  "う": { a: "わ", i: "い", u: "う", e: "え", o: "お" },
  "く": { a: "か", i: "き", u: "く", e: "け", o: "こ" },
  "ぐ": { a: "が", i: "ぎ", u: "ぐ", e: "げ", o: "ご" },
  "す": { a: "さ", i: "し", u: "す", e: "せ", o: "そ" },
  "つ": { a: "た", i: "ち", u: "つ", e: "て", o: "と" },
  "ぬ": { a: "な", i: "に", u: "ぬ", e: "ね", o: "の" },
  "ぶ": { a: "ば", i: "び", u: "ぶ", e: "べ", o: "ぼ" },
  "む": { a: "ま", i: "み", u: "む", e: "め", o: "も" },
  "る": { a: "ら", i: "り", u: "る", e: "れ", o: "ろ" },
};

// Te-form / ta-form by godan ending.
const GODAN_TE_TA: Record<string, { te: string; ta: string }> = {
  "う": { te: "って", ta: "った" },
  "つ": { te: "って", ta: "った" },
  "る": { te: "って", ta: "った" },
  "む": { te: "んで", ta: "んだ" },
  "ぬ": { te: "んで", ta: "んだ" },
  "ぶ": { te: "んで", ta: "んだ" },
  "く": { te: "いて", ta: "いた" },
  "ぐ": { te: "いで", ta: "いだ" },
  "す": { te: "して", ta: "した" },
};

function lastChar(s: string): string {
  // Codepoint-safe last char.
  const chars = [...s];
  return chars[chars.length - 1] ?? "";
}

function trimLast(s: string): string {
  const chars = [...s];
  return chars.slice(0, -1).join("");
}

function classify(dict: string, reading?: string): VerbClass {
  if (dict === "する" || dict.endsWith("する")) return "irregular";
  if (dict === "来る" || dict === "くる") return "irregular";
  if (dict === "行く" || dict === "いく") return "irregular";
  if (GODAN_RU_EXCEPTIONS.has(dict)) return "godan";
  if (reading && GODAN_RU_EXCEPTIONS.has(reading)) return "godan";

  const last = lastChar(dict);
  if (last !== "る") return "godan";

  // Ends in る — ichidan if the kana before る is in the い/え row, else godan.
  // For kanji-prefix verbs, the penult is a kanji we can't classify; use the
  // reading's penult if provided, else default to ichidan (statistically the
  // safer default; godan kanji-る verbs need to be in GODAN_RU_EXCEPTIONS).
  if (reading) {
    const readPenult = lastChar(trimLast(reading));
    if (isIRow(readPenult) || isERow(readPenult)) return "ichidan";
    return "godan";
  }

  const penult = lastChar(trimLast(dict));
  if (isIRow(penult) || isERow(penult)) return "ichidan";
  if (isHiragana(penult)) return "godan";
  return "ichidan";
}

const I_ROW = "いきしちにひみりぎじぢびぴゐ";
const E_ROW = "えけせてねへめれげぜでべぺゑ";

function isIRow(kana: string): boolean {
  return I_ROW.includes(kana);
}
function isERow(kana: string): boolean {
  return E_ROW.includes(kana);
}
function isHiragana(ch: string): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x3041 && code <= 0x309f;
}

function conjugateIrregularSuru(dict: string): ConjugationTable {
  // Compounds: split off trailing する. Pure する → prefix is empty.
  const prefix = dict.endsWith("する") ? dict.slice(0, -2) : "";
  return {
    dictionary: prefix + "する",
    masu: prefix + "します",
    masuNeg: prefix + "しません",
    te: prefix + "して",
    ta: prefix + "した",
    nai: prefix + "しない",
    tai: prefix + "したい",
    conditional: prefix + "すれば",
    potential: prefix + "できる",
    volitional: prefix + "しよう",
    imperative: prefix + "しろ",
    passive: prefix + "される",
    causative: prefix + "させる",
    class: "irregular",
  };
}

function conjugateIrregularKuru(dict: string): ConjugationTable {
  // Handle both 来る and くる. The kanji 来 has a reading that shifts (く/き/こ),
  // but the written surface keeps the kanji unchanged — only the trailing kana
  // change. For pure kana くる we replace the leading く directly.
  const isKanji = dict === "来る";
  const stem = isKanji ? "来" : "";
  // For kana くる, build each form from its full kana.
  if (!isKanji) {
    return {
      dictionary: "くる",
      masu: "きます",
      masuNeg: "きません",
      te: "きて",
      ta: "きた",
      nai: "こない",
      tai: "きたい",
      conditional: "くれば",
      potential: "こられる",
      volitional: "こよう",
      imperative: "こい",
      passive: "こられる",
      causative: "こさせる",
      class: "irregular",
    };
  }
  return {
    dictionary: stem + "る",
    masu: stem + "ます",
    masuNeg: stem + "ません",
    te: stem + "て",
    ta: stem + "た",
    nai: stem + "ない",
    tai: stem + "たい",
    conditional: stem + "れば",
    potential: stem + "られる",
    volitional: stem + "よう",
    imperative: stem + "い",
    passive: stem + "られる",
    causative: stem + "させる",
    class: "irregular",
  };
}

function conjugateIrregularIku(dict: string): ConjugationTable {
  // 行く is godan in every form EXCEPT te → 行って and ta → 行った
  // (instead of 行いて / 行いた which the godan-く rule would give).
  const stem = trimLast(dict); // "行" or "い"
  return {
    dictionary: stem + "く",
    masu: stem + "きます",
    masuNeg: stem + "きません",
    te: stem + "って",
    ta: stem + "った",
    nai: stem + "かない",
    tai: stem + "きたい",
    conditional: stem + "けば",
    potential: stem + "ける",
    volitional: stem + "こう",
    imperative: stem + "け",
    passive: stem + "かれる",
    causative: stem + "かせる",
    class: "irregular",
  };
}

function conjugateIchidan(dict: string): ConjugationTable {
  const stem = trimLast(dict);
  return {
    dictionary: stem + "る",
    masu: stem + "ます",
    masuNeg: stem + "ません",
    te: stem + "て",
    ta: stem + "た",
    nai: stem + "ない",
    tai: stem + "たい",
    conditional: stem + "れば",
    potential: stem + "られる",
    volitional: stem + "よう",
    imperative: stem + "ろ",
    passive: stem + "られる",
    causative: stem + "させる",
    class: "ichidan",
  };
}

function conjugateGodan(dict: string): ConjugationTable {
  const last = lastChar(dict);
  const row = GODAN_ROWS[last];
  const teta = GODAN_TE_TA[last];
  if (!row || !teta) throw new Error(`unsupported godan ending: ${last}`);
  const stem = trimLast(dict);
  return {
    dictionary: stem + row.u,
    masu: stem + row.i + "ます",
    masuNeg: stem + row.i + "ません",
    te: stem + teta.te,
    ta: stem + teta.ta,
    nai: stem + row.a + "ない",
    tai: stem + row.i + "たい",
    conditional: stem + row.e + "ば",
    potential: stem + row.e + "る",
    volitional: stem + row.o + "う",
    imperative: stem + row.e,
    passive: stem + row.a + "れる",
    causative: stem + row.a + "せる",
    class: "godan",
  };
}

export function conjugate(dictForm: string, reading?: string): ConjugationTable {
  const dict = dictForm.trim();
  if (!dict) throw new Error("empty input");

  if (dict === "する" || dict.endsWith("する")) return conjugateIrregularSuru(dict);
  if (dict === "来る" || dict === "くる") return conjugateIrregularKuru(dict);
  if (dict === "行く" || dict === "いく") return conjugateIrregularIku(dict);

  const cls = classify(dict, reading?.trim() || undefined);
  if (cls === "ichidan") return conjugateIchidan(dict);
  return conjugateGodan(dict);
}
