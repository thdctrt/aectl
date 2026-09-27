// ae sheet / frames / probe: image and video helpers that do not need AE
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { measureInk, makeSheet, probeVideo, rate, readRgba, type Ink } from "../media.ts";
import { abspath, basenameNoExt, die, isFile, need, out, run } from "../util.ts";

export async function cmdSheet(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "sheet", ["--cols", "--width"]);
  const [outFile, ...images] = p.pos;
  if (!outFile || !images.length) die("usage: ae sheet out.png a.png b.png ... [--cols N] [--width px]");
  const target = abspath(outFile);
  makeSheet(target, int(p, "--cols", 4), int(p, "--width", 640), images.map((f) => ({ label: basenameNoExt(f), file: f })));
  out(target);
  return 0;
}

export async function cmdProbe(argv: string[]): Promise<number> {
  need("ffprobe");
  const p = parseArgs(argv, "probe", ["--fps"]);
  const vid = p.pos[p.pos.length - 1];
  if (!vid || !isFile(vid)) die("usage: ae probe video.mp4 [--fps N]");
  const v = probeVideo(vid);
  const rot = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "default=nw=1:nk=1", vid]).stdout.split("\n")[0].trim();
  const aud = run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", vid]).stdout.split("\n")[0].trim();
  const fmt = (n: number) => (isNaN(n) ? "?" : n.toFixed(3));
  out(`file=${vid}`);
  out(`width=${v.width} height=${v.height}${rot ? " rotation=" + rot : ""}`);
  out(`fps=${fmt(rate(v.avgFrameRate))} (avg_frame_rate=${v.avgFrameRate} r_frame_rate=${v.rFrameRate} = ${fmt(rate(v.rFrameRate))})${v.avgFrameRate !== v.rFrameRate ? "  VFR?" : ""}`);
  out(`duration=${v.duration}s frames=${v.nbFrames || "?"} codec=${v.codec} audio=${aud || "none"}`);
  const fps = str(p, "--fps");
  const dur = Number(v.duration);
  if (fps && dur > 0) out(`at ${fps}fps: ${(dur * Number(fps)).toFixed(1)} comp frames`);
  return 0;
}

export async function cmdFrames(argv: string[]): Promise<number> {
  need("ffmpeg");
  need("ffprobe");
  const p = parseArgs(argv, "frames", ["--n", "--cols", "--width", "--from", "--to", "--out"]);
  const vid = p.pos[p.pos.length - 1];
  if (!vid || !isFile(vid)) die("usage: ae frames video.mp4 [--n 12] [--cols 4] [--width 480] [--from s] [--to s] [--out sheet.png]");
  const n = int(p, "--n", 12);
  const width = int(p, "--width", 480);
  const v = probeVideo(vid);
  const from = Number(str(p, "--from", "0"));
  const to = Number(str(p, "--to", v.duration));
  const fps = rate(v.avgFrameRate);
  const base = basenameNoExt(vid).replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = path.join(WORK, "frames", base);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^cell_.*\.png$/.test(f)) rmSync(path.join(dir, f), { force: true });
  const sheet = abspath(str(p, "--out") || path.join(WORK, "frames", base + "_sheet.png"));
  const cells: { label: string; file: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (from + ((to - from) * (i + 0.5)) / n).toFixed(3);
    const sf = isNaN(fps) ? "?" : String(Math.floor(Number(t) * fps + 0.5));
    const png = path.join(dir, `cell_${String(i).padStart(3, "0")}.png`);
    const r = run("ffmpeg", ["-v", "error", "-y", "-ss", t, "-i", vid, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-update", "1", png], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) die(`ffmpeg failed at t=${t}`);
    out(`${String(i).padStart(2)}  t=${t}s  srcframe=${sf}`);
    cells.push({ label: `${i}  ${t}s  f${sf}`, file: png });
  }
  makeSheet(sheet, int(p, "--cols", 4), width, cells);
  out("SHEET " + sheet);
  return 0;
}

/** "x,y,w,h" -> four numbers, or die. */
export function parseBox(spec: string, name: string): number[] {
  const v = spec.split(",").map(Number);
  if (v.length !== 4 || v.some((n) => isNaN(n)) || v[2] <= 0 || v[3] <= 0) die(`${name} must be x,y,w,h (w and h > 0), got '${spec}'`);
  return v;
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const hexOf = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0").toUpperCase()).join("");
const inkLine = (label: string, k: Ink) =>
  `${label}: ink ${k.x0},${k.y0}..${k.x1},${k.y1}  ${k.x1 - k.x0 + 1}x${k.y1 - k.y0 + 1}  centre ${f1((k.x0 + k.x1 + 1) / 2)},${f1((k.y0 + k.y1 + 1) / 2)}  mean ${hexOf(k.mean)}  (bg ${k.bg})`;

export async function cmdMeasure(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "measure", ["--box", "--bg", "--threshold"]);
  const [a, b] = p.pos;
  if (!a || p.pos.length > 2) die("usage: ae measure a.png [b.png] [--box x,y,w,h] [--bg #RRGGBB] [--threshold 24]");
  const bgs = str(p, "--bg");
  let bg: [number, number, number] | undefined;
  if (bgs) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bgs);
    if (!m) die("--bg must be #RRGGBB");
    bg = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }
  const box = str(p, "--box") ? parseBox(str(p, "--box"), "--box") : undefined;
  const threshold = int(p, "--threshold", 24);
  for (const f of p.pos) if (!isFile(f)) die("no such file: " + f);
  const ia = readRgba(a);
  const ka = measureInk(ia, { bg, threshold, box });
  out(ka ? inkLine(a, ka) : `${a}: no ink`);
  if (!b) return 0;
  const ib = readRgba(b);
  const s = ia.w / ib.w; // b is compared in a's pixels (e.g. a full-size design render against a half-res snap)
  const kb = measureInk(ib, { bg, threshold, box: box?.map((v) => v / s) });
  out(kb ? inkLine(b, kb) : `${b}: no ink`);
  if (!ka || !kb) return 0;
  const c = (k: Ink, f: number) => [((k.x0 + k.x1 + 1) / 2) * f, ((k.y0 + k.y1 + 1) / 2) * f, (k.x1 - k.x0 + 1) * f, (k.y1 - k.y0 + 1) * f];
  const [ax, ay, aw, ah] = c(ka, 1);
  const [bx, by, bw, bh] = c(kb, s);
  const sg = (n: number) => (n >= 0 ? "+" : "") + f1(n);
  out(`delta b-a${s !== 1 ? ` (b scaled x${f1(s)} to a's pixels)` : ""}: centre ${sg(bx - ax)},${sg(by - ay)}  size ${sg(bw - aw)}x${sg(bh - ah)}`);
  return 0;
}
