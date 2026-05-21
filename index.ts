import { convert } from "./ime";
import { logRequest } from "./requests";
import {
  suggestEn,
  getWord,
  lookupOutputEntry,
  listVocabulary,
  getVocabulary,
  type VocabEntry,
} from "./dict";
import { segment } from "./segmenter";
import { translate } from "./translate";
import { analyzeJapaneseSentence } from "./claude";
import {
  createCard,
  deleteCard,
  findCardBySource,
  getCard,
  getStats,
  listCards,
  listDue,
  reviewCard,
  reviewHistory,
  updateCard,
  type Card,
  type Rating,
} from "./cards";
// import { analyzePronunciation, type PronunciationAnalysis } from "./pronunciation2";
import { analyzePronunciation, type PronunciationAnalysis } from "./pronunciation";

const PRONUNCIATION_LOG_PATH = Bun.env.PRONUNCIATION_LOG ?? "pronunciation.log.jsonl";
const pronunciationLog = Bun.file(PRONUNCIATION_LOG_PATH).writer();

async function logPronunciation(
  source: "GET" | "POST-json" | "POST-multipart",
  input: { sentence: string; take: number; audio?: { bytes: number; contentType?: string } },
  result: PronunciationAnalysis,
): Promise<void> {
  const entry = { ts: new Date().toISOString(), source, input, result };
  console.log("[pronounce]", JSON.stringify(entry));
  pronunciationLog.write(JSON.stringify(entry) + "\n");
  await pronunciationLog.flush();
}
import { loadNativeAudioBytes } from "./nativeAudio";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...init.headers,
    },
  });
}

type StudyItem =
  | { kind: "card"; card: Card; vocab?: VocabEntry }
  | { kind: "new"; vocab: VocabEntry }
  | null;

function vocabIdFromSource(source: string): string | null {
  return source.startsWith("vocab:") ? source.slice("vocab:".length) : null;
}

function attachVocab(card: Card): { card: Card; vocab?: VocabEntry } {
  const vid = vocabIdFromSource(card.source);
  const vocab = vid ? getVocabulary(vid) ?? undefined : undefined;
  return { card, vocab };
}

function nextStudyItem(): { item: StudyItem; queue: ReturnType<typeof studyQueue> } {
  const queue = studyQueue();
  const due = listDue(1);
  if (due.length) {
    const { card, vocab } = attachVocab(due[0]!);
    return { item: { kind: "card", card, vocab }, queue };
  }
  for (const v of listVocabulary()) {
    if (!findCardBySource(`vocab:${v.id}`)) {
      return { item: { kind: "new", vocab: v }, queue };
    }
  }
  return { item: null, queue };
}

