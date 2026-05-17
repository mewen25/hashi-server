// Pronunciation analyser — produces the data the "Speak · pronunciation drawer"
// renders: target phrase split into morae, native vs your pitch contour,
// native + your waveform bars, per-mora confidence scores, and timing.
//
// Native reference comes from a library of pre-recorded WAVs (see
// nativeAudio.ts). When the user submits a take, we decode it the same way
// and score them by comparing the user's bucketed RMS + pitch contour
// against the native's, sliced per mora. If a native recording is missing
// or the user hasn't recorded yet we fall back to deterministic stand-ins
// so the drawer always has something to render.

import { segment } from "./segmenter";
import {
  describeResolved,
  hasNativeFiles,
  loadNativeAudio,
  resolveNative,
} from "./nativeAudio";
import {
  bucketBytes,
  bucketRms,
  decodeViaFfmpeg,
  decodeWav,
  isWav,
  pitchContour,
  type DecodedAudio,
  type PitchPoint,
} from "./audioDecode";

const WAVE_BARS = 56;
const PITCH_POINTS = 10;

export type { PitchPoint };

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
  /** True when a playable native MP3 exists at nativeAudioUrl. */
  nativeAudioAvailable: boolean;
  /** True when nativeWaveform/nativePitch/nativeDuration were derived
   *  from a real recording (WAV sidecar decoded). False means they're
   *  deterministic stand-ins — the drawer may want to label them. */
  nativeAnalysisFromAudio: boolean;
  /** URL the client can hit to play the native reference, if available. */
  nativeAudioUrl?: string;
  /** output.json IDs the native reference was assembled from (one for a
   *  whole-phrase match, several for a stitched per-word match). */
  nativeIds?: string[];
  /** Meaning(s) from the matched entry/entries, joined with " · ". */
  nativeMeaning?: string;
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

// ─── deterministic helpers (fallback when no audio is available) ────────────

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

function syntheticBars(seed: number, n: number, ampScale = 1): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const env = Math.sin((i / (n - 1)) * Math.PI) * 0.85 + 0.15;
    out.push(Math.max(0.08, rnd() * env * ampScale));
  }
  return out;
}

