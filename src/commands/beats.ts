// ae beats: musical accents (onsets) of an audio layer, in the frames of the comp it sits in.
import { int, parseArgs, str } from "../args.ts";
import { decodeMono, loudness, onsets, SR } from "../audio.ts";
import { readLog, runSnippet } from "../runner.ts";
import { die, err, isFile, jsstr, out, run } from "../util.ts";

const USAGE = 'usage: ae beats "Comp" --layer "Music" [--from F] [--to F] [--top N] [--min-gap F] [--threshold 0.15] [--env] [--mark [--label 0-16]]\n' +
  "       ae beats file.wav [--fps 25] [--offset F] [...]   (no AE: the file starts at comp frame --offset)";

/** Where the audio sits in the comp: comp frame = (start + sourceSeconds * stretch) * fps, audible from inF to outF. */
export interface Placement {
  file: string;
  fps: number;
  start: number; // seconds
  stretch: number; // 1 = 100%
  inF: number;
  outF: number;
}

/** Comp frames of the onsets (and optional loudness per comp frame) in [from, to). */
export function analyse(pl: Placement, o: { from?: number; to?: number; minGap?: number; threshold?: number; env?: boolean }) {
  const from = Math.max(o.from ?? pl.inF, pl.inF);
  const to = Math.min(o.to ?? pl.outF, pl.outF);
  if (!(to > from)) die(`beats: nothing to analyse between frames ${from} and ${to} (the audio spans ${pl.inF}..${pl.outF})`);
  const srcFrom = Math.max(0, (from / pl.fps - pl.start) / pl.stretch);
  const srcDur = (to - from) / pl.fps / pl.stretch;
  // half a second of real audio before the range, so its first sample is not taken for an attack
  const pre = Math.min(srcFrom, 0.5);
  const x = decodeMono(pl.file, srcFrom - pre, srcDur + pre);
  const toFrame = (t: number) => (pl.start + (srcFrom + t) * pl.stretch) * pl.fps;
  const hits = onsets(x, { minGap: (o.minGap ?? 3) / pl.fps / pl.stretch, threshold: o.threshold })
    .map((h) => ({ frame: Math.round(toFrame(h.t - pre)), strength: h.strength }))
    .filter((h) => h.frame >= from && h.frame < to);
  const max = Math.max(0, ...hits.map((h) => h.strength));
  for (const h of hits) h.strength = max > 0 ? h.strength / max : 0; // 1 = strongest in the range
  const body = x.subarray(Math.round(pre * SR));
  const env = o.env ? loudness(body, 1 / pl.fps / pl.stretch).map((db, i) => ({ frame: Math.round(toFrame(i / pl.fps / pl.stretch)), db })) : [];
  return { from, to, hits, env };
}

