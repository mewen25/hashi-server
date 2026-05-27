// Native-pronunciation audio lookup, backed by the dictionary loader in
// dict.ts (which reads output.json at startup and indexes entries by both
// alt/kanji form and reading). Each entry's `sound` field is a path to an
// MP3 under jp_sounds/, e.g. "jp_sounds/jp_1_male.mp3".
//
// Lookup tries the whole sentence first; if no single entry covers it, we
// stitch per-morpheme recordings together. For playback we concatenate the
// raw MP3 bytes — MPEG frames are self-delimiting so naive concatenation
// works for files from the same encoder, which is the common case here.
//
// For PCM analysis (pitch contour, RMS bucketing) we read sidecar WAVs
// pre-converted from the MP3s into ./audio/ by convert_jp_sounds.ts. If a
// sidecar is missing, loadNativeAudio falls back to null for that part and
// the analyser uses synthetic shapes.

import { lookupOutputEntry } from "./dict";
import { decodeWav, type DecodedAudio } from "./audioDecode";
import { assetExists, readAsset } from "./assets";

export interface NativeEntry {
  id: string;
  /** Hiragana reading (the `p` field in output.json). */
  reading: string;
  /** Romaji (`ro`). */
  romaji: string;
  /** Kanji or alt form (`alt`); falls back to reading when no kanji exists. */
  alt: string;
  /** English meaning (`en`). */
  meaning: string;
  /** Relative path to the MP3 (`sound`). */
  sound: string;
}

export interface ResolvedNative {
  id: string;
  entry: NativeEntry;
}

export interface NativeMorpheme {
  reading: string;
  surface: string;
  dictionary_form: string;
  /** MeCab POS tag, e.g. "動詞", "名詞", "助詞", "助動詞". */
  pos?: string;
}

function normaliseKey(s: string): string {
  return s.replace(/[\s　]+/g, "").replace(/[。、！？!?.,]+$/u, "");
}

// dict.lookupOutputEntry only does exact-string lookup against the alt and
// reading indexes. We do the same trim-and-strip-trailing-punctuation pass
// here so sentences like "京都。" still find the "京都" entry.
function findEntry(text: string): NativeEntry | null {
  const norm = normaliseKey(text);
  if (!norm) return null;
  const hit = lookupOutputEntry(norm);
  if (!hit || !hit.sound) return null;
  console.log(`findEntry: norm="${norm}" hit.id="${hit.id}" hit.sound="${hit.sound}"`)
  return {
    id: hit.id,
    reading: hit.p,
    romaji: hit.ro,
    alt: hit.alt,
    meaning: hit.en,
    sound: hit.sound,
  };
}

// Particles (は, を, へ, の, …) and auxiliaries (ます, です, ぬ, た, …) carry
// no lexical content — a recording of them in isolation doesn't help anyone
// pronounce the surrounding phrase, and they're frequent enough that an
// indiscriminate per-morpheme stitch will often surface them as "native
// audio" for a sentence (e.g. わかりません → ぬ). Skip them, and require
// every remaining content morpheme to have a recording before stitching:
// a partial stitch (Kyoto + nothing for 行く) misleads worse than no audio.
function isStitchableContent(pos?: string): boolean {
  if (!pos) return true;
  if (pos.startsWith("助詞")) return false;
  if (pos.startsWith("助動詞")) return false;
  if (pos.startsWith("記号")) return false;
  if (pos.startsWith("フィラー")) return false;
  return true;
}

function entriesForMorphemes(morphemes: NativeMorpheme[]): ResolvedNative[] {
  const content = morphemes.filter(m => isStitchableContent(m.pos));
  if (content.length === 0) return [];
  const out: ResolvedNative[] = [];
  const seenIds = new Set<string>();
  for (const m of content) {
    const candidates = [m.dictionary_form, m.surface, m.reading].filter(
      (s): s is string => !!s && s.trim().length > 0,
    );
    let matched: NativeEntry | null = null;
    for (const c of candidates) {
      const entry = findEntry(c);
      if (entry) { matched = entry; break; }
    }
    if (!matched) return []; // incomplete coverage — refuse the stitch
    if (seenIds.has(matched.id)) continue;
    seenIds.add(matched.id);
    out.push({ id: matched.id, entry: matched });
  }
  return out;
}

