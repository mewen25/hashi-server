// Native-pronunciation audio lookup, driven by a manifest at
// audio/manifest.json. The manifest is an object keyed by entry ID:
//
//   {
//     "00123": { "kanji": "京都", "reading": "きょうと", "meaning": "Kyoto", "file": "00123.wav" },
//     ...
//   }
//
// Each entry's `file` is resolved relative to AUDIO_DIR (default "./audio").
// We build reverse indexes from normalised kanji and reading to ID at load
// time (kanji takes priority over reading on collision). Lookup tries the
// whole sentence first; if no single entry covers it, we stitch per-morpheme
// recordings together with a short silence so the analyser still gets a
// reference shape. If neither path turns up anything, loadNativeAudio
// returns null and the analyser falls back to a synthetic reference.

import { join } from "node:path";
import { decodeWav, type DecodedAudio } from "./audioDecode";

const AUDIO_DIR = Bun.env.AUDIO_DIR ?? "./audio";
const MANIFEST_PATH = join(AUDIO_DIR, "manifest.json");

export interface ManifestEntry {
  kanji?: string;
  reading?: string;
  meaning?: string;
  file: string;
}

export interface ResolvedNative {
  id: string;
  entry: ManifestEntry;
}

export interface NativeMorpheme {
  reading: string;
  surface: string;
  dictionary_form: string;
}

interface ManifestIndex {
  byId: Map<string, ManifestEntry>;
  byKey: Map<string, string>;
}

let manifestCache: Promise<ManifestIndex | null> | null = null;
const fileCache = new Map<string, DecodedAudio | null>();

function normaliseKey(s: string): string {
  return s.replace(/[\s　]+/g, "").replace(/[。、！？!?.,]+$/u, "");
}

async function loadManifest(): Promise<ManifestIndex | null> {
  if (manifestCache) return manifestCache;
  manifestCache = (async () => {
    const file = Bun.file(MANIFEST_PATH);
    if (!(await file.exists())) return null;
    let raw: unknown;
    try {
      raw = await file.json();
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const byId = new Map<string, ManifestEntry>();
    const entries = Object.entries(raw as Record<string, unknown>);
    for (const [id, value] of entries) {
      if (!value || typeof value !== "object") continue;
      const e = value as Record<string, unknown>;
      const fileField = typeof e.file === "string" ? e.file : undefined;
      if (!fileField) continue;
      byId.set(id, {
        kanji: typeof e.kanji === "string" ? e.kanji : undefined,
        reading: typeof e.reading === "string" ? e.reading : undefined,
        meaning: typeof e.meaning === "string" ? e.meaning : undefined,
        file: fileField,
      });
    }

    // Kanji entries take priority over reading-only matches on collision.
    const byKey = new Map<string, string>();
    for (const [id, entry] of byId) {
      if (!entry.kanji) continue;
      const key = normaliseKey(entry.kanji);
      if (key && !byKey.has(key)) byKey.set(key, id);
    }
    for (const [id, entry] of byId) {
      if (!entry.reading) continue;
      const key = normaliseKey(entry.reading);
      if (key && !byKey.has(key)) byKey.set(key, id);
    }
    return { byId, byKey };
  })();
  return manifestCache;
}

// Test seam: drop the in-memory manifest + file caches.
export function _resetNativeCache() {
  manifestCache = null;
  fileCache.clear();
}

async function loadWavFile(file: string): Promise<DecodedAudio | null> {
  const path = join(AUDIO_DIR, file);
  const hit = fileCache.get(path);
  if (hit !== undefined) return hit;
  const f = Bun.file(path);
  if (!(await f.exists())) {
    fileCache.set(path, null);
    return null;
  }
  const bytes = new Uint8Array(await f.arrayBuffer());
  const decoded = decodeWav(bytes);
  fileCache.set(path, decoded);
  return decoded;
}

function concatenate(parts: DecodedAudio[], gapMs = 60): DecodedAudio | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  const sampleRate = parts[0]!.sampleRate;
  // Mismatched sample rates would need resampling — out of scope. Keep it
  // simple and use just the first clip if the collection is inconsistent.
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

// Walk the morphemes and pick a manifest entry per surface form, trying
// dictionary form / surface / reading in turn. Skips particles or other
// morphemes that the manifest doesn't cover so a partial match still
// yields something usable.
function entriesForMorphemes(index: ManifestIndex, morphemes: NativeMorpheme[]): ResolvedNative[] {
  const out: ResolvedNative[] = [];
  for (const m of morphemes) {
    const candidates = [m.dictionary_form, m.surface, m.reading]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .map(normaliseKey);
    for (const key of candidates) {
      const id = index.byKey.get(key);
      if (!id) continue;
      const entry = index.byId.get(id);
      if (entry) { out.push({ id, entry }); break; }
    }
  }
  return out;
}

// Returns the manifest entries that cover `sentence`. A single-element
// array means we found a whole-phrase recording; a longer array means we
// stitched per-word entries. null means nothing matched.
export async function resolveNative(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<ResolvedNative[] | null> {
  const index = await loadManifest();
  if (!index) return null;
  const key = normaliseKey(sentence);
  if (!key) return null;

  const phraseId = index.byKey.get(key);
  if (phraseId) {
    const entry = index.byId.get(phraseId);
    if (entry) return [{ id: phraseId, entry }];
  }
  if (morphemes && morphemes.length > 0) {
    const stitched = entriesForMorphemes(index, morphemes);
    if (stitched.length > 0) return stitched;
  }
  return null;
}

// Convenience metadata for the analyser response: meaning + entry IDs of
// whatever we resolved to. Single phrase → meaning of the entry; stitched
// → meanings joined with " · ".
export function describeResolved(resolved: ResolvedNative[]): { ids: string[]; meaning?: string } {
  const ids = resolved.map(r => r.id);
  const meanings = resolved
    .map(r => r.entry.meaning)
    .filter((s): s is string => !!s && s.trim().length > 0);
  return { ids, meaning: meanings.length > 0 ? meanings.join(" · ") : undefined };
}

export async function loadNativeAudio(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<DecodedAudio | null> {
  const resolved = await resolveNative(sentence, morphemes);
  if (!resolved) return null;
  const parts: DecodedAudio[] = [];
  for (const r of resolved) {
    const audio = await loadWavFile(r.entry.file);
    if (audio) parts.push(audio);
  }
  if (parts.length === 0) return null;
  return concatenate(parts);
}

// Raw on-disk bytes for the /api/pronounce/native endpoint. A single
// phrase match streams the file as-is; a stitched match is concatenated
// and re-encoded as 16-bit PCM WAV.
export async function loadNativeAudioBytes(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const resolved = await resolveNative(sentence, morphemes);
  if (!resolved) return null;

  if (resolved.length === 1) {
    const path = join(AUDIO_DIR, resolved[0]!.entry.file);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: "audio/wav",
    };
  }

  const stitched = await loadNativeAudio(sentence, morphemes);
  if (!stitched) return null;
  return { bytes: encodeWav(stitched), contentType: "audio/wav" };
}

function encodeWav(audio: DecodedAudio): Uint8Array {
  const { samples, sampleRate } = audio;
  const bytesPerSample = 2;
  const dataLen = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
}
