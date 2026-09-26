// ae sheet / frames / probe: image and video helpers that do not need AE
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { makeSheet, probeVideo, rate } from "../media.ts";
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
