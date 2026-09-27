// ffmpeg/ffprobe helpers: contact sheets, clip info, frame sampling.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { labelFont } from "./env.ts";
import { die, need, run } from "./util.ts";

const safeLabel = (s: string) => s.replace(/[^A-Za-z0-9 ._#=+-]/g, "_");

/** Tile images into one PNG, `cols` wide, each cell `cellWidth` px, labelled when a font is available. */
export function makeSheet(outFile: string, cols: number, cellWidth: number, cells: { label: string; file: string }[]): void {
  need("ffmpeg");
  need("ffprobe");
  if (!cells.length) die("sheet: no images");
  const probe = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", cells[0].file]);
  const m = /^(\d+),(\d+)/.exec(probe.stdout.trim());
  if (probe.status !== 0 || !m) die(`sheet: cannot read ${cells[0].file}`);
  const w = +m[1];
  const h = +m[2];
  const ch = Math.floor((Math.floor((cellWidth * h) / w) + 1) / 2) * 2; // even cell height
  const fs = Math.max(14, Math.floor(ch / 12));
  const font = labelFont();
  const inputs: string[] = [];
  const filters: string[] = [];
  const layout: string[] = [];
  let stack = "";
  cells.forEach((c, i) => {
    inputs.push("-i", c.file);
    const dt = font ? `,drawtext=fontfile='${font}':text='${safeLabel(c.label)}':x=8:y=8:fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5` : "";
    filters.push(`[${i}:v]scale=${cellWidth}:${ch}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${ch}:(ow-iw)/2:(oh-ih)/2:color=black${dt}[v${i}]`);
    layout.push(`${(i % cols) * cellWidth}_${Math.floor(i / cols) * ch}`);
    stack += `[v${i}]`;
  });
  let fc: string;
  if (cells.length === 1) fc = filters[0].replace(/\[v0\]$/, "[out]");
  else fc = filters.join(";") + ";" + `${stack}xstack=inputs=${cells.length}:layout=${layout.join("|")}:fill=black[out]`;
  mkdirSync(path.dirname(outFile), { recursive: true });
  const r = run("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-update", "1", outFile], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) die(`ffmpeg failed building ${outFile}`);
}

export interface VideoInfo {
  width: string;
  height: string;
  rFrameRate: string;
  avgFrameRate: string;
  nbFrames: string;
  codec: string;
  pixFmt: string;
  duration: string;
}

export function probeVideo(file: string): VideoInfo {
  const r = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name,pix_fmt:format=duration", "-of", "default=nw=1", file]);
  const v: Record<string, string> = {};
  for (const l of r.stdout.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0) v[l.slice(0, i)] = l.slice(i + 1);
  }
  return {
    width: v.width ?? "",
    height: v.height ?? "",
    rFrameRate: v.r_frame_rate ?? "",
    avgFrameRate: v.avg_frame_rate ?? "",
    nbFrames: v.nb_frames ?? "",
    codec: v.codec_name ?? "",
    pixFmt: v.pix_fmt ?? "",
    duration: v.duration ?? "",
  };
}

/** "30000/1001" -> 29.97; NaN when unknown. */
export function rate(r: string): number {
  const [a, b] = r.split("/").map(Number);
  return b > 0 ? a / b : NaN;
}

export function hasAudio(file: string): boolean {
  return run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file]).stdout.trim() !== "";
}

/** Decode an image (any format ffmpeg reads) into RGBA bytes. */
export function readRgba(file: string): { w: number; h: number; px: Buffer } {
  need("ffmpeg");
  need("ffprobe");
  const probe = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const m = /^(\d+),(\d+)/.exec(probe.stdout.trim());
  if (probe.status !== 0 || !m) die(`cannot read image ${file}`);
  const w = +m[1];
  const h = +m[2];
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: w * h * 4 + 1024 });
  if (r.status !== 0 || r.stdout.length < w * h * 4) die(`ffmpeg could not decode ${file}`);
  return { w, h, px: r.stdout };
}

export interface Ink {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number;
  count: number;
  mean: [number, number, number];
  bg: string; // what counted as background
}

/**
 * Bounding box of the "ink" in an RGBA image: pixels that are not background. With transparency anywhere, ink is
 * alpha > 8; otherwise background is the colour of the corners (or `bg`) and ink differs from it by more than
 * `threshold` in some channel. `box` limits the search to [x, y, w, h]. Null when there is no ink.
 */
export function measureInk(img: { w: number; h: number; px: Buffer }, o: { bg?: [number, number, number]; threshold?: number; box?: number[] } = {}): Ink | null {
  const { w, h, px } = img;
  const [bx, by, bw, bh] = o.box ?? [0, 0, w, h];
  const X0 = Math.max(0, bx), Y0 = Math.max(0, by), X1 = Math.min(w, bx + bw), Y1 = Math.min(h, by + bh);
  let alpha = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { alpha = true; break; }
  let bg = o.bg;
  if (!alpha && !bg) {
    // the most common of the four corners of the searched region
    const at = (x: number, y: number): [number, number, number] => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const cs = [at(X0, Y0), at(X1 - 1, Y0), at(X0, Y1 - 1), at(X1 - 1, Y1 - 1)];
    const key = (c: number[]) => c.join(",");
    const n = new Map<string, number>();
    for (const c of cs) n.set(key(c), (n.get(key(c)) ?? 0) + 1);
    bg = cs.reduce((a, c) => ((n.get(key(c)) ?? 0) > (n.get(key(a)) ?? 0) ? c : a));
  }
  const t = o.threshold ?? 24;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, count = 0, r = 0, g = 0, b = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const i = (y * w + x) * 4;
      const ink = alpha && !o.bg ? px[i + 3] > 8 : Math.max(Math.abs(px[i] - bg![0]), Math.abs(px[i + 1] - bg![1]), Math.abs(px[i + 2] - bg![2])) > t;
      if (!ink) continue;
      count++;
      r += px[i]; g += px[i + 1]; b += px[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!count) return null;
  const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0").toUpperCase()).join("");
  return { x0, y0, x1, y1, count, mean: [r / count, g / count, b / count], bg: alpha && !o.bg ? "transparent" : hex(bg!) };
}

/** ffmpeg crop filter for a region given in comp pixels, on an image rendered at `scale` (image px per comp px). */
export function cropFilter(region: number[], scale: number, imgW: number, imgH: number): string {
  const [x, y, w, h] = region.map((v) => v * scale);
  const X = Math.max(0, Math.min(imgW - 1, Math.round(x)));
  const Y = Math.max(0, Math.min(imgH - 1, Math.round(y)));
  const W = Math.max(1, Math.min(imgW - X, Math.round(w)));
  const H = Math.max(1, Math.min(imgH - Y, Math.round(h)));
  return `crop=${W}:${H}:${X}:${Y}`;
}
