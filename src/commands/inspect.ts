// ae dump / tree / snap: read-only views of the project
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { cropFilter, makeSheet } from "../media.ts";
import { parseBox } from "./media.ts";
import { readLog, runSnippet } from "../runner.ts";
import { abspath, die, jsstr, out, run } from "../util.ts";

export async function cmdDump(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "dump", ["--depth", "--layer", "--max-keys", "--at"], ["--no-keys", "--raw-text", "--props"]);
  if (!p.pos.length) die('usage: ae dump "Comp Name" [--depth N] [--layer name] [--at F] [--props] [--no-keys] [--max-keys N] [--raw-text]');
  const comp = p.pos[p.pos.length - 1];
  const layer = str(p, "--layer");
  const raw = !!p.opts["--raw-text"];
  const code =
    `log(AE.dump(AE.comp(${jsstr(comp)}), {depth: ${int(p, "--depth", 0)}, keys: ${!p.opts["--no-keys"]}, ` +
    `maxKeys: ${int(p, "--max-keys", 30)}, filter: ${layer ? jsstr(layer) : "null"}, rawText: ${raw}, ` +
    `at: ${p.opts["--at"] === undefined ? "null" : int(p, "--at", 0)}, props: ${!!p.opts["--props"]}}));\n`;
  // --raw-text toggles text expressions off/on to read the source text: one undo step "ae dump"
  return (await runSnippet("dump", "dump", code, { undo: raw, label: "ae dump" })).code;
}

export async function cmdTree(argv: string[]): Promise<number> {
  const main = argv[0] === "--main" && argv[1] !== undefined ? jsstr(argv[1]) : "null";
  return (await runSnippet("tree", "tree", `log(AE.tree(${main}));\n`, { undo: false, label: "ae tree" })).code;
}

/** "8,44,90" / "10-100:10" / "0-20" -> [8, 44, 90] */
export function parseFrames(spec: string): number[] {
  const res: number[] = [];
  const bad = () => die(`bad frame list '${spec}' (use 8,44,90 or 10-100:10)`);
  for (const part of spec.split(",")) {
    const range = /^(\d+)-(\d+)(?::(\d+))?$/.exec(part);
    if (range) {
      const step = range[3] === undefined ? 1 : +range[3];
      if (step <= 0) die(`bad step in '${part}'`);
      for (let f = +range[1]; f <= +range[2]; f += step) res.push(f);
    } else if (/^\d+(\.\d+)?$/.test(part)) {
      res.push(+part);
    } else {
      bad();
    }
  }
  if (!res.length) bad();
  return res;
}

export interface Cell {
  label: string;
  file: string;
}

export const RES = ["full", "half", "third", "quarter"];

/**
 * Render comp frames to <dir>/<prefix>_fNNNN.png, wait for them and crop them to `crop` (comp pixels) if given.
 * Returns the exit code and the files.
 */
export async function snapFrames(comp: string, frames: number[], dir: string, prefix: string, res: string, crop: number[] | null, snapTimeout?: number): Promise<{ code: number; cells: Cell[] }> {
  mkdirSync(dir, { recursive: true });
  const code = `var c = AE.comp(${jsstr(comp)});\nlog("SIZE " + c.width);\nAE.snap(c, [${frames.join(",")}], ${jsstr(dir)}, ${jsstr(prefix)}, ${jsstr(res)});\n`;
  const r = await runSnippet("snap", "snap", code, { undo: false, label: "ae snap", quiet: true, snapTimeout });
  const cells: Cell[] = [];
  if (r.code) return { code: r.code, cells };
  const log = readLog(r.log).split("\n");
  const compW = Number(log.find((l) => l.startsWith("SIZE "))?.slice(5));
  for (const line of log) {
    if (!line.startsWith("PNG ")) continue;
    const file = line.slice(4);
    if (crop) cropPng(file, crop, compW);
    const m = /_f(\d+)\.png$/.exec(file);
    cells.push({ label: "f" + (m ? parseInt(m[1], 10) : "?"), file });
  }
  return { code: 0, cells };
}

export async function cmdSnap(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "snap", ["--out", "--prefix", "--res", "--cols", "--width", "--timeout", "--crop"], ["--sheet"]);
  const [comp, spec] = p.pos;
  if (!comp || !spec) die('usage: ae snap "Comp" 8,44,90 [--out dir] [--prefix p] [--res full|half|third|quarter] [--crop x,y,w,h] [--sheet] [--cols N] [--width px]');
  const crop = str(p, "--crop") ? parseBox(str(p, "--crop"), "--crop") : null;
  const res = str(p, "--res", "half");
  if (!RES.includes(res)) die("--res must be full|half|third|quarter");
  const frames = parseFrames(spec);
  const prefix = str(p, "--prefix") || comp.replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = abspath(str(p, "--out") || path.join(WORK, "snap", prefix));
  const r = await snapFrames(comp, frames, dir, prefix, res, crop, p.opts["--timeout"] ? Number(p.opts["--timeout"]) : undefined);
  if (r.code) return r.code;
  for (const c of r.cells) out(c.file);
  if (p.opts["--sheet"] && r.cells.length) {
    const sheet = path.join(dir, prefix + "_sheet.png");
    makeSheet(sheet, int(p, "--cols", 4), int(p, "--width", 640), r.cells);
    out("SHEET " + sheet);
  }
  return 0;
}

/** Crop a snapped PNG in place to a region given in comp pixels (the PNG may be at half/third/quarter size). */
function cropPng(file: string, region: number[], compW: number): void {
  const b = readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20); // IHDR
  const tmp = file.replace(/\.png$/, ".crop.png");
  const r = run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", cropFilter(region, compW > 0 ? w / compW : 1, w, h), "-frames:v", "1", "-update", "1", tmp], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) die(`ffmpeg could not crop ${file}`);
  renameSync(tmp, file);
}
