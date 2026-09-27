// ae export: render a comp in AE (or hand it to Media Encoder) and encode it for a destination preset.
//   AE renders a master (ProRes 422 HQ / Lossless, with alpha for alpha presets) into the work dir, then ffmpeg
//   encodes that master into the preset. With --ame, Media Encoder encodes with AE's H.264 template instead.
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { hasAudio, probeVideo, rate } from "../media.ts";
import { aspectMismatch, ffmpegArgs, findPreset, listPresets, presetNames, type Fit, type Preset } from "../presets.ts";
import { readLog, runSnippet } from "../runner.ts";
import { abspath, die, err, exists, isFile, jsstr, need, out, run, sleep } from "../util.ts";

const USAGE =
  'usage: ae export "Comp" [--preset youtube-1080] [--out file] [--full | --from F --to F] [--fit pad|crop] [--force] ' +
  "[--keep-intermediate] [--timeout s] [--ame [--wait]]   (presets: ae export --list)";
const RENDER_TIMEOUT = 3600; // render() blocks AE until the file is written; the log only appears afterwards

export async function cmdExport(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "export", ["--preset", "--out", "--from", "--to", "--fit", "--timeout"], ["--full", "--force", "--keep-intermediate", "--ame", "--wait", "--list"]);
  if (p.opts["--list"]) {
    out(listPresets());
    return 0;
  }
  if (p.pos.length !== 1) die(USAGE);
  const comp = p.pos[0];
  const presetName = str(p, "--preset", "youtube-1080");
  const preset = findPreset(presetName) ?? die(`unknown preset '${presetName}'; one of: ${presetNames().join(", ")}`);
  const fit = str(p, "--fit", "pad");
  if (fit !== "pad" && fit !== "crop") die("--fit must be pad or crop");
  const from = frameOpt(p.opts["--from"], "--from");
  const to = frameOpt(p.opts["--to"], "--to");
  if (p.opts["--full"] && (from !== undefined || to !== undefined)) die("--full and --from/--to exclude each other");
  if (p.opts["--wait"] && !p.opts["--ame"]) die("--wait only goes with --ame");
  const timeout = p.opts["--timeout"] ? Number(p.opts["--timeout"]) : RENDER_TIMEOUT;
  if (!(timeout > 0)) die("--timeout must be a number of seconds");

  const safe = comp.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  const ext = p.opts["--ame"] ? "mp4" : preset.ext;
  const target = abspath(str(p, "--out") || `${safe}_${preset.name}.${ext}`);
  if (exists(target) && !p.opts["--force"]) die(`${target} exists; add --force to overwrite it`);
  const span = { full: !!p.opts["--full"], from, to };

  if (p.opts["--ame"]) return exportWithAme(comp, preset, target, span, timeout, !!p.opts["--wait"]);

  need("ffmpeg");
  need("ffprobe");
  const master = path.join(WORK, "export", `${safe}_${preset.name}_master.mov`);
  err(`ae: rendering '${comp}' in After Effects (AE is busy until the render finishes)...`);
  const rendered = await renderInAe(comp, master, { kind: preset.alpha ? "alpha" : "master", ...span }, timeout);
  if (typeof rendered === "number") return rendered;

  err(`ae: encoding ${preset.name}...`);
  const code = encode(preset, rendered, target, fit as Fit, true);
  if (p.opts["--keep-intermediate"]) err(`ae: master kept: ${rendered}`);
  else rmSync(rendered, { force: true });
  if (code) return code;
  out("EXPORT " + target);
  out(describe(target));
  return 0;
}

function frameOpt(v: string | true | undefined, name: string): number | undefined {
  if (typeof v !== "string") return undefined;
  if (!/^\d+$/.test(v)) die(`${name} must be a comp frame number, got '${v}'`);
  return parseInt(v, 10);
}

interface RenderOpts {
  kind: "master" | "alpha" | "h264";
  full: boolean;
  from?: number;
  to?: number;
  ame?: boolean;
}

/** ES3 object literal for AE.render's options. */
function renderOptsJs(o: RenderOpts): string {
  const parts = [`kind: ${jsstr(o.kind)}`];
  if (o.full) parts.push("full: true");
  if (o.from !== undefined) parts.push(`from: ${o.from}`);
  if (o.to !== undefined) parts.push(`to: ${o.to}`);
  if (o.ame) parts.push("ame: true");
  return "{" + parts.join(", ") + "}";
}

