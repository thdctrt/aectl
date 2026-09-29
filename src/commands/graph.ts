// ae graph: value and speed curves of an animated property, as a PNG and as numbers per key segment
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { fmt, renderChart, type RGB, type Series } from "../plot.ts";
import { readLog, runSnippet } from "../runner.ts";
import { abspath, die, err, jsstr, out } from "../util.ts";

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

export interface GraphData {
  title: string;
  fps: number;
  spatial: boolean;
  color: boolean;
  from: number;
  to: number;
  step: number;
  keys: { frame: number; text: string }[];
  samples: { frame: number; v: number[] }[];
}

/** Parse the lines AE.graphData logs. */
export function parseGraph(log: string): GraphData {
  const g: GraphData = { title: "", fps: 25, spatial: false, color: false, from: 0, to: 0, step: 1, keys: [], samples: [] };
  for (const line of log.split("\n")) {
    if (line.startsWith("PROP ")) {
      const m = /^PROP (.*) fps=([\d.]+) spatial=(\d) color=(\d)$/.exec(line);
      if (m) {
        g.title = m[1];
        g.fps = Number(m[2]);
        g.spatial = m[3] === "1";
        g.color = m[4] === "1";
      }
    } else if (line.startsWith("RANGE ")) {
      [g.from, g.to, g.step] = line.slice(6).split(" ").map(Number);
    } else if (line.startsWith("KEY ")) {
      g.keys.push({ frame: parseFloat(line.slice(4)), text: line.slice(4) });
    } else if (line.startsWith("S ")) {
      const [f, v] = line.slice(2).split(" ");
      g.samples.push({ frame: Number(f), v: v.split(",").map(Number) });
    }
  }
  return g;
}

const DIM_COLORS: RGB[] = [
  [236, 92, 92],
  [98, 206, 104],
  [96, 150, 245],
  [230, 200, 80],
];

/** Speed between consecutive samples (units per second), per dimension, or one magnitude for spatial props. */
export function speeds(g: GraphData): { frame: number; v: number[] }[] {
  const res: { frame: number; v: number[] }[] = [];
  for (let i = 1; i < g.samples.length; i++) {
    const a = g.samples[i - 1];
    const b = g.samples[i];
    const dt = (b.frame - a.frame) / g.fps;
    const d = b.v.map((x, k) => (x - a.v[k]) / dt);
    res.push({ frame: (a.frame + b.frame) / 2, v: g.spatial ? [Math.hypot(...d)] : d.map(Math.abs) });
  }
  return res;
}

/** Per key segment: total change, average and peak speed (magnitude over all dimensions) and where the peak is. */
export function segments(g: GraphData): string[] {
  const res: string[] = [];
  const sp = speeds(g);
  for (let k = 1; k < g.keys.length; k++) {
    const f0 = g.keys[k - 1].frame;
    const f1 = g.keys[k].frame;
    const inSeg = sp.filter((s) => s.frame > f0 && s.frame < f1);
    const s0 = g.samples.find((s) => Math.abs(s.frame - f0) < 1e-6);
    const s1 = g.samples.find((s) => Math.abs(s.frame - f1) < 1e-6);
    if (!inSeg.length || !s0 || !s1) continue;
    const mag = inSeg.map((s) => Math.hypot(...s.v));
    const change = s1.v.map((x, i) => x - s0.v[i]);
    const avg = mag.reduce((a, m) => a + m, 0) / mag.length; // samples are evenly spaced
    let pi = 0;
    for (let i = 1; i < mag.length; i++) if (mag[i] > mag[pi]) pi = i;
    const peak = mag[pi];
    const at = Math.round(((inSeg[pi].frame - f0) / (f1 - f0)) * 100);
    const ch = change.length === 1 ? fmt(change[0]) : "[" + change.map(fmt).join(",") + "]";
    if (peak < 1e-9) res.push(`f${fmt(f0)}->f${fmt(f1)}  no change (hold or equal values)`);
    else if (peak / (avg || 1) < 1.05) res.push(`f${fmt(f0)}->f${fmt(f1)}  change ${ch}  constant speed ${fmt(avg)}/s (linear)`);
    else res.push(`f${fmt(f0)}->f${fmt(f1)}  change ${ch}  avg ${fmt(avg)}/s  peak ${fmt(peak)}/s at f${fmt(inSeg[pi].frame)} (${at}% in)  peak/avg ${(peak / (avg || 1)).toFixed(2)}`);
  }
  return res;
}

export async function cmdGraph(argv: string[]): Promise<number> {
  const usage = 'usage: ae graph "Comp" "Layer" "Transform/Position" [--from f] [--to f] [--step f] [--out file.png] [--width px] [--height px]';
  const p = parseArgs(argv, "graph", ["--from", "--to", "--step", "--out", "--width", "--height"]);
  const [comp, layer, prop] = p.pos;
  if (!comp || !layer || !prop || p.pos.length > 3) die(usage);
  const opt = (name: string) => {
    if (p.opts[name] === undefined) return "null";
    const v = Number(str(p, name));
    if (str(p, name) === "" || !isFinite(v)) die(`${name} must be a number, got '${str(p, name)}'`);
    return String(v);
  };
  const code =
    `var __c = AE.comp(${jsstr(comp)});\n` +
    `var __p = AE.prop(AE.layer(__c, ${/^\d+$/.test(layer) ? Number(layer) : jsstr(layer)}), ${jsstr(prop)});\n` +
    `log(AE.graphData(__p, ${opt("--from")}, ${opt("--to")}, ${opt("--step")}));\n`;
  const r = await runSnippet("graph", "graph", code, { undo: false, label: "ae graph", quiet: true });
  if (r.code) return r.code;
  const g = parseGraph(readLog(r.log));
  if (g.samples.length < 2) die("graph: not enough samples");
  const dims = g.samples[0].v.length;
  const names = g.color ? ["r", "g", "b", "a"] : dims === 1 ? ["value"] : ["x", "y", "z"];
  const valueSeries: Series[] = [];
  for (let d = 0; d < dims; d++) valueSeries.push({ name: names[d] ?? "d" + d, color: DIM_COLORS[d % 4], points: g.samples.map((s) => [s.frame, s.v[d]]) });
  const sp = speeds(g);
  const speedSeries: Series[] = [];
  for (let d = 0; d < sp[0].v.length; d++) {
    speedSeries.push({ name: g.spatial ? "speed" : (names[d] ?? "d" + d), color: g.spatial ? [240, 240, 240] : DIM_COLORS[d % 4], points: sp.map((s) => [s.frame, s.v[d]]) });
  }
  const file = abspath(str(p, "--out") || path.join(WORK, "graph", `${safeName(comp)}_${safeName(layer)}_${safeName(prop)}.png`));
  const labelled = renderChart(file, {
    title: g.title.replace(/'/g, ""),
    width: int(p, "--width", 1000),
    height: int(p, "--height", 560),
    xFrom: g.from,
    xTo: g.to,
    marks: g.keys.map((k) => k.frame),
    panels: [
      { title: "value", series: valueSeries },
      { title: g.spatial ? "speed" : "speed per dimension", unit: "/s", series: speedSeries },
    ],
  });
  out(`${g.title}  f${fmt(g.from)}..f${fmt(g.to)}, a sample every ${fmt(g.step)}f`);
  if (g.keys.length) out("keys  " + g.keys.map((k) => "f" + k.text).join(" | "));
  else out("no keys");
  for (const s of segments(g)) out(s);
  if (!labelled) err("ae: graph written without labels (needs ffmpeg and a system font)");
  out("GRAPH " + file);
  return 0;
}
