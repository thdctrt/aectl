// ae sel / markers / mark / health / find / effects: what the user is looking at, and searching the project
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { WORK } from "../env.ts";
import { aeRunning, readLog, runSnippet } from "../runner.ts";
import { die, err, isFile, jsstr, out } from "../util.ts";

/** "Comp" -> AE.comp("Comp"); none -> the active comp */
const compExpr = (name: string | undefined) => `AE.comp(${name ? jsstr(name) : "null"})`;

export async function cmdSel(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "sel", [], [], () => die("usage: ae sel") as never);
  if (p.pos.length) die("usage: ae sel");
  return (await runSnippet("sel", "sel", "log(AE.sel());\n", { undo: false, label: "ae sel" })).code;
}

export async function cmdMarkers(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "markers", [], ["--all"]);
  if (p.pos.length > 1) die('usage: ae markers ["Comp"] [--all]');
  const comps = p.opts["--all"] ? "AE.comps()" : `[${compExpr(p.pos[0])}]`;
  return (await runSnippet("markers", "markers", `log(AE.markerReport(${comps}));\n`, { undo: false, label: "ae markers" })).code;
}

export async function cmdMark(argv: string[]): Promise<number> {
  const usage = 'usage: ae mark "Comp" frame "comment" [--layer name] [--dur frames] [--label 0-16]';
  const p = parseArgs(argv, "mark", ["--layer", "--dur", "--label"]);
  const [comp, frame, comment] = p.pos;
  if (!comp || frame === undefined || p.pos.length > 3) die(usage);
  if (!/^\d+(\.\d+)?$/.test(frame)) die(`frame must be a number, got '${frame}'`);
  const layer = str(p, "--layer");
  const opts = `{duration: ${int(p, "--dur", 0)}${p.opts["--label"] ? ", label: " + int(p, "--label", 0) : ""}}`;
  const code =
    `var __c = ${compExpr(comp)};\n` +
    `var __t = ${layer ? `AE.layer(__c, ${jsstr(layer)})` : "__c"};\n` +
    `AE.marker(__t, ${Number(frame)}, ${jsstr(comment ?? "")}, ${opts});\n` +
    `log("marker at f" + ${Number(frame)} + " on " + (__t === __c ? "comp '" + __c.name + "'" : "#" + __t.index + " '" + __t.name + "'"));\n`;
  return (await runSnippet("markers", "mark", code, { undo: true, label: "ae mark", rollback: true })).code;
}

export async function cmdHealth(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "health", ["--safe"], ["--all"]);
  if (p.pos.length > 1) die('usage: ae health ["Comp"] [--all] [--safe %]');
  const safe = int(p, "--safe", 0);
  if (safe < 0 || safe >= 50) die("--safe is a margin in % of each side (0-49)");
  let comps: string;
  if (p.opts["--all"]) comps = "AE.comps()";
  else if (p.pos[0]) comps = `[${compExpr(p.pos[0])}]`;
  else comps = '(app.project.activeItem instanceof CompItem ? [app.project.activeItem] : (log("(no active comp: project checks only; name a comp or use --all)"), []))';
  return (await runSnippet("health", "health", `log(AE.health(${comps}, {safe: ${safe}}));\n`, { undo: false, label: "ae health" })).code;
}

const SCOPES = ["name", "text", "expr", "file", "effect", "marker"];

export async function cmdFind(argv: string[]): Promise<number> {
  const usage = `usage: ae find "text" [--in ${SCOPES.join(",")}] [--comp "Comp"] [--regex]`;
  const p = parseArgs(argv, "find", ["--in", "--comp"], ["--regex"]);
  if (p.pos.length !== 1 || !p.pos[0]) die(usage);
  const scopes = str(p, "--in", SCOPES.join(","));
  for (const s of scopes.split(",")) if (!SCOPES.includes(s)) die(`--in: unknown scope '${s}' (${SCOPES.join(",")})`);
  if (p.opts["--regex"]) {
    try {
      new RegExp(p.pos[0]);
    } catch (e) {
      die(`bad regex: ${(e as Error).message}`);
    }
  }
  const comp = str(p, "--comp");
  const code = `log(AE.find(${jsstr(p.pos[0])}, {regex: ${!!p.opts["--regex"]}, scopes: ${jsstr(scopes)}, comp: ${comp ? jsstr(comp) : "null"}}));\n`;
  return (await runSnippet("find", "find", code, { undo: false, label: "ae find" })).code;
}

// ------------------------------------------------------------------------------------------ effects

export interface Effect {
  matchName: string;
  displayName: string;
  category: string;
}

const EFFECTS_CACHE = path.join(WORK, "effects.tsv");

/** Effects installed in AE, from the cache (written on first use) or from AE with `refresh`. */
async function loadEffects(refresh: boolean): Promise<Effect[] | number> {
  if (!refresh && isFile(EFFECTS_CACHE)) return parseEffects(readFileSync(EFFECTS_CACHE, "utf8"));
  if (!aeRunning() && isFile(EFFECTS_CACHE)) {
    err("ae: AE is not running; using the cached effect list");
    return parseEffects(readFileSync(EFFECTS_CACHE, "utf8"));
  }
  const code = 'var __e = app.effects; log("V\\t" + app.version); for (var __i = 0; __i < __e.length; __i++) { log("E\\t" + __e[__i].matchName + "\\t" + __e[__i].displayName + "\\t" + __e[__i].category); }\n';
  const r = await runSnippet("effects", "effects", code, { undo: false, label: "ae effects", quiet: true });
  if (r.code) return r.code;
  const text = readLog(r.log);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(EFFECTS_CACHE, text);
  return parseEffects(text);
}

export function parseEffects(text: string): Effect[] {
  const res: Effect[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "E" && f.length >= 4 && f[1]) res.push({ matchName: f[1], displayName: f[2], category: f[3] });
  }
  return res;
}

/** Every word must appear in the display name, matchName or category (any case). */
export function searchEffects(all: Effect[], words: string[]): Effect[] {
  const w = words.map((x) => x.toLowerCase());
  return all
    .filter((e) => w.every((x) => `${e.displayName}\t${e.matchName}\t${e.category}`.toLowerCase().includes(x)))
    .sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));
}

export async function cmdEffects(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "effects", [], ["--refresh"]);
  const all = await loadEffects(!!p.opts["--refresh"]);
  if (typeof all === "number") return all;
  const hits = searchEffects(all, p.pos);
  if (!hits.length) {
    err(`ae: no effect matches '${p.pos.join(" ")}' (${all.length} effects; ae effects --refresh after installing plugins)`);
    return 1;
  }
  const w = Math.min(40, Math.max(...hits.map((e) => e.displayName.length)));
  for (const e of hits) out(`${e.displayName.padEnd(w)}  ${e.matchName}  [${e.category || "-"}]`);
  return 0;
}
