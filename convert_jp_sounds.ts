// One-shot script: convert every jp_sounds/*.mp3 to audio/*.wav (mono 16-bit
// PCM, sample rate left as-is) so nativeAudio.ts can decode native
// recordings for pitch/RMS analysis without an MP3 codec at runtime.
// MP3 originals stay in jp_sounds/ for browser playback.
//
// Idempotent — already-converted files are skipped. Run with:
//   bun convert_jp_sounds.ts
// Optional flags:
//   --force        re-convert even if the .wav already exists
//   --jobs=N       parallel ffmpeg workers (default: nproc)

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = "jp_sounds";
const OUT_DIR = "audio";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const jobsArg = [...args].find(a => a.startsWith("--jobs="));
const jobs = jobsArg ? Math.max(1, parseInt(jobsArg.split("=")[1] ?? "0", 10)) : (navigator.hardwareConcurrency || 8);

await mkdir(OUT_DIR, { recursive: true });

const mp3s = await Array.fromAsync(new Bun.Glob("*.mp3").scan(SRC_DIR));
mp3s.sort();
console.log(`found ${mp3s.length} mp3s in ${SRC_DIR}/`);

let done = 0, skipped = 0, failed = 0;
const failures: { file: string; stderr: string }[] = [];

async function convertOne(name: string) {
  const inPath = join(SRC_DIR, name);
  const outPath = join(OUT_DIR, name.replace(/\.mp3$/i, ".wav"));
  if (!force && await Bun.file(outPath).exists()) { skipped++; return; }
  const proc = Bun.spawn(
    ["ffmpeg", "-loglevel", "error", "-y", "-i", inPath, "-ac", "1", "-acodec", "pcm_s16le", outPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    failures.push({ file: name, stderr: stderr.trim().slice(0, 200) });
    failed++;
    return;
  }
  done++;
}

// Simple worker pool: kick off `jobs` workers, each pulls from a shared queue.
let cursor = 0;
const t0 = Date.now();
const tick = setInterval(() => {
  const total = done + skipped + failed;
  process.stdout.write(`\r  ${total}/${mp3s.length} (${done} converted, ${skipped} skipped, ${failed} failed)`);
}, 500);

await Promise.all(Array.from({ length: jobs }, async () => {
  while (true) {
    const i = cursor++;
    if (i >= mp3s.length) return;
    await convertOne(mp3s[i]!);
  }
}));
clearInterval(tick);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write(`\r  ${done + skipped + failed}/${mp3s.length} (${done} converted, ${skipped} skipped, ${failed} failed)  ${dt}s\n`);

if (failures.length) {
  console.warn(`\n${failures.length} ffmpeg failures (first 5):`);
  for (const f of failures.slice(0, 5)) console.warn(`  ${f.file}: ${f.stderr}`);
}
