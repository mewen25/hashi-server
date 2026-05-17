// Shared audio primitives: WAV decoding, RMS bucketing, pitch detection.
// pronunciation.ts and nativeAudio.ts both consume these.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface PitchPoint { x: number; y: number; }

export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;  // "WAVE"
}

export function decodeWav(bytes: Uint8Array): DecodedAudio | null {
  if (!isWav(bytes)) return null;
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

export function bucketRms(samples: Float32Array, buckets: number): number[] {
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

// Pipe arbitrary compressed audio (m4a/webm/ogg/mp3/…) through ffmpeg to
// raw mono Float32 PCM at 16 kHz. Used as the fallback when the browser
// MediaRecorder gives us something other than WAV. We output raw f32le
// rather than WAV because ffmpeg can't seek when writing to a pipe and
// produces a WAV with a bogus data-chunk size that crashes decodeWav.
// Returns null if ffmpeg isn't on PATH or the input is unrecognisable.
const FFMPEG_SAMPLE_RATE = 16000;
export async function decodeViaFfmpeg(bytes: Uint8Array): Promise<DecodedAudio | null> {
  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(FFMPEG_SAMPLE_RATE), "-f", "f32le", "pipe:1"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(bytes);
    await proc.stdin.end();
    const [ab, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ]);
    if (code !== 0 || ab.byteLength < 4) return null;
    return { samples: new Float32Array(ab), sampleRate: FFMPEG_SAMPLE_RATE };
  } catch {
    return null;
  }
}

// For compressed/unknown bytes we can't decode without a codec — fall back to
// a magnitude estimate from raw bytes so the drawer still gets a shape.
export function bucketBytes(bytes: Uint8Array, buckets: number): number[] {
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

// Normalised autocorrelation pitch detector. Returns a frequency in Hz, or
// null if the window is too quiet or no lag has strong enough correlation
// (i.e. it's noise/silence rather than a voiced segment).
function detectPitchHz(
  samples: Float32Array,
  start: number,
  length: number,
  sampleRate: number,
): number | null {
  const FMIN = 70, FMAX = 400;
  const end = Math.min(samples.length, start + length);
  let rms = 0, n = 0;
  for (let i = start; i < end; i++) { const v = samples[i] ?? 0; rms += v * v; n++; }
  if (n === 0) return null;
  rms = Math.sqrt(rms / n);
  if (rms < 0.015) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / FMAX));
  const maxLag = Math.min(end - start - 2, Math.floor(sampleRate / FMIN));
  if (maxLag <= minLag) return null;

  // Walk every lag, tracking the global peak so we can pick the *first*
  // local maximum within 90% of it — for a periodic signal every multiple
  // of the period correlates as strongly as the fundamental, so a plain
  // argmax aliases to the longest matching lag instead of the pitch.
  const corrs = new Float32Array(maxLag - minLag + 1);
  let peakCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, norm1 = 0, norm2 = 0;
    for (let i = start; i + lag < end; i++) {
      const a = samples[i] ?? 0;
      const b = samples[i + lag] ?? 0;
      corr += a * b;
      norm1 += a * a;
      norm2 += b * b;
    }
    const denom = Math.sqrt(norm1 * norm2);
    const c = denom > 0 ? corr / denom : 0;
    corrs[lag - minLag] = c;
    if (c > peakCorr) peakCorr = c;
  }
  if (peakCorr < 0.5) return null;
  const threshold = peakCorr * 0.9;
  let bestLag = -1;
  for (let i = 1; i < corrs.length - 1; i++) {
    if (corrs[i]! >= threshold && corrs[i]! >= corrs[i - 1]! && corrs[i]! >= corrs[i + 1]!) {
      bestLag = i + minLag;
      break;
    }
  }
  if (bestLag < 0) return null;
  return sampleRate / bestLag;
}

// Map a frequency onto 0–1 on a log scale between 70 Hz and 400 Hz so it
// lines up with the drawer's pitch lane.
function normalisePitch(hz: number): number {
  const lo = Math.log2(70), hi = Math.log2(400);
  const y = (Math.log2(hz) - lo) / (hi - lo);
  return Math.max(0, Math.min(1, y));
}

export function pitchContour(audio: DecodedAudio, points: number): PitchPoint[] {
  const out: PitchPoint[] = [];
  const winSize = Math.max(256, Math.floor(audio.samples.length / points));
  let last = 0.5;
  for (let i = 0; i < points; i++) {
    const start = Math.floor((i / points) * audio.samples.length);
    const hz = detectPitchHz(audio.samples, start, winSize, audio.sampleRate);
    const y = hz === null ? last : normalisePitch(hz);
    if (hz !== null) last = y;
    out.push({ x: +(i / (points - 1)).toFixed(2), y: +y.toFixed(3) });
  }
  return out;
}