function studyQueue() {
  const stats = getStats();
  const vocab = listVocabulary();
  let added = 0;
  for (const v of vocab) if (findCardBySource(`vocab:${v.id}`)) added += 1;
  return {
    due: stats.due_now,
    learning: stats.learning,
    review: stats.review,
    new_in_db: stats.new,
    reviewed_today: stats.reviewed_today,
    vocab_total: vocab.length,
    vocab_added: added,
    vocab_remaining: vocab.length - added,
  };
}

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  routes: {
    "/api/vocabulary": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: (req) => {
        const url = new URL(req.url);
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "100")));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
        const filter = url.searchParams.get("filter"); // "added" | "remaining" | null
        const items = listVocabulary().map((v) => {
          const card = findCardBySource(`vocab:${v.id}`);
          return { ...v, card_id: card?.id ?? null, state: card?.state ?? null };
        });
        const filtered =
          filter === "added"
            ? items.filter((v) => v.card_id !== null)
            : filter === "remaining"
              ? items.filter((v) => v.card_id === null)
              : items;
        return json({
          total: filtered.length,
          items: filtered.slice(offset, offset + limit),
        });
      },
    },
    "/api/vocabulary/:id": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: (req) => {
        const v = getVocabulary(req.params.id);
        if (!v) return json({ error: "not found" }, { status: 404 });
        const card = findCardBySource(`vocab:${v.id}`);
        return json({ ...v, card_id: card?.id ?? null, state: card?.state ?? null });
      },
    },
    "/api/study/next": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: () => json(nextStudyItem()),
    },
    "/api/study/review": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async (req) => {
        const body = (await req.json()) as {
          card_id?: number;
          vocab_id?: string;
          rating?: string;
        };
        const rating = body.rating as Rating | undefined;
        if (!rating) return json({ error: "missing rating" }, { status: 400 });
        try {
          let cardId = body.card_id ?? null;
          if (!cardId && body.vocab_id) {
            const v = getVocabulary(body.vocab_id);
            if (!v) return json({ error: "unknown vocab_id" }, { status: 404 });
            const existing = findCardBySource(`vocab:${v.id}`);
            cardId = existing
              ? existing.id
              : createCard({
                  kanji: v.kanji,
                  reading: v.reading,
                  gloss: v.en,
                  pos: "",
                  notes: v.romaji ? `romaji: ${v.romaji}` : "",
                  source: `vocab:${v.id}`,
                }).id;
          }
          if (!cardId) return json({ error: "missing card_id or vocab_id" }, { status: 400 });
          const reviewed = reviewCard(cardId, rating);
          if (!reviewed) return json({ error: "card not found" }, { status: 404 });
          return json({ reviewed: attachVocab(reviewed), ...nextStudyItem() });
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 400 });
        }
      },
    },
    "/api/convert": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        return json(await convert(q));
      },
      POST: async (req) => {
        const { q } = (await req.json()) as { q?: string };
        if (!q) return json({ error: "missing q in body" }, { status: 400 });
        return json(await convert(q));
      },
    },
    "/api/save": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async (req) => {
        const { q } = (await req.json()) as { q?: string };
        if (!q) return json({ error: "missing q in body" }, { status: 400 });
        logRequest(q);
        return json({ ok: true });
      },
    },
    "/api/suggest": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        return json(await suggestEn(q));
      },
      POST: async (req) => {
        const { q } = (await req.json()) as { q?: string };
        if (!q) return json({ error: "missing q in body" }, { status: 400 });
        return json(await suggestEn(q));
      },
    },
    "/api/word": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        return json(await getWord(q));
      },
    },
    "/api/segment": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        const morphemes = await segment(q);
        const enriched = await Promise.all(morphemes.map(async (m) => ({
          ...m,
          canOpen: !!(await getWord(m.dictionary_form)),
        })));
        return json(enriched);
      },
      POST: async (req) => {
        const body = await req.text();
        if (!body.trim()) return json({ error: "missing body" }, { status: 400 });
        let morphemes;
        try {
          morphemes = await segment(body);
        } catch {
          return json({ error: "segmentation failed" }, { status: 500 });
        }
        const enriched = await Promise.all(morphemes.map(async (m) => ({
          ...m,
          canOpen: !!(await getWord(m.dictionary_form)),
        })));
        return json(enriched);
      },
    },
    "/api/analyse": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async (req) => {
        const { sentence, intent } = (await req.json()) as {
          sentence?: string;
          intent?: string;
        };
        if (!sentence) return json({ error: "missing sentence in body" }, { status: 400 });
        try {
          return json(await analyzeJapaneseSentence(sentence, { intent }));
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
    "/api/cards": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: () => json(listCards()),
      POST: async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        const kanji = typeof body.kanji === "string" ? body.kanji : "";
        if (!kanji.trim()) return json({ error: "missing kanji" }, { status: 400 });
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        try {
          return json(
            createCard({
              kanji,
              reading: str("reading"),
              gloss: str("gloss"),
              pos: str("pos"),
              notes: str("notes"),
              example_jp: str("example_jp"),
              example_en: str("example_en"),
              source: str("source"),
            }),
            { status: 201 },
          );
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 400 });
        }
      },
    },
    "/api/cards/due": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: (req) => {
        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json(listDue(Number.isFinite(limit) ? limit : 50));
      },
    },
    "/api/cards/stats": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: () => json(getStats()),
    },
    "/api/cards/:id": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: (req) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return json({ error: "invalid id" }, { status: 400 });
        const card = getCard(id);
        if (!card) return json({ error: "not found" }, { status: 404 });
        return json(card);
      },
      PATCH: async (req) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return json({ error: "invalid id" }, { status: 400 });
        const body = (await req.json()) as Record<string, unknown>;
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        const updated = updateCard(id, {
          kanji: str("kanji"),
          reading: str("reading"),
          gloss: str("gloss"),
          pos: str("pos"),
          notes: str("notes"),
          example_jp: str("example_jp"),
          example_en: str("example_en"),
          source: str("source"),
        });
        if (!updated) return json({ error: "not found" }, { status: 404 });
        return json(updated);
      },
      DELETE: (req) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return json({ error: "invalid id" }, { status: 400 });
        const ok = deleteCard(id);
        if (!ok) return json({ error: "not found" }, { status: 404 });
        return json({ ok: true });
      },
    },
    "/api/cards/:id/review": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      POST: async (req) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return json({ error: "invalid id" }, { status: 400 });
        const { rating } = (await req.json()) as { rating?: string };
        if (!rating) return json({ error: "missing rating" }, { status: 400 });
        try {
          const card = reviewCard(id, rating as Rating);
          if (!card) return json({ error: "not found" }, { status: 404 });
          return json(card);
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 400 });
        }
      },
    },
    "/api/cards/:id/history": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: (req) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return json({ error: "invalid id" }, { status: 400 });
        return json(reviewHistory(id));
      },
    },
    "/api/pronounce/native": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const sentence = new URL(req.url).searchParams.get("q");
        if (!sentence) return json({ error: "missing ?q=" }, { status: 400 });
        try {
          const morphemes = await segment(sentence).catch(() => undefined);
          const audio = await loadNativeAudioBytes(sentence, morphemes);
          if (!audio) return json({ error: "no native recording" }, { status: 404 });
          return new Response(audio.bytes, {
            headers: {
              "Content-Type": audio.contentType,
              "Content-Length": String(audio.bytes.byteLength),
              "Cache-Control": "public, max-age=31536000, immutable",
              ...CORS_HEADERS,
            },
          });
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
    "/api/pronounce": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const url = new URL(req.url);
        const sentence = url.searchParams.get("q");
        const take = Number(url.searchParams.get("take") ?? "1");
        if (!sentence) return json({ error: "missing ?q=" }, { status: 400 });
        try {
          const result = await analyzePronunciation(sentence, { take });
          await logPronunciation("GET", { sentence, take }, result);
          return json(result);
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 500 });
        }
      },
      POST: async (req) => {
        const contentType = req.headers.get("content-type") ?? "";
        try {
          if (contentType.startsWith("multipart/form-data")) {
            const form = await req.formData();
            const sentence = String(form.get("sentence") ?? form.get("q") ?? "");
            if (!sentence) return json({ error: "missing sentence" }, { status: 400 });
            const take = Number(form.get("take") ?? "1");
            const audioField = form.get("audio");
            let audio;
            if (audioField instanceof Blob && audioField.size > 0) {
              audio = {
                bytes: new Uint8Array(await audioField.arrayBuffer()),
                contentType: audioField.type,
              };
            }
            const result = await analyzePronunciation(sentence, { take, audio });
            await logPronunciation(
              "POST-multipart",
              {
                sentence,
                take,
                audio: audio ? { bytes: audio.bytes.length, contentType: audio.contentType } : undefined,
              },
              result,
            );
            return json(result);
          }
          const { sentence, q, take } = (await req.json()) as {
            sentence?: string;
            q?: string;
            take?: number;
          };
          const target = sentence ?? q;
          if (!target) return json({ error: "missing sentence" }, { status: 400 });
          const takeN = Number(take ?? 1);
          const result = await analyzePronunciation(target, { take: takeN });
          await logPronunciation("POST-json", { sentence: target, take: takeN }, result);
          return json(result);
        } catch (err) {
          return json({ error: (err as Error).message }, { status: 500 });
        }
      },
    },
    "/api/sound": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      HEAD: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        const entry = lookupOutputEntry(q);
        if (!entry?.sound) return json({ error: "not found" }, { status: 404 });
        try {
          const file = Bun.file(entry.sound);
          const exists = await file.exists();
          if (!exists) return json({ error: "file not found" }, { status: 404 });
          return new Response(null, {
            headers: { "Content-Type": "audio/mpeg", ...CORS_HEADERS },
          });
        } catch {
          return json({ error: "failed to read file" }, { status: 500 });
        }
      },
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        const entry = lookupOutputEntry(q);
        if (!entry?.sound) return json({ error: "not found" }, { status: 404 });
        try {
          const file = Bun.file(entry.sound);
          const exists = await file.exists();
          if (!exists) return json({ error: "file not found" }, { status: 404 });
          return new Response(file, {
            headers: { "Content-Type": "audio/mpeg", ...CORS_HEADERS },
          });
        } catch {
          return json({ error: "failed to read file" }, { status: 500 });
        }
      },
    },
    "/api/sounds": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      HEAD: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        const morphemes = await segment(q);
        const seen = new Set<string>();
        const result: { word: string; sound: string }[] = [];
        for (const m of morphemes) {
          const word = m.dictionary_form || m.surface;
          if (seen.has(word)) continue;
          seen.add(word);
          const entry = lookupOutputEntry(word);
          if (entry?.sound) result.push({ word, sound: entry.sound });
        }
        return json(result);
      },
      GET: async (req) => {
        const q = new URL(req.url).searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        const morphemes = await segment(q);
        const seen = new Set<string>();
        const result: { word: string; sound: string }[] = [];
        for (const m of morphemes) {
          const word = m.dictionary_form || m.surface;
          if (seen.has(word)) continue;
          seen.add(word);
          const entry = lookupOutputEntry(word);
          if (entry?.sound) result.push({ word, sound: entry.sound });
        }
        return json(result);
      },
    },
    "/health": () => json({ ok: true }),
    "/api/translate": {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async (req) => {
        const url = new URL(req.url);
        const q = url.searchParams.get("q");
        const target = url.searchParams.get("l") as "ja" | "en-GB" | null;
        if (!q) return json({ error: "missing ?q=" }, { status: 400 });
        return json(await translate(q, target ?? "ja"));
      },
      POST: async (req) => {
        const body = await req.text();
        if (!body.trim()) return json({ error: "missing body" }, { status: 400 });
        const url = new URL(req.url);
        const target = url.searchParams.get("l") as "ja" | "en-GB" | null;
        return json(await translate(body, target ?? "ja"));
      },
    },
  },
  fetch: () => new Response("Not Found", { status: 404, headers: CORS_HEADERS }),
  development: { hmr: true, console: true },
});

console.log(`hashi-server listening on http://localhost:${server.port}`);
