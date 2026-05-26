// Core function to call DeepSeek API (drop-in replacement for grok.ts / claude.ts).

import { segment } from "./segmenter";

interface DeepSeekMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SegmentFeedback {
  surface: string;
  confidence: number;
  issue: string | null;
  suggestion: string | null;
}

export interface SentenceAnalysis {
  segments: SegmentFeedback[];
  corrected: string;
  summary: string;
  recommendation: string;
  overallConfidence: number;
}

export interface AnalyzeOptions {
  intent?: string;
  onSegment?: (segment: SegmentFeedback, index: number) => void;
  mode?: string;
}

const SYSTEM_PROMPT =
  `You are a Japanese tutor scoring a learner's sentence. ` +
  `You must return ONLY valid JSON (no markdown fences, no extra text) matching this exact schema:\n` +
  `{\n` +
  `  "segments": [{"surface": string, "confidence": number 0-1, "issue": string|null, "suggestion": string|null}],\n` +
  `  "corrected": string,\n` +
  `  "summary": string,\n` +
  `  "recommendation": string,\n` +
  `  "overallConfidence": number\n` +
  `}\n` +
  `For each morpheme, score confidence 0-1 (1=natural, 0.7-0.9=awkward, 0.4-0.6=wrong but recoverable, 0-0.3=breaks the sentence). ` +
  `For non-1.0 segments, set "issue" to a short reason (e.g. "wrong particle", "broken conjugation", "unnatural register") and "suggestion" to the replacement token; else null. ` +
  `"corrected" is a natural rewrite (equal to the input if already fine). ` +
  `"summary" is 1-2 sentences describing what went wrong, or praise if fine. ` +
  `"recommendation" is one concrete next step for the learner — a grammar point to review, a pattern to drill, or "keep going" if the sentence is solid. ` +
  `The "segments" array must match the morpheme breakdown's order and length exactly.`;

const CACHE_LIMIT = 256;
const cache = new Map<string, SentenceAnalysis>();

function cacheGet(key: string): SentenceAnalysis | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: SentenceAnalysis): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function log(tag: string, t0: number, msg: string): void {
  console.log(`[deepseek.ts +${(performance.now() - t0).toFixed(0)}ms] ${tag}: ${msg}`);
}