export async function cmdBeats(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "beats", ["--layer", "--from", "--to", "--fps", "--offset", "--top", "--min-gap", "--threshold", "--label"], ["--env", "--mark"]);
  const target = p.pos[0];
  if (!target || p.pos.length > 1) die(USAGE);
  const threshold = str(p, "--threshold") ? Number(str(p, "--threshold")) : undefined;
  if (threshold !== undefined && !(threshold > 0 && threshold < 1)) die("--threshold must be between 0 and 1");
  const opt = (name: string) => (p.opts[name] === undefined ? undefined : int(p, name, 0));
  if (p.opts["--mark"] && !p.opts["--layer"]) die('beats: --mark puts markers on the audio layer: ae beats "Comp" --layer "Music" --mark');
  if (p.opts["--label"] !== undefined && !p.opts["--mark"]) die("beats: --label goes with --mark");
  let pl: Placement;
  let where: string;
  if (!p.opts["--layer"]) {
    if (!isFile(target)) die(`beats: no such file '${target}' (for a layer in AE: ae beats "Comp" --layer "Music")`);
    const fps = str(p, "--fps") ? Number(str(p, "--fps")) : 25;
    if (!(fps > 0)) die("--fps must be a number > 0");
    const offset = int(p, "--offset", 0);
    const dur = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]).stdout.trim());
    if (!(dur > 0)) die(`beats: cannot read the length of ${target}`);
    pl = { file: target, fps, start: offset / fps, stretch: 1, inF: offset, outF: Math.round(offset + dur * fps) };
    where = `frames at ${fps} fps, the file starting at frame ${offset}`;
  } else {
    if (p.opts["--fps"] !== undefined || p.opts["--offset"] !== undefined) die("beats: --fps/--offset are for a file; a layer's come from AE");
    const code =
      `var c = AE.comp(${jsstr(target)}), L = AE.layer(c, ${jsstr(str(p, "--layer"))}), s = L.source;\n` +
      `if (!s || !s.file) { throw new Error("layer '" + L.name + "' is not footage from a file"); }\n` +
      `if (!L.hasAudio) { throw new Error("layer '" + L.name + "' has no audio"); }\n` +
      `log("FILE " + s.file.fsName);\n` +
      `log("PLACE " + [c.frameRate, L.startTime, L.stretch, L.inPoint, L.outPoint, L.timeRemapEnabled ? 1 : 0, L.audioEnabled ? 1 : 0].join(" "));\n`;
    const r = await runSnippet("beats", "beats", code, { undo: false, label: "ae beats", quiet: true });
    if (r.code) return r.code;
    const log = readLog(r.log).split("\n");
    const file = log.find((l) => l.startsWith("FILE "))?.slice(5) ?? "";
    const [fps, start, stretch, inP, outP, remap, on] = (log.find((l) => l.startsWith("PLACE "))?.slice(6) ?? "").split(" ").map(Number);
    if (!file || !(fps > 0)) die("beats: could not read the layer from AE");
    if (!isFile(file)) die(`beats: the layer's file is missing on disk: ${file}`);
    if (remap) err("ae: note: the layer has time remapping; frames assume it plays straight");
    if (!on) err("ae: note: the layer's audio is switched off in the comp");
    if (stretch < 0) die("beats: the layer is time-reversed (negative stretch)");
    pl = { file, fps, start, stretch: stretch / 100, inF: Math.round(inP * fps), outF: Math.round(outP * fps) };
    where = `frames of '${target}' (layer starts at ${Math.round(start * fps)}${stretch !== 100 ? `, stretch ${stretch}%` : ""})`;
  }
  const res = analyse(pl, { from: opt("--from"), to: opt("--to"), minGap: opt("--min-gap"), threshold, env: !!p.opts["--env"] });
  let hits = res.hits;
  const top = opt("--top");
  if (top !== undefined) hits = [...hits].sort((a, b) => b.strength - a.strength).slice(0, top).sort((a, b) => a.frame - b.frame);
  err(`ae: ${hits.length} onsets, ${where}, ${res.from}..${res.to}; strength 0..1 (1 = strongest here)`);
  for (const h of hits) out(`${String(h.frame).padStart(6)}  ${h.strength.toFixed(2)}  ${"#".repeat(Math.max(1, Math.round(h.strength * 20)))}`);
  if (p.opts["--env"]) {
    const max = Math.max(...res.env.map((e) => e.db));
    out("frame  dBFS  loudness");
    for (const e of res.env) out(`${String(e.frame).padStart(6)}  ${e.db.toFixed(1).padStart(5)}  ${"=".repeat(Math.max(0, Math.round((e.db - max + 40) / 2)))}`);
  }
  if (p.opts["--mark"] && hits.length) return markBeats(target, str(p, "--layer"), hits, opt("--label"));
  return 0;
}

/** Layer markers "beat 0.83" at the onset frames (one undo step "ae beats"; they move with the layer). */
async function markBeats(comp: string, layer: string, hits: { frame: number; strength: number }[], label: number | undefined): Promise<number> {
  const code =
    `var __L = AE.layer(AE.comp(${jsstr(comp)}), ${jsstr(layer)});\n` +
    `var __f = [${hits.map((h) => h.frame).join(",")}], __s = [${hits.map((h) => h.strength.toFixed(2)).join(",")}];\n` +
    `for (var __i = 0; __i < __f.length; __i++) { AE.marker(__L, __f[__i], "beat " + __s[__i]${label === undefined ? "" : `, {label: ${label}}`}); }\n` +
    `log(__f.length + " beat marker(s) on '" + __L.name + "'");\n`;
  const r = await runSnippet("beats", "mark", code, { undo: true, label: "ae beats", rollback: true, quiet: true });
  if (!r.code) err(readLog(r.log).split("\n").find((l) => l.includes("beat marker")) ?? "");
  return r.code;
}
