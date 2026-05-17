// Core function to call Claude via the `claude -p` CLI (drop-in alternative to grok.ts).

import { segment } from "./segmenter";

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
  model?: string;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          surface: { type: "string" },
          confidence: { type: "number" },
          issue: { type: ["string", "null"] },
          suggestion: { type: ["string", "null"] },
        },
        required: ["surface", "confidence", "issue", "suggestion"],
        additionalProperties: false,
      },
    },
    corrected: { type: "string" },
    summary: { type: "string" },
    recommendation: { type: "string" },
    overallConfidence: { type: "number" },
  },
  required: ["segments", "corrected", "summary", "recommendation", "overallConfidence"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  `You are a Japanese tutor scoring a learner's sentence. ` +
  `For each morpheme, score confidence 0-1 (1=natural, 0.7-0.9=awkward, 0.4-0.6=wrong but recoverable, 0-0.3=breaks the sentence). ` +
  `For non-1.0 segments, set "issue" to a short reason (e.g. "wrong particle", "broken conjugation", "unnatural register") and "suggestion" to the replacement token; else null. ` +
  `Also return "corrected" (natural rewrite, equal to the input if already fine), "summary" (1-2 sentences describing what went wrong, or praise if fine), "recommendation" (one concrete next step for the learner — a grammar point to review, a pattern to drill, or "keep going" if the sentence is solid), and "overallConfidence". ` +
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

interface StreamEvent {
  type: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: { type?: string; text?: string };
  };
  message?: { content?: Array<{ type?: string; text?: string }> };
  result?: string;
  subtype?: string;
  is_error?: boolean;
}

const DEFAULT_MODEL = "haiku";

function log(tag: string, t0: number, msg: string): void {
  console.log(`[claude.ts +${(performance.now() - t0).toFixed(0)}ms] ${tag}: ${msg}`);
}

async function* streamClaude(
  systemPrompt: string,
  userPrompt: string,
  model: string = DEFAULT_MODEL,
  t0: number = performance.now(),
): AsyncGenerator<string, void, void> {
  const args = [
    "claude",
    "-p",
    userPrompt,
    "--system-prompt", systemPrompt,
    "--json-schema", JSON.stringify(RESPONSE_SCHEMA),
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--no-session-persistence",
    "--model", model,
  ];

  log("spawn", t0, `claude -p (model=${model}, prompt=${userPrompt.length}B, system=${systemPrompt.length}B)`);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const decoder = new TextDecoder();
  let buffer = "";
  let sawDelta = false;
  let firstByteAt = 0;
  let firstDeltaAt = 0;
  let deltaCount = 0;
  let bytesYielded = 0;
  // With --json-schema, the CLI wraps structured output in a StructuredOutput
  // tool call (deltas of type input_json_delta → `partial_json`) AND then
  // echoes the same JSON back as plain text_delta on a follow-up turn. Lock
  // onto whichever stream type arrives first and ignore the other, otherwise
  // the buffer ends up containing the JSON twice and won't parse.
  let streamMode: "partial_json" | "text" | null = null;

  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    if (firstByteAt === 0) {
      firstByteAt = performance.now();
      log("first-byte", t0, `first stdout chunk (${chunk.length}B)`);
    }
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        continue;
      }

      if (event.type === "system" && event.subtype === "init") {
        log("init", t0, "claude session initialized");
      } else if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
        const delta = event.event.delta;
        if (delta?.partial_json !== undefined) {
          if (streamMode === null) {
            streamMode = "partial_json";
            log("stream-mode", t0, "locked onto partial_json (tool-use schema)");
          }
          if (streamMode === "partial_json") {
            if (!sawDelta) { firstDeltaAt = performance.now(); log("first-token", t0, "first partial_json delta"); }
            sawDelta = true;
            deltaCount++;
            bytesYielded += delta.partial_json.length;
            yield delta.partial_json;
          }
        } else if (delta?.text !== undefined) {
          if (streamMode === null) {
            streamMode = "text";
            log("stream-mode", t0, "locked onto text_delta");
          }
          if (streamMode === "text") {
            if (!sawDelta) { firstDeltaAt = performance.now(); log("first-token", t0, "first text delta"); }
            sawDelta = true;
            deltaCount++;
            bytesYielded += delta.text.length;
            yield delta.text;
          }
        }
      } else if (!sawDelta && event.type === "assistant" && event.message?.content) {
        log("fallback", t0, "no deltas seen, falling back to full assistant message");
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            bytesYielded += block.text.length;
            yield block.text;
          }
        }
      } else if (event.type === "result") {
        if (event.is_error) {
          throw new Error(`claude -p error: ${event.result ?? event.subtype ?? "unknown"}`);
        }
        log("result", t0, `success (deltas=${deltaCount}, bytes=${bytesYielded})`);
      }
    }
  }

  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude -p exited with code ${proc.exitCode}: ${stderr.slice(0, 500)}`);
  }
  const ttft = firstDeltaAt ? (firstDeltaAt - t0).toFixed(0) : "n/a";
  log("exit", t0, `claude exited ok (ttft=${ttft}ms, deltas=${deltaCount}, bytes=${bytesYielded})`);
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
 * Streams under the hood via `claude -p`: pass `onSegment` to react as each segment lands.
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
  log("cache-miss", t0, `key="${cacheKey.slice(0, 60)}..."`);

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

  let buffer = "";
  let emitted = 0;
  for await (const delta of streamClaude(SYSTEM_PROMPT, userContent, opts.model, t0)) {
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
  log("stream-done", t0, `received ${buffer.length}B total, ${emitted} segments emitted`);

  let parsed: SentenceAnalysis;
  try {
    parsed = JSON.parse(buffer) as SentenceAnalysis;
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${buffer.slice(0, 200)}`);
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
