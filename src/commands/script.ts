// ae run / eval / check
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../args.ts";
import { LIB, TOOLS, WORK } from "../env.ts";
import { evalScript, prep } from "../lint.ts";
import { readLog, runJsx, runSnippet, UNDO_FILE } from "../runner.ts";
import { abspath, die, isFile, jsstr, out } from "../util.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "run", ["--log", "--timeout"], ["--ro", "--undo", "--rollback"]);
  let script = p.pos[p.pos.length - 1] ?? "";
  if (!script) die("usage: ae run script.jsx [--log file] [--ro|--undo] [--rollback] [--timeout s]");
  if (!isFile(script)) die("no such file: " + script);
  script = abspath(script);
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
  return runJsx(script, log, { undo, label: path.basename(script), timeout, rollback: p.opts["--rollback"] === true });
}

export async function cmdEval(argv: string[]): Promise<number> {
  const undo = !argv.includes("--ro");
  const code = argv.filter((a) => a !== "--ro").join("\n");
  if (!code) die("usage: ae eval 'js code' [--ro]   (the value of the last expression is logged)");
  const dir = path.join(WORK, "eval");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "eval.jsx");
  writeFileSync(f, evalScript(code));
  return runJsx(f, path.join(dir, "eval.log"), { undo, label: "ae eval" });
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

/** ae undo [step ...]: take back the steps of the last run (or the named ones), newest first, each only if it is AE's last step. */
export async function cmdUndo(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "undo");
  let steps = p.pos;
  if (!steps.length) {
    try {
      steps = (JSON.parse(readFileSync(UNDO_FILE, "utf8")) as { steps: string[] }).steps;
    } catch {
      die("undo: no undo step recorded; name one: ae undo \"<step>\" (the UNDO line of a run)");
    }
  }
  const code =
    `var S = [${steps.map(jsstr).join(", ")}];\n` +
    `for (var i = S.length - 1; i >= 0; i--) {\n` +
    `    if (!AE.undo(S[i])) { throw new Error("the last step in AE is not '" + S[i] + "' (Edit menu), so nothing more was undone"); }\n` +
    `    log("UNDONE " + S[i]);\n` +
    `}\n`;
  const r = await runSnippet("undo", "undo", code, { undo: false, label: "ae undo", internal: true });
  if (!p.pos.length && r.code !== 3) {
    // keep only the steps still to undo, so the next `ae undo` does not retry one that is gone
    const done = new Set(readLog(r.log).split("\n").filter((l) => l.startsWith("UNDONE ")).map((l) => l.slice(7)));
    const left = steps.filter((s) => !done.has(s));
    if (left.length) writeFileSync(UNDO_FILE, JSON.stringify({ steps: left }) + "\n");
    else rmSync(UNDO_FILE, { force: true });
  }
  return r.code;
}
