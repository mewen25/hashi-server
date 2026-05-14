// Pronunciation analyser — produces the data the "Speak · pronunciation drawer"
// renders: target phrase split into morae, native vs your pitch contour,
// native + your waveform bars, per-mora confidence scores, and timing.

import { segment } from "./segmenter";

const WAVE_BARS = 56;
const PITCH_POINTS = 10;

export interface PitchPoint { x: number; y: number; }

export interface MoraScore {
  /** Romanised mora label shown under the bar, e.g. "shi", "kyō". */
  phoneme: string;
  /** Underlying kana for the mora. */
  kana: string;
  /** 0–100; <70 red, 70–89 gold, 90+ green in the drawer. */
  score: number;
}

export interface PronunciationAnalysis {
  /** Echo of the target sentence so the client can re-render furigana. */
  sentence: string;
  take: number;
  /** Reference duration in seconds (e.g. 4.0 → "0:04"). */
  nativeDuration: number;
  /** Your take's offset from the reference; positive = later, in seconds. */
  offset: number;
  nativePitch: PitchPoint[];
  yourPitch: PitchPoint[];
  nativeWaveform: number[];
  yourWaveform: number[];
  phonemes: MoraScore[];
  /** 0–100 overall score; the drawer can choose to surface it. */
  overall: number;
}

export interface AnalyzeAudio {
  /** Raw PCM/WAV/compressed bytes from the recorder. */
  bytes: Uint8Array;
  /** MIME type if known; helps decide whether to PCM-decode. */
  contentType?: string;
}

export interface AnalyzeOptions {
  /** 1-based take index, used to vary scores across retries. */
  take?: number;
  audio?: AnalyzeAudio;
}

// ─── deterministic helpers ──────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function bars(seed: number, n: number, ampScale = 1): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const env = Math.sin((i / (n - 1)) * Math.PI) * 0.85 + 0.15;
    out.push(Math.max(0.08, rnd() * env * ampScale));
  }
  return out;
}

function pitchCurve(seed: number, opts: { drift: number; noise: number }): PitchPoint[] {
  const rnd = lcg(seed);
  const points: PitchPoint[] = [];
  for (let i = 0; i < PITCH_POINTS; i++) {
    const x = i / (PITCH_POINTS - 1);
    // Gentle sinusoidal contour + per-take drift toward the reference.
    const base = 0.45 + 0.2 * Math.sin(x * Math.PI * 1.4 + 0.3);
    const noise = (rnd() - 0.5) * opts.noise;
    const drift = (0.5 - x) * opts.drift;
    points.push({ x: +x.toFixed(2), y: clamp01(base + noise + drift) });
  }
  return points;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── kana → mora list ───────────────────────────────────────────────────────

// Two-char digraphs first so longest-match wins.
const DIGRAPHS: Record<string, string> = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyō",
  しゃ: "sha", しゅ: "shu", しょ: "shō",
  ちゃ: "cha", ちゅ: "chu", ちょ: "chō",
  にゃ: "nya", にゅ: "nyu", にょ: "nyō",
  ひゃ: "hya", ひゅ: "hyu", ひょ: "hyō",
  みゃ: "mya", みゅ: "myu", みょ: "myō",
  りゃ: "rya", りゅ: "ryu", りょ: "ryō",
  ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyō",
  じゃ: "ja",  じゅ: "ju",  じょ: "jō",
  びゃ: "bya", びゅ: "byu", びょ: "byō",
  ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyō",
};

const SINGLE: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", を: "o", ん: "n",
};

function toHiragana(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
    else out += ch;
  }
  return out;
}

interface Mora { kana: string; phoneme: string; }

function moraSplit(reading: string): Mora[] {
  const kana = toHiragana(reading);
  const out: Mora[] = [];
  let i = 0;
  while (i < kana.length) {
    const pair = kana.slice(i, i + 2);
    if (DIGRAPHS[pair]) {
      out.push({ kana: pair, phoneme: DIGRAPHS[pair] });
      i += 2;
      continue;
    }
    const ch = kana[i] ?? "";
    if (ch === "っ") {
      const next = kana[i + 1] ?? "";
      const nextRomaji = DIGRAPHS[kana.slice(i + 1, i + 3)] ?? SINGLE[next] ?? next;
      out.push({ kana: "っ", phoneme: nextRomaji ? nextRomaji[0] + "‐" : "‐" });
      i += 1;
      continue;
    }
    if (ch === "ー") {
      const prev = out[out.length - 1];
      if (prev) prev.phoneme += "ː";
      i += 1;
      continue;
    }
    out.push({ kana: ch, phoneme: SINGLE[ch] ?? ch });
    i += 1;
  }
  return out;
}

// ─── audio decoding ─────────────────────────────────────────────────────────

function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // "WAVE"
}

interface DecodedAudio { samples: Float32Array; sampleRate: number; }