function syntheticPitch(seed: number, opts: { drift: number; noise: number }): PitchPoint[] {
  const rnd = lcg(seed);
  const points: PitchPoint[] = [];
  for (let i = 0; i < PITCH_POINTS; i++) {
    const x = i / (PITCH_POINTS - 1);
    const base = 0.45 + 0.2 * Math.sin(x * Math.PI * 1.4 + 0.3);
    const noise = (rnd() - 0.5) * opts.noise;
    const drift = (0.5 - x) * opts.drift;
    points.push({ x: +x.toFixed(2), y: +clamp01(base + noise + drift).toFixed(3) });
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
      out.push({ kana: pair, phoneme: DIGRAPHS[pair]! });
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

// ─── user-audio decoding ────────────────────────────────────────────────────

interface TakeShape {
  waveform: number[];
  duration: number;
  pitch: PitchPoint[];
  decoded: DecodedAudio | null;
}

function shapeFromDecoded(decoded: DecodedAudio): TakeShape {
  return {
    waveform: bucketRms(decoded.samples, WAVE_BARS),
    duration: decoded.samples.length / decoded.sampleRate,
    pitch: pitchContour(decoded, PITCH_POINTS),
    decoded,
  };
}

async function shapeFromUserAudio(audio: AnalyzeAudio, fallbackSeed: number): Promise<TakeShape> {
  if (isWav(audio.bytes)) {
    const decoded = decodeWav(audio.bytes);
    if (decoded) return shapeFromDecoded(decoded);
  }
  // m4a / webm / ogg / mp3 from the browser/iOS MediaRecorder — decode via
  // ffmpeg so duration and pitch contour reflect the real recording.
  const transcoded = await decodeViaFfmpeg(audio.bytes);
  if (transcoded) return shapeFromDecoded(transcoded);
  // Last resort: rough envelope from raw bytes, synthetic pitch. The byte-
  // length duration estimate is wildly inaccurate (varies with codec
  // bitrate) and is the source of the "13.7s" reading when ffmpeg fails.
  return {
    waveform: bucketBytes(audio.bytes, WAVE_BARS),
    duration: audio.bytes.length / 4000,
    pitch: syntheticPitch(fallbackSeed, { drift: 0.18, noise: 0.12 }),
    decoded: null,
  };
}

// ─── scoring ────────────────────────────────────────────────────────────────

function pitchAt(curve: PitchPoint[], x: number): number {
  if (curve.length === 0) return 0.5;
  if (x <= curve[0]!.x) return curve[0]!.y;
  if (x >= curve[curve.length - 1]!.x) return curve[curve.length - 1]!.y;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!, b = curve[i]!;
    if (x <= b.x) {
      const t = (x - a.x) / Math.max(1e-6, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return curve[curve.length - 1]!.y;
}

// Compare native vs user waveform + pitch per mora region. Each mora gets
// a slice of the 56-bar waveform proportional to its position; the score
// drops as the user's amplitude envelope and pitch diverge from native's.
function scoreFromComparison(
  morae: Mora[],
  nativeWave: number[],
  yourWave: number[],
  nativePitch: PitchPoint[],
  yourPitch: PitchPoint[],
): MoraScore[] {
  if (morae.length === 0) return [];
  const perMora = WAVE_BARS / morae.length;
  return morae.map((m, i) => {
    const start = Math.floor(i * perMora);
    const end = Math.max(start + 1, Math.floor((i + 1) * perMora));
    let diff = 0;
    let count = 0;
    for (let b = start; b < end && b < WAVE_BARS; b++) {
      diff += Math.abs((nativeWave[b] ?? 0) - (yourWave[b] ?? 0));
      count++;
    }
    const ampDiff = count > 0 ? diff / count : 0;
    const ampPenalty = Math.min(40, ampDiff * 80);

    const xMid = (start + (end - start) / 2) / WAVE_BARS;
    const pitchDiff = Math.abs(pitchAt(nativePitch, xMid) - pitchAt(yourPitch, xMid));
    const pitchPenalty = Math.min(25, pitchDiff * 60);

    const score = Math.max(40, Math.min(100, Math.round(100 - ampPenalty - pitchPenalty)));
    return { kana: m.kana, phoneme: m.phoneme, score };
  });
}

// Used when we have a native reference but the user hasn't recorded yet:
// nudge scores based on how well the synthetic "your" waveform aligns with
// the real native envelope so the per-mora bars aren't all identical.
function scoreFromEnergy(morae: Mora[], envelope: number[], seed: number): MoraScore[] {
  const rnd = lcg(seed);
  return morae.map((m, i) => {
    const idx = Math.min(envelope.length - 1, Math.floor((i / Math.max(1, morae.length - 1)) * (envelope.length - 1)));
    const energy = envelope[idx] ?? 0.5;
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

  // 1. Native reference: resolve the dictionary entry/entries so we can
  //    surface IDs + meaning regardless. nativeAudioAvailable means a
  //    playable MP3 exists; nativeAnalysisFromAudio means we also have
  //    the WAV sidecar (from convert_jp_sounds.ts) and the analyser's
  //    waveform/pitch/duration were derived from it rather than synthesised.
  const resolved = await resolveNative(sentence, morphemes);
  const nativeAudioAvailable = resolved !== null && (await hasNativeFiles(resolved));
  const nativeDecoded = resolved ? await loadNativeAudio(sentence, morphemes) : null;
  const nativeAnalysisFromAudio = nativeDecoded !== null;
  const describe = resolved ? describeResolved(resolved) : null;

  const nativeWaveform = nativeDecoded
    ? bucketRms(nativeDecoded.samples, WAVE_BARS)
    : syntheticBars(seed, WAVE_BARS, 1);
  const nativePitch = nativeDecoded
    ? pitchContour(nativeDecoded, PITCH_POINTS)
    : syntheticPitch(seed, { drift: 0, noise: 0.08 });
  const nativeDuration = nativeDecoded
    ? Math.round((nativeDecoded.samples.length / nativeDecoded.sampleRate) * 10) / 10
    : 4.0;

  // 2. User take: real shape if audio submitted, otherwise synthetic.
  let yourWaveform: number[];
  let yourPitch: PitchPoint[];
  let yourDuration: number;
  let offset: number;
  if (opts.audio && opts.audio.bytes.length > 0) {
    const take = await shapeFromUserAudio(opts.audio, takeSeed);
    yourWaveform = take.waveform;
    yourPitch = take.pitch;
    yourDuration = take.duration;
    offset = +(yourDuration - nativeDuration).toFixed(2);
  } else {
    yourWaveform = syntheticBars(takeSeed, WAVE_BARS, 0.85);
    yourPitch = syntheticPitch(takeSeed, { drift: 0.18, noise: 0.12 });
    yourDuration = nativeDuration;
    offset = +(((takeSeed % 9) - 4) / 10).toFixed(2);
  }

  // 3. Per-mora scoring. With user audio we compare against native; without
  //    it we use the native energy envelope plus deterministic jitter so
  //    the bars vary by mora.
  const phonemes = opts.audio && opts.audio.bytes.length > 0
    ? scoreFromComparison(morae, nativeWaveform, yourWaveform, nativePitch, yourPitch)
    : scoreFromEnergy(morae, nativeWaveform, takeSeed);

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
    nativeAudioAvailable,
    nativeAnalysisFromAudio,
    nativeAudioUrl: nativeAudioAvailable
      ? `/api/pronounce/native?q=${encodeURIComponent(sentence)}`
      : undefined,
    nativeIds: describe?.ids,
    nativeMeaning: describe?.meaning,
  };
}

if (import.meta.main) {
  const result = await analyzePronunciation("週末は友達と京都へ行きます。", { take: 3 });
  // console.log(JSON.stringify(result, null, 2));
}