/** Run AE.render; returns the written file (RENDERED/AME line of the log) or an exit code. */
async function renderInAe(comp: string, file: string, o: RenderOpts, timeout: number): Promise<string | number> {
  const code = `AE.render(AE.comp(${jsstr(comp)}), ${jsstr(file)}, ${renderOptsJs(o)});\n`;
  // one undo step: adding and removing the render queue item leaves the project as it was
  const r = await runSnippet("export", "render", code, { undo: true, label: "ae export", quiet: true, timeout });
  if (r.code) return r.code;
  const log = readLog(r.log).split("\n");
  const template = log.find((l) => l.startsWith("TEMPLATE "));
  if (template) err(`ae: AE output module: ${template.slice(9)}`);
  const done = log.find((l) => l.startsWith(o.ame ? "AME " : "RENDERED "));
  const written = done ? done.slice(done.indexOf(" ") + 1) : "";
  if (!written || (!o.ame && !isFile(written))) {
    err(`ae: AE did not report a rendered file (log: ${r.log})`);
    return 1;
  }
  return written;
}

/** ffmpeg: master -> preset file. Returns 0, or 1 when ffmpeg fails. */
export function encode(preset: Preset, input: string, output: string, fit: Fit, stats = false): number {
  const v = probeVideo(input);
  const inW = Number(v.width);
  const inH = Number(v.height);
  if (!(inW > 0 && inH > 0)) {
    err(`ae: cannot read the rendered master ${input}`);
    return 1;
  }
  if (aspectMismatch(preset, inW, inH)) {
    err(`ae: ${inW}x${inH} does not match ${preset.name} (${preset.width}x${preset.height}): ` + (fit === "crop" ? "cropped to fill the frame" : "letterboxed; add --fit crop to fill the frame instead"));
  }
  const r = run("ffmpeg", ffmpegArgs(preset, input, output, { inW, inH, fit, hasAudio: hasAudio(input), stats }), { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    err(`ae: ffmpeg failed encoding ${output}`);
    return 1;
  }
  return 0;
}

/** One line for the agent to check the result: size, fps, length, codec, alpha, audio. */
export function describe(file: string): string {
  const v = probeVideo(file);
  const fps = rate(v.avgFrameRate);
  const alpha = /^(yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(v.pixFmt) || v.pixFmt === "pal8";
  const dur = Number(v.duration);
  return (
    `${v.width}x${v.height} ${isNaN(fps) ? "?" : +fps.toFixed(3)}fps ${isNaN(dur) ? "?" : dur.toFixed(2)}s ${v.codec} ${v.pixFmt}` +
    `${alpha ? " (alpha)" : ""} audio=${hasAudio(file) ? "yes" : "no"} size=${(statSync(file).size / 1048576).toFixed(1)}MB`
  );
}

function ameInstalled(): boolean {
  try {
    return readdirSync("/Applications").some((d) => d.startsWith("Adobe Media Encoder"));
  } catch {
    return false;
  }
}

async function exportWithAme(comp: string, preset: Preset, target: string, span: { full: boolean; from?: number; to?: number }, timeout: number, wait: boolean): Promise<number> {
  if (!ameInstalled()) die("Adobe Media Encoder not found in /Applications; export without --ame");
  if (preset.name !== "youtube-1080") {
    err(`ae: --ame encodes with AE's H.264 template at the comp size; the '${preset.name}' preset's size and codec are not applied`);
  }
  const written = await renderInAe(comp, target, { kind: "h264", ame: true, ...span }, 120);
  if (typeof written === "number") return written;
  out("AME " + written);
  if (!wait) {
    err("ae: Media Encoder is encoding in the background; add --wait to wait for the file");
    return 0;
  }
  err("ae: waiting for Media Encoder...");
  const start = Date.now();
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() - start < timeout * 1000) {
    await sleep(1000);
    if (!isFile(written)) continue;
    const size = statSync(written).size;
    if (size > 0 && size === lastSize) {
      if (!stableSince) stableSince = Date.now();
      // done when the size stopped changing and the file is readable (an MP4 is only readable once finished)
      if (Date.now() - stableSince >= 5000 && Number(probeVideo(written).duration) > 0) {
        out("EXPORT " + written);
        out(describe(written));
        return 0;
      }
    } else {
      stableSince = 0;
    }
    lastSize = size;
  }
  err(`ae: timeout: Media Encoder did not finish ${written} within ${timeout}s`);
  return 3;
}