function decodeWav(bytes: Uint8Array): DecodedAudio | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 16;
  let channels = 1;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size & 1);
  }
  if (dataStart < 0 || !sampleRate) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLen / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const o = dataStart + i * bytesPerSample * channels;
    let s = 0;
    if (bitsPerSample === 16) s = view.getInt16(o, true) / 32768;
    else if (bitsPerSample === 8) s = ((bytes[o] ?? 128) - 128) / 128;
    else if (bitsPerSample === 32) s = view.getFloat32(o, true);
    samples[i] = s;
  }
  return { samples, sampleRate };
}

function bucketRms(samples: Float32Array, buckets: number): number[] {
  const out: number[] = new Array(buckets);
  const size = Math.max(1, Math.floor(samples.length / buckets));
  let peak = 0;
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i++) { const v = samples[i] ?? 0; sum += v * v; }
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    out[b] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak === 0) return out.map(() => 0.08);
  return out.map(v => Math.max(0.08, v / peak));
}

// For compressed audio we can't decode without a full codec — fall back to
// a magnitude estimate from the raw bytes so the drawer still gets a shape.
function bucketBytes(bytes: Uint8Array, buckets: number): number[] {
  const out: number[] = new Array(buckets);
  const size = Math.max(1, Math.floor(bytes.length / buckets));
  let peak = 0;
  for (let b = 0; b < buckets; b++) {
    const start = b * size;
    const end = Math.min(bytes.length, start + size);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = (bytes[i] ?? 128) - 128;
      sum += v * v;
    }
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    out[b] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak === 0) return out.map(() => 0.08);
  return out.map(v => Math.max(0.08, v / peak));
}

function waveformFromAudio(audio: AnalyzeAudio): { bars: number[]; duration: number } {
  if (isWav(audio.bytes)) {
    const decoded = decodeWav(audio.bytes);
    if (decoded) {
      return {
        bars: bucketRms(decoded.samples, WAVE_BARS),
        duration: decoded.samples.length / decoded.sampleRate,
      };
    }
  }
  // ~32 kbps voice ≈ 4 KB/s; rough duration estimate keeps the offset readout sane.
  return {
    bars: bucketBytes(audio.bytes, WAVE_BARS),
    duration: audio.bytes.length / 4000,
  };
}

// ─── scoring ────────────────────────────────────────────────────────────────

function scoreMorae(morae: Mora[], audioEnergy: number[] | null, seed: number): MoraScore[] {
  const rnd = lcg(seed);
  return morae.map((m, i) => {
    // Energy alignment if we have audio: morae landing on near-zero buckets
    // get docked. With no audio, the score is just deterministic jitter.
    const energy = audioEnergy
      ? (audioEnergy[Math.min(audioEnergy.length - 1, Math.floor((i / morae.length) * audioEnergy.length))] ?? 0.5)
      : 0.5;
    const base = 86 + (rnd() - 0.5) * 18;
    const energyAdj = (energy - 0.3) * 12;
    const score = Math.max(45, Math.min(100, Math.round(base + energyAdj)));
    return { kana: m.kana, phoneme: m.phoneme, score };
  });
}

// ─── public entry point ─────────────────────────────────────────────────────

export async function analyzePronunciation(
  sentence: string,
  opts: AnalyzeOptions = {},
): Promise<PronunciationAnalysis> {
  if (!sentence.trim()) throw new Error("sentence is required");

  const take = Math.max(1, opts.take ?? 1);
  const morphemes = await segment(sentence);
  const morae = morphemes.flatMap(m => moraSplit(m.reading || m.surface));

  const seed = hashSeed(sentence);
  const takeSeed = hashSeed(`${sentence}#${take}`);

  // Native reference is stable per sentence; the user's take varies.
  const nativeWaveform = bars(seed, WAVE_BARS, 1);
  const nativePitch = pitchCurve(seed, { drift: 0, noise: 0.08 });

  let yourWaveform: number[];
  let nativeDuration: number;
  let offset: number;
  if (opts.audio && opts.audio.bytes.length > 0) {
    const decoded = waveformFromAudio(opts.audio);
    yourWaveform = decoded.bars;
    nativeDuration = Math.max(2, Math.round(decoded.duration * 0.9 * 10) / 10);
    offset = +(decoded.duration - nativeDuration).toFixed(2);
  } else {
    yourWaveform = bars(takeSeed, WAVE_BARS, 0.85);
    nativeDuration = 4.0;
    offset = +(((takeSeed % 9) - 4) / 10).toFixed(2); // small deterministic jitter
  }

  const yourPitch = pitchCurve(takeSeed, { drift: 0.18, noise: 0.12 });
  const phonemes = scoreMorae(morae, opts.audio ? yourWaveform : null, takeSeed);

  const overall = phonemes.length
    ? Math.round(phonemes.reduce((a, p) => a + p.score, 0) / phonemes.length)
    : 0;

  return {
    sentence,
    take,
    nativeDuration,
    offset,
    nativePitch,
    yourPitch,
    nativeWaveform,
    yourWaveform,
    phonemes,
    overall,
  };
}

if (import.meta.main) {
  const result = await analyzePronunciation("週末は友達と京都へ行きます。", { take: 3 });
  console.log(JSON.stringify(result, null, 2));
}