// Returns the entries that cover `sentence`. A single-element array means
// we found a whole-phrase recording; a longer array means we stitched
// per-word entries. null means nothing matched.
export async function resolveNative(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<ResolvedNative[] | null> {
  const phrase = findEntry(sentence);
  if (phrase) return [{ id: phrase.id, entry: phrase }];
  if (morphemes && morphemes.length > 0) {
    const stitched = entriesForMorphemes(morphemes);
    if (stitched.length > 0) return stitched;
  }
  return null;
}

export function describeResolved(resolved: ResolvedNative[]): { ids: string[]; meaning?: string } {
  const ids = resolved.map(r => r.id);
  const meanings = resolved
    .map(r => r.entry.meaning)
    .filter((s): s is string => !!s && s.trim().length > 0);
  return { ids, meaning: meanings.length > 0 ? meanings.join(" · ") : undefined };
}

// True iff every resolved entry's sound file actually exists on disk.
// Used by the analyser to decide whether to advertise nativeAudioUrl.
export async function hasNativeFiles(resolved: ResolvedNative[]): Promise<boolean> {
  for (const r of resolved) {
    if (!(await assetExists(r.entry.sound))) return false;
  }
  return true;
}

// "jp_sounds/jp_1_male.mp3" → "audio/jp_1_male.wav"
function wavPathFor(soundPath: string): string {
  return soundPath.replace(/^jp_sounds\//, "audio/").replace(/\.mp3$/i, ".wav");
}

const decodedCache = new Map<string, DecodedAudio | null>();
async function loadDecodedWav(path: string): Promise<DecodedAudio | null> {
  const hit = decodedCache.get(path);
  if (hit !== undefined) return hit;
  const bytes = await readAsset(path);
  if (!bytes) { decodedCache.set(path, null); return null; }
  const decoded = decodeWav(bytes);
  decodedCache.set(path, decoded);
  return decoded;
}

// Stitch per-entry clips with a short silence so per-mora scoring still
// sees clear boundaries. Mismatched sample rates would need resampling
// (out of scope); in that case fall back to the first clip.
function concatenate(parts: DecodedAudio[], gapMs = 60): DecodedAudio | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  const sampleRate = parts[0]!.sampleRate;
  if (!parts.every(p => p.sampleRate === sampleRate)) return parts[0]!;
  const gap = Math.floor((gapMs / 1000) * sampleRate);
  const total = parts.reduce((acc, p) => acc + p.samples.length, 0) + gap * (parts.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i]!.samples, off);
    off += parts[i]!.samples.length;
    if (i < parts.length - 1) off += gap;
  }
  return { samples: out, sampleRate };
}

// Decode the WAV sidecars for the resolved entries and concatenate. Skips
// any entry whose sidecar is missing; returns null if none decode.
export async function loadNativeAudio(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<DecodedAudio | null> {
  const resolved = await resolveNative(sentence, morphemes);
  if (!resolved) return null;
  const parts: DecodedAudio[] = [];
  for (const r of resolved) {
    const decoded = await loadDecodedWav(wavPathFor(r.entry.sound));
    if (decoded) parts.push(decoded);
  }
  return concatenate(parts);
}

// MP3 bytes for /api/pronounce/native. A single phrase streams the file
// as-is; stitched matches concatenate the MP3 byte streams (MPEG frames
// are self-delimiting, so this plays back fine in browsers for files
// from the same encoder).
export async function loadNativeAudioBytes(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const resolved = await resolveNative(sentence, morphemes);
  if (!resolved) return null;

  const chunks: Uint8Array[] = [];
  for (const r of resolved) {
    const bytes = await readAsset(r.entry.sound);
    if (!bytes) continue;
    chunks.push(bytes);
  }
  if (chunks.length === 0) return null;
  if (chunks.length === 1) {
    return { bytes: chunks[0]!, contentType: "audio/mpeg" };
  }

  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, contentType: "audio/mpeg" };
}
