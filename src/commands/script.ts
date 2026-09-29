// ae run / eval / check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { int, parseArgs, str } from "../args.ts";
import { diffSnapshots, parseSnapshot } from "../diff.ts";
import { LIB, TOOLS, WORK } from "../env.ts";
import { evalScript, prep } from "../lint.ts";
import { makeSheet } from "../media.ts";
import { runJsx } from "../runner.ts";
import { type Cell, parseFrames, RES, snapFrames } from "./inspect.ts";
import { parseBox } from "./media.ts";
import { abspath, die, isFile, out } from "../util.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  const usage = "usage: ae run script.jsx [--log file] [--ro|--undo] [--no-rollback] [--timeout s] [--diff] [--ab Comp --frames 0,30,60 [--res r] [--crop x,y,w,h] [--cols N] [--width px]]";
  const p = parseArgs(argv, "run", ["--log", "--timeout", "--ab", "--frames", "--res", "--crop", "--cols", "--width"], ["--ro", "--undo", "--no-rollback", "--diff"]);
  let script = p.pos[p.pos.length - 1] ?? "";
  if (!script) die(usage);
  if (!isFile(script)) die("no such file: " + script);
  script = abspath(script);
  const ab = str(p, "--ab");
  if (!!ab !== !!str(p, "--frames")) die("--ab and --frames go together: " + usage);
  const frames = ab ? parseFrames(str(p, "--frames")) : [];
  const res = str(p, "--res", "half");
  if (!RES.includes(res)) die("--res must be full|half|third|quarter");
  const crop = str(p, "--crop") ? parseBox(str(p, "--crop"), "--crop") : null;
  let log = str(p, "--log");
  if (!log) {
    // scripts inside the toolkit dir log to the work dir, to keep the repo clean
    log = script.startsWith(TOOLS + path.sep) ? path.join(WORK, "logs", path.basename(script).replace(/\.jsx$/, "") + ".log") : script.replace(/\.jsx$/, "") + ".log";
  }
  log = abspath(log);
  let undo: boolean;
  if (p.opts["--ro"]) undo = false;
  else if (p.opts["--undo"]) undo = true;
  // scripts that call AE.run/AE.peek/app.beginUndoGroup manage their own undo groups; plain scripts get one named after the file
  else undo = !/AE\.(run|peek)\s*\(|app\.beginUndoGroup\s*\(/.test(readFileSync(script, "utf8"));
  const timeout = p.opts["--timeout"] ? Number(p.opts["--timeout"]) : undefined;

  const abDir = path.join(WORK, "ab", ab.replace(/[^A-Za-z0-9_-]/g, "_"));
  let beforeCells: Cell[] = [];
  if (ab) {
    // a separate call: saveFrameToPng renders after the script returns, so "before" frames must be done before the edit
    const b = await snapFrames(ab, frames, abDir, "before", res, crop);
    if (b.code) return b.code;
    beforeCells = b.cells;
  }
  const diffDir = path.join(WORK, "diff");
  const diff = p.opts["--diff"] ? { before: path.join(diffDir, "before.txt"), after: path.join(diffDir, "after.txt") } : undefined;
  if (diff) mkdirSync(diffDir, { recursive: true });
  const code = await runJsx(script, log, { undo, label: path.basename(script), timeout, rollback: !p.opts["--no-rollback"], exprCheck: !p.opts["--ro"], diff });
  if (diff && (code === 0 || code === 1) && isFile(diff.before) && isFile(diff.after)) {
    const lines = diffSnapshots(parseSnapshot(readFileSync(diff.before, "utf8")), parseSnapshot(readFileSync(diff.after, "utf8")));
    out(lines.length ? "DIFF\n" + lines.join("\n") : "DIFF no changes");
  }
  if (ab && code === 0) {
    const a = await snapFrames(ab, frames, abDir, "after", res, crop);
    if (a.code) return a.code;
    const cells: Cell[] = [];
    beforeCells.forEach((c, i) => {
      cells.push({ label: "before " + c.label, file: c.file });
      if (a.cells[i]) cells.push({ label: "after " + a.cells[i].label, file: a.cells[i].file });
    });
    const sheet = path.join(abDir, "ab_sheet.png");
    makeSheet(sheet, int(p, "--cols", 4), int(p, "--width", 480), cells);
    out("SHEET " + sheet);
  }
  return code;
}

export async function cmdEval(argv: string[]): Promise<number> {
  const undo = !argv.includes("--ro");
  const rollback = !argv.includes("--no-rollback");
  const code = argv.filter((a) => a !== "--ro" && a !== "--no-rollback").join("\n");
  if (!code) die("usage: ae eval 'js code' [--ro] [--no-rollback]   (the value of the last expression is logged)");
  const dir = path.join(WORK, "eval");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "eval.jsx");
  writeFileSync(f, evalScript(code));
  return runJsx(f, path.join(dir, "eval.log"), { undo, label: "ae eval", rollback, exprCheck: undo });
}

export async function cmdCheck(argv: string[]): Promise<number> {
  if (!argv.length) die("usage: ae check script.jsx [more.jsx ...]");
  mkdirSync(path.join(WORK, "run"), { recursive: true });
  let code = 0;
  for (const f of argv) {
    if (!isFile(f)) {
      process.stderr.write(`ae: no such file: ${f}\n`);
      code = 2;
      continue;
    }
    if (prep(f, path.join(WORK, "run", "check.prep.jsx"), LIB)) out("ok: " + f);
    else code = 2;
  }
  return code;
}

