// ffmpeg/ffprobe helpers: contact sheets, clip info, frame sampling.
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
  duration: string;
}

export function probeVideo(file: string): VideoInfo {
  const r = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,codec_name:format=duration", "-of", "default=nw=1", file]);
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
    duration: v.duration ?? "",
  };
}

/** "30000/1001" -> 29.97; NaN when unknown. */
export function rate(r: string): number {
  const [a, b] = r.split("/").map(Number);
  return b > 0 ? a / b : NaN;
}
