import { convert } from "./ime";
import { logRequest } from "./requests";
import { suggestEn, getWord } from "./dict";
import { segment } from "./segmenter";
import { translate } from "./translate";
import { analyzeJapaneseSentence } from "./grok";
import {
  createCard,
  deleteCard,
  getCard,
  getStats,
  listCards,
  listDue,
  reviewCard,
  reviewHistory,
  updateCard,
  type Rating,
} from "./cards";

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

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  routes: {
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
