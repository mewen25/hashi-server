// Gather reading content from a pasted URL:
//   - YouTube links → caption transcript (no ASR; uses published captions)
//   - everything else → main article text via @extractus/article-extractor

import { extract } from "@extractus/article-extractor";
import type { PassageKind } from "./passages";
import { filterJapanese } from "./japanese";

export interface IngestResult {
  title: string;
  content: string;
  kind: PassageKind;
  source_url: string;
  lang: string;
}

// Carries an HTTP status so the route can map failures to the right code.
export class IngestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "IngestError";
    this.status = status;
  }
}

// ── YouTube transcript ─────────────────────────────────────────────────

const YT_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
// The ANDROID InnerTube client returns caption tracks without the bot checks
// that 429 the public watch page from datacenter IPs.
const ANDROID_VERSION = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14) gzip`;

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string; // "asr" for auto-generated
}

interface YtPlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

// Extract an 11-char video id from common YouTube URL shapes, else null.
export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return YT_ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      const v = url.searchParams.get("v") ?? "";
      return YT_ID.test(v) ? v : null;
    }
    const m = url.pathname.match(/^\/(?:shorts|embed|v|live)\/([^/?#]+)/);
    if (m && YT_ID.test(m[1]!)) return m[1]!;
  }
  return null;
}

function pickTrack(tracks: CaptionTrack[], langPref?: string): CaptionTrack {
  const wanted = langPref?.toLowerCase();
  const score = (t: CaptionTrack): number => {
    let s = 0;
    if (wanted && t.languageCode?.toLowerCase().startsWith(wanted)) s += 2;
    if (t.kind !== "asr") s += 1; // prefer human captions over auto-generated
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0]!;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // must run last
}

// timedtext format=3 is a flat list of <p> cues, each optionally split into
// <s> word segments. One cue per line keeps the transcript readable.
export function parseTimedText(xml: string): string {
  const cues = xml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/g) ?? [];
  return cues
    .map((cue) =>
      decodeEntities(cue.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
    )
    .filter(Boolean)
    .join("\n");
}

async function fetchYoutubeTranscript(
  videoId: string,
  sourceUrl: string,
  langPref?: string,
): Promise<IngestResult> {
  const playerRes = await fetch(YT_PLAYER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: ANDROID_VERSION, hl: langPref ?? "en" } },
      videoId,
    }),
  });
  if (!playerRes.ok) {
    throw new IngestError(`YouTube returned ${playerRes.status} for this video`, 502);
  }
  const data = (await playerRes.json()) as YtPlayerResponse;

  const status = data.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new IngestError(
      `video is not playable: ${data.playabilityStatus?.reason ?? status}`,
      422,
    );
  }

  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) throw new IngestError("no captions available for this video", 422);

  const track = pickTrack(tracks, langPref);
  if (!track.baseUrl) throw new IngestError("caption track has no URL", 502);

  const capRes = await fetch(track.baseUrl, { headers: { "User-Agent": ANDROID_UA } });
  if (!capRes.ok) throw new IngestError(`caption download returned ${capRes.status}`, 502);

  const content = parseTimedText(await capRes.text());
  if (!content.trim()) throw new IngestError("caption track was empty", 422);

  return {
    title: data.videoDetails?.title?.trim() || `YouTube video ${videoId}`,
    content,
    kind: "video",
    source_url: sourceUrl,
    lang: track.languageCode ?? langPref ?? "",
  };
}

// ── Article text ───────────────────────────────────────────────────────

// article-extractor returns sanitized HTML; flatten it to readable plaintext
// while keeping paragraph and list breaks.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*(?:br|hr)\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<\/\s*(?:p|div|h[1-6]|li|tr|blockquote|section|article|ul|ol)\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function fetchArticle(url: string): Promise<IngestResult> {
  let article;
  try {
    article = await extract(url);
  } catch (err) {
    throw new IngestError(`failed to fetch article: ${(err as Error).message}`, 502);
  }
  if (!article?.content) {
    throw new IngestError("could not extract article text from this URL", 422);
  }
  const content = htmlToText(article.content);
  if (!content) throw new IngestError("article had no readable text", 422);
  return {
    title: article.title?.trim() || url,
    content,
    kind: "article",
    source_url: article.url || url,
    lang: "",
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────

export async function ingestUrl(
  rawUrl: string,
  opts: { lang?: string; jaOnly?: boolean } = {},
): Promise<IngestResult> {
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new IngestError("url must start with http:// or https://", 400);
  }
  const videoId = parseYoutubeId(url);
  const result = videoId
    ? await fetchYoutubeTranscript(videoId, url, opts.lang)
    : await fetchArticle(url);

  if (opts.jaOnly) {
    const filtered = filterJapanese(result.content);
    if (!filtered) throw new IngestError("no Japanese text found in this source", 422);
    result.content = filtered;
  }
  return result;
}