async function* streamDeepSeek(
  messages: DeepSeekMessage[],
  t0: number = performance.now(),
): AsyncGenerator<string, void, void> {
  const apiKey = process.env.DEEPSEEK_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_KEY environment variable is required");

  log("fetch", t0, `POST deepseek-chat (${messages.at(-1)?.content.length ?? 0}B user prompt)`);

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.1,
      max_tokens: 1500,
      stream: true,
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 300)}`);
  }

  log("connected", t0, `HTTP ${response.status}, streaming SSE`);

  const decoder = new TextDecoder();
  let sseBuffer = "";
  let firstDelta = true;
  let deltaCount = 0;
  let bytesYielded = 0;

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    sseBuffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = sseBuffer.indexOf("\n\n")) !== -1) {
      const event = sseBuffer.slice(0, nl);
      sseBuffer = sseBuffer.slice(nl + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstDelta) { log("first-token", t0, "first delta received"); firstDelta = false; }
            deltaCount++;
            bytesYielded += delta.length;
            yield delta;
          }
        } catch {
          // mid-chunk SSE fragment, skip
        }
      }
    }
  }

  log("stream-done", t0, `deltas=${deltaCount}, bytes=${bytesYielded}`);
}

// Walks the streamed buffer and emits each completed segment object inside `"segments": [...]`.
function extractCompletedSegments(buffer: string, alreadyEmitted: number): SegmentFeedback[] {
  const arrayKey = buffer.indexOf('"segments"');
  if (arrayKey === -1) return [];
  const arrayStart = buffer.indexOf("[", arrayKey);
  if (arrayStart === -1) return [];

  const out: SegmentFeedback[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;
  let count = 0;

  for (let i = arrayStart + 1; i < buffer.length; i++) {
    const ch = buffer[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        if (count >= alreadyEmitted) {
          try {
            out.push(JSON.parse(buffer.slice(objectStart, i + 1)) as SegmentFeedback);
          } catch {
            return out;
          }
        }
        count++;
        objectStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }
  return out;
}

/**
 * Analyze a Japanese sentence attempt and return per-segment plus sentence-level feedback.
 * Streams under the hood via DeepSeek API: pass `onSegment` to react as each segment lands.
 */
export async function analyzeJapaneseSentence(
  sentence: string,
  opts: AnalyzeOptions = {},
): Promise<SentenceAnalysis> {
  const t0 = performance.now();
  log("start", t0, `sentence="${sentence}" intent=${opts.intent ? `"${opts.intent}"` : "none"}`);

  const segStart = performance.now();
  const morphemes = await segment(sentence);
  log("segment", t0, `got ${morphemes.length} morphemes in ${(performance.now() - segStart).toFixed(0)}ms`);

  const cacheKey = `${sentence} ${opts.intent ?? ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    log("cache-hit", t0, `replaying ${cached.segments.length} segments`);
    cached.segments.forEach((seg, i) => opts.onSegment?.(seg, i));
    log("done", t0, `cache hit, total ${(performance.now() - t0).toFixed(0)}ms`);
    return cached;
  }
  log("cache-miss", t0, `key="${cacheKey.slice(0, 60)}"`);

  const breakdown = morphemes
    .map((m, i) => `${i}\t${m.surface}\t${m.dictionary_form}\t${m.reading}\t${m.pos}`)
    .join("\n");

  const userContent = [
    `Sentence: ${sentence}`,
    opts.intent ? `Intended meaning: ${opts.intent}` : null,
    "Morpheme breakdown (index, surface, dict_form, reading, pos):",
    breakdown,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: DeepSeekMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  let buffer = "";
  let emitted = 0;
  for await (const delta of streamDeepSeek(messages, t0)) {
    buffer += delta;
    if (opts.onSegment) {
      const ready = extractCompletedSegments(buffer, emitted);
      for (const seg of ready) {
        log("segment-ready", t0, `#${emitted} "${seg.surface}" confidence=${seg.confidence}`);
        opts.onSegment(seg, emitted);
        emitted++;
      }
    }
  }
  log("buffer-complete", t0, `received ${buffer.length}B total, ${emitted} segments emitted`);

  let parsed: SentenceAnalysis;
  try {
    parsed = JSON.parse(buffer) as SentenceAnalysis;
  } catch {
    throw new Error(`Failed to parse DeepSeek response as JSON: ${buffer.slice(0, 200)}`);
  }
  log("parsed", t0, `corrected="${parsed.corrected}" overall=${parsed.overallConfidence}`);

  if (!Array.isArray(parsed.segments) || parsed.segments.length !== morphemes.length) {
    log("segment-fixup", t0, `model returned ${parsed.segments?.length ?? 0} segments, expected ${morphemes.length} — padding`);
    parsed.segments = morphemes.map((m, i) => ({
      surface: m.surface,
      confidence: parsed.segments?.[i]?.confidence ?? 0,
      issue: parsed.segments?.[i]?.issue ?? null,
      suggestion: parsed.segments?.[i]?.suggestion ?? null,
    }));
  }

  cacheSet(cacheKey, parsed);
  log("done", t0, `total ${(performance.now() - t0).toFixed(0)}ms`);
  return parsed;
}

if (import.meta.main) {
  const t0 = performance.now();
  const result = await analyzeJapaneseSentence("私もやってみたい！", {
    intent: "I want to try too!",
    onSegment: (seg, i) => {
      console.log(`[+${(performance.now() - t0).toFixed(0)}ms] segment ${i}: ${seg.surface} (${seg.confidence})`);
    },
  });
  console.log(`\nfinal (+${(performance.now() - t0).toFixed(0)}ms):`);
  console.log(JSON.stringify(result, null, 2));
}
