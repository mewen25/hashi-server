import { convert } from "./ime";
import { logRequest } from "./requests";
import { suggestEn, getWord } from "./dict";
import { segment } from "./segmenter";
import { translate } from "./translate";
import { analyzeJapaneseSentence } from "./grok";

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
