// A small line-chart renderer for `ae graph`: RGB raster, own PNG encoder (node:zlib), labels via ffmpeg drawtext
// when ffmpeg and a font are available (without them the chart is written unlabelled).
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { labelFont } from "./env.ts";
import { has, run } from "./util.ts";

export type RGB = [number, number, number];

export interface Series {
  name: string;
  color: RGB;
  points: [number, number][]; // [frame, value]
}

export interface Panel {
  title: string;
  unit?: string;
  series: Series[];
}

export interface Chart {
  title: string;
  width: number;
  height: number;
  xFrom: number;
  xTo: number;
  marks: number[]; // key frames: vertical lines + labels
  panels: Panel[];
}

interface Label {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
}

const BG: RGB = [24, 24, 24];
const PANEL: RGB = [34, 34, 34];
const GRID: RGB = [58, 58, 58];
const ZERO: RGB = [95, 95, 95];
const MARK: RGB = [120, 110, 60];

class Raster {
  w: number;
  h: number;
  data: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 3);
  }
  set(x: number, y: number, c: RGB): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) this.set(x, y, c);
  }
  /** Line of thickness `t` (a square brush along a DDA walk). */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, t = 1, dash = 0): void {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const r = Math.floor(t / 2);
    for (let i = 0; i <= n; i++) {
      if (dash && Math.floor(i / dash) % 2 === 1) continue;
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      for (let dy = -r; dy <= t - 1 - r; dy++) for (let dx = -r; dx <= t - 1 - r; dx++) this.set(x + dx, y + dy, c);
    }
  }
}

// ------------------------------------------------------------------------------------------ PNG

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "ascii");
  Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

/** 8-bit RGB PNG. */
export function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

// ------------------------------------------------------------------------------------------ chart

/** Short numbers for axis labels. */
export function fmt(v: number): string {
  if (!isFinite(v)) return "?";
  const a = Math.abs(v);
  if (a >= 1000) return String(Math.round(v));
  if (a >= 10) return String(Math.round(v * 10) / 10);
  if (a >= 0.1 || a === 0) return String(Math.round(v * 100) / 100);
  return v.toPrecision(2);
}

const hex = (c: RGB) => "0x" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

/** Render the chart to `file` (PNG). Returns whether labels were drawn. */
export function renderChart(file: string, ch: Chart): boolean {
  const { width: W, height: H } = ch;
  const r = new Raster(W, H);
  r.rect(0, 0, W, H, BG);
  const labels: Label[] = [];
  const L = 78;
  const R = W - 16;
  const top = 34;
  const bottom = H - 28;
  const gap = 26;
  const ph = (bottom - top - gap * (ch.panels.length - 1)) / ch.panels.length;
  const span = ch.xTo - ch.xFrom || 1;
  const X = (f: number) => L + ((f - ch.xFrom) / span) * (R - L);
  labels.push({ x: 8, y: 8, text: ch.title, color: "white", size: 16 });

  ch.panels.forEach((pn, pi) => {
    const y0 = top + pi * (ph + gap);
    const y1 = y0 + ph;
    r.rect(L, y0, R, y1, PANEL);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of pn.series) for (const [, v] of s.points) if (isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    if (!isFinite(lo)) (lo = 0), (hi = 1);
    if (hi - lo < 1e-9) (lo -= 1), (hi += 1);
    const pad = (hi - lo) * 0.06;
    lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad; // speeds: keep the axis at 0
    hi += pad;
    const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    for (let g = 0; g <= 4; g++) {
      const v = lo + ((hi - lo) * g) / 4;
      r.line(L, Y(v), R, Y(v), GRID);
      labels.push({ x: 6, y: Y(v) - 7, text: fmt(v), color: "0xaaaaaa", size: 12 });
    }
    if (lo < 0 && hi > 0) r.line(L, Y(0), R, Y(0), ZERO);
    for (const m of ch.marks) if (m >= ch.xFrom && m <= ch.xTo) r.line(X(m), y0, X(m), y1, MARK, 1, 4);
    for (const s of pn.series) {
      for (let i = 1; i < s.points.length; i++) {
        const [fa, va] = s.points[i - 1];
        const [fb, vb] = s.points[i];
        if (isFinite(va) && isFinite(vb)) r.line(X(fa), Y(va), X(fb), Y(vb), s.color, 2);
      }
    }
    let lx = L + 8;
    labels.push({ x: lx, y: y0 + 6, text: pn.title + (pn.unit ? " (" + pn.unit + ")" : ""), color: "white", size: 13 });
    lx += (pn.title.length + (pn.unit ? pn.unit.length + 3 : 0)) * 8 + 16;
    for (const s of pn.series) {
      if (pn.series.length < 2) break;
      labels.push({ x: lx, y: y0 + 6, text: s.name, color: hex(s.color), size: 13 });
      lx += s.name.length * 8 + 14;
    }
  });
  for (const m of ch.marks) if (m >= ch.xFrom && m <= ch.xTo) labels.push({ x: X(m) - 12, y: bottom + 8, text: "f" + fmt(m), color: "0xd8c870", size: 12 });
  labels.push({ x: L, y: H - 14, text: "f" + fmt(ch.xFrom), color: "0xaaaaaa", size: 11 });
  labels.push({ x: R - 40, y: H - 14, text: "f" + fmt(ch.xTo), color: "0xaaaaaa", size: 11 });

  mkdirSync(path.dirname(file), { recursive: true });
  const png = encodePng(W, H, r.data);
  const font = labelFont();
  if (!font || !has("ffmpeg")) {
    writeFileSync(file, png);
    return false;
  }
  const plain = file.replace(/\.png$/i, "") + ".plain.png";
  writeFileSync(plain, png);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9 ._#=+/()-]/g, "_");
  const vf = labels.map((l) => `drawtext=fontfile='${font}':text='${safe(l.text)}':x=${Math.round(l.x)}:y=${Math.round(l.y)}:fontsize=${l.size}:fontcolor=${l.color}`).join(",");
  const res = run("ffmpeg", ["-v", "error", "-y", "-i", plain, "-vf", vf, "-frames:v", "1", "-update", "1", file]);
  if (res.status !== 0) {
    renameSync(plain, file);
    return false;
  }
  rmSync(plain, { force: true });
  return true;
}
