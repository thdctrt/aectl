// Configuration from the environment, resolved once per process.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFile, run } from "./util.ts";

/** Repo/package root: the parent of dist/ (bundle) or src/ (sources). */
export const TOOLS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LIB = path.join(TOOLS, "lib.jsx");

/** Work dir shared with AE: $AE_TMP or $TMPDIR (AE's own Folder.temp may be unreadable from a sandboxed shell). */
export const WORK = path.join((process.env.AE_TMP || process.env.TMPDIR || "/tmp").replace(/\/+$/, "") || "/", "ae-tools");

export const RUN_TIMEOUT = num(process.env.AE_TIMEOUT, 300); // seconds to wait for a script's log
export const SNAP_TIMEOUT = num(process.env.AE_SNAP_TIMEOUT, 60); // seconds to wait for async PNGs
export const DEBUG = !!process.env.AE_DEBUG;

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v && isFinite(n) && n > 0 ? n : dflt;
}

let app: string | undefined;
/** AE app name: $AE_APP, else the running instance, else the newest one installed in /Applications. */
export function aeApp(): string {
  if (app === undefined) app = process.env.AE_APP || detectApp() || "Adobe After Effects 2026";
  return app;
}

function detectApp(): string {
  const ps = run("ps", ["-axo", "comm="]);
  const line = ps.stdout.split("\n").find((l) => l.endsWith("/Contents/MacOS/After Effects"));
  if (line) return path.basename(line.slice(0, line.indexOf(".app/Contents/MacOS/")));
  const found: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync("/Applications").filter((d) => d.startsWith("Adobe After Effects"));
  } catch {
    // no /Applications
  }
  for (const d of dirs) {
    let apps: string[] = [];
    try {
      apps = readdirSync(path.join("/Applications", d));
    } catch {
      continue;
    }
    for (const a of apps) {
      if (a.startsWith("Adobe After Effects") && a.endsWith(".app") && !a.includes("Render Engine")) found.push(a.slice(0, -4));
    }
  }
  return found.sort().pop() ?? "";
}

let font: string | undefined;
/** A TrueType font for contact-sheet labels, or "" (labels are then skipped). */
export function labelFont(): string {
  if (font === undefined) {
    font = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"].find(isFile) ?? "";
  }
  return font;
}
