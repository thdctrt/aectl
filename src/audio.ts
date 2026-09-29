// Audio analysis for ae beats: decode with ffmpeg, then onset detection (spectral flux) in plain JS.
import { spawnSync } from "node:child_process";
import { die, need } from "./util.ts";

export const SR = 22050;
const N = 1024; // FFT size (46 ms)
const HOP = 256; // 11.6 ms

/** Mono float samples at SR, optionally only `dur` seconds from `from`. */
export function decodeMono(file: string, from = 0, dur?: number): Float32Array {
  need("ffmpeg");
  const args = ["-v", "error"];
  if (from > 0) args.push("-ss", from.toFixed(3));
  args.push("-i", file);
  if (dur !== undefined) args.push("-t", dur.toFixed(3));
  args.push("-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-");
  const r = spawnSync("ffmpeg", args, { maxBuffer: 1 << 30 });
  if (r.status !== 0) die(`ffmpeg could not decode the audio of ${file}: ${r.stderr.toString().trim()}`);
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export interface Onset {
  t: number; // seconds from the start of the samples
  strength: number; // 0..1, relative to the strongest onset found
}

/** The samples with N samples of silence in front, so an attack right at the start has something to rise from. */
function padded(input: Float32Array): Float32Array {
  const x = new Float32Array(input.length + N);
  x.set(input, N);
  return x;
}

/**
 * Novelty per 11.6 ms step: the spectral flux (summed rise of the log spectrum from one step to the next) minus its
 * local average over about half a second. Peaks are onsets; its periodicity is the tempo.
 */
export function novelty(x: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(N / 2), cur = new Float64Array(N / 2);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      re[i] = x[f * HOP + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let s = 0;
    for (let k = 0; k < N / 2; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0 && cur[k] > prev[k]) s += cur[k] - prev[k];
    }
    flux[f] = s;
    [prev, cur] = [cur, prev];
  }
  const w = Math.round((0.25 * SR) / HOP);
  const nov = new Float64Array(frames);
  let acc = 0, lo = 0, hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + w)) acc += flux[++hi];
    while (lo < f - w) acc -= flux[lo++];
    nov[f] = Math.max(0, flux[f] - acc / (hi - lo + 1));
  }
  return nov;
}

/**
 * Onsets (note attacks, hits): peaks of the novelty at least `minGap` seconds apart and above `threshold` x the
 * strongest, each moved to where its attack starts.
 */
export function onsets(input: Float32Array, o: { minGap?: number; threshold?: number } = {}): Onset[] {
  const x = padded(input);
  const nov = novelty(x);
  const frames = nov.length;
  if (frames < 3) return [];
  let max = 0;
  for (const v of nov) max = Math.max(max, v);
  if (max <= 0) return [];
  const gap = Math.max(1, Math.round(((o.minGap ?? 0.1) * SR) / HOP));
  const th = (o.threshold ?? 0.15) * max;
  const out: Onset[] = [];
  for (let f = 1; f < frames; f++) {
    if (nov[f] < th) continue;
    let peak = true;
    for (let g = Math.max(0, f - gap); g <= Math.min(frames - 1, f + gap) && peak; g++) {
      if (nov[g] > nov[f] || (nov[g] === nov[f] && g < f)) peak = false;
    }
    if (peak) out.push({ t: Math.max(0, attack(x, f) - N) / SR, strength: nov[f] / max });
  }
  return out;
}

/** The sample where the attack of spectral-flux frame f starts: the biggest rise in log energy of 64-sample blocks. */
function attack(x: Float32Array, f: number): number {
  const B = 64, start = Math.max(B, f * HOP), end = Math.min(x.length - B, f * HOP + N + HOP);
  const e = (i: number) => {
    let s = 1e-9;
    for (let j = i; j < i + B; j++) s += x[j] * x[j];
    return Math.log(s);
  };
  let best = start, bestRise = -Infinity, prev = e(start - B);
  for (let i = start; i <= end; i += B / 2) {
    const cur = e(i);
    if (cur - prev > bestRise) {
      bestRise = cur - prev;
      best = i;
    }
    prev = e(i - B / 2);
  }
  return best;
}

/** Loudness per chunk of `step` seconds, in dBFS (RMS). */
export function loudness(x: Float32Array, step: number): number[] {
  const n = Math.max(1, Math.round(step * SR));
  const out: number[] = [];
  for (let i = 0; i + n <= x.length || (i === 0 && x.length); i += n) {
    let s = 0;
    const end = Math.min(x.length, i + n);
    for (let j = i; j < end; j++) s += x[j] * x[j];
    out.push(10 * Math.log10(s / Math.max(1, end - i) + 1e-12));
  }
  return out;
}

/**
 * Tempo in BPM (60..200) from the autocorrelation of the novelty, refined between steps; NaN for less than about
 * 2.5 s of audio or no clear pulse. Octave errors (half or double the felt tempo) are possible, as with any
 * autocorrelation; 80..160 BPM is preferred slightly.
 */
export function tempo(input: Float32Array): number {
  // onsets are one-step spikes, and a beat period is rarely a whole number of steps: widen them first (~50 ms)
  const raw = novelty(padded(input));
  const nov = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let s = 0;
    for (let k = -4; k <= 4; k++) s += (raw[i + k] ?? 0) * (5 - Math.abs(k));
    nov[i] = s / 25;
  }
  const step = HOP / SR;
  const minLag = Math.floor(60 / 200 / step);
  const maxLag = Math.ceil(60 / 60 / step);
  if (nov.length < maxLag * 2.2) return NaN;
  let mean = 0;
  for (const v of nov) mean += v;
  mean /= nov.length;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < nov.length; i++) s += (nov[i] - mean) * (nov[i + lag] - mean);
    ac[lag] = s / (nov.length - lag);
  }
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * step);
    const v = ac[lag] * (bpm >= 80 && bpm <= 160 ? 1 : 0.85);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (!bestLag || best <= 0) return NaN;
  // parabola through the neighbouring lags: one step (11.6 ms) is too coarse for a tempo on its own
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  const d = a - 2 * b + c;
  const lag = bestLag + (d < 0 ? (0.5 * (a - c)) / d : 0);
  return Math.round(600 / (lag * step)) / 10;
}
