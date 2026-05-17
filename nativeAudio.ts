// Native-pronunciation audio lookup.
//
// We assume a directory of pre-recorded native WAVs, configured via the
// AUDIO_DIR env var (default "./audio"), laid out like:
//
//   audio/phrases/<phrase>.wav   — whole sentences/phrases, keyed by the
//                                  trimmed surface text ("週末は友達と京都へ行きます")
//   audio/words/<word>.wav       — single dictionary-form words, keyed by
//                                  the dictionary form, surface, or reading
//                                  ("京都", "行く", "きょうと")
//
// When the full-phrase file is missing we fall back to stitching per-word
// recordings together with a short silence between them. If nothing is on
// disk loadNativeAudio returns null and the analyser falls back to a
// synthetic reference shape.

import { join } from "node:path";
import { decodeWav, type DecodedAudio } from "./audioDecode";

const AUDIO_DIR = Bun.env.AUDIO_DIR ?? "./audio";
const PHRASES_DIR = join(AUDIO_DIR, "phrases");
const WORDS_DIR = join(AUDIO_DIR, "words");

export interface NativeMorpheme {
  reading: string;
  surface: string;
  dictionary_form: string;
}

const fileCache = new Map<string, DecodedAudio | null>();

function normalisePhrase(s: string): string {
  return s.replace(/[\s　]+/g, "").replace(/[。、！？!?.,]+$/u, "");
}

async function loadWavFile(path: string): Promise<DecodedAudio | null> {
  const hit = fileCache.get(path);
  if (hit !== undefined) return hit;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    fileCache.set(path, null);
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeWav(bytes);
  fileCache.set(path, decoded);
  return decoded;
}

function concatenate(parts: DecodedAudio[], gapMs = 60): DecodedAudio | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  const sampleRate = parts[0]!.sampleRate;
  // Mismatched sample rates would need resampling — out of scope here. Keep
  // it simple and just return the first clip if a collection is inconsistent.
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

export function phraseAudioPath(sentence: string): string {
  return join(PHRASES_DIR, `${normalisePhrase(sentence)}.wav`);
}

export async function hasNativeAudio(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<boolean> {
  return (await loadNativeAudio(sentence, morphemes)) !== null;
}

export async function loadNativeAudio(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<DecodedAudio | null> {
  const key = normalisePhrase(sentence);
  if (!key) return null;

  const phrase = await loadWavFile(join(PHRASES_DIR, `${key}.wav`));
  if (phrase) return phrase;

  if (morphemes && morphemes.length > 0) {
    const parts: DecodedAudio[] = [];
    for (const m of morphemes) {
      const candidates = [m.dictionary_form, m.surface, m.reading]
        .filter((s): s is string => !!s && s.trim().length > 0);
      let part: DecodedAudio | null = null;
      for (const word of candidates) {
        part = await loadWavFile(join(WORDS_DIR, `${word}.wav`));
        if (part) break;
      }
      if (part) parts.push(part);
    }
    if (parts.length > 0) return concatenate(parts);
  }

  return null;
}

// Returns the raw on-disk bytes of the matching phrase WAV (or the
// stitched-together word WAVs re-encoded as WAV). Used by the
// /api/pronounce/native endpoint so clients can play the reference.
export async function loadNativeAudioBytes(
  sentence: string,
  morphemes?: NativeMorpheme[],
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const key = normalisePhrase(sentence);
  if (!key) return null;

  const phrasePath = join(PHRASES_DIR, `${key}.wav`);
  const phraseFile = Bun.file(phrasePath);
  if (await phraseFile.exists()) {
    return {
      bytes: new Uint8Array(await phraseFile.arrayBuffer()),
      contentType: "audio/wav",
    };
  }

  const decoded = await loadNativeAudio(sentence, morphemes);
  if (!decoded) return null;
  return { bytes: encodeWav(decoded), contentType: "audio/wav" };
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
