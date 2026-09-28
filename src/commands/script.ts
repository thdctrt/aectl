// ae run / eval / check
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../args.ts";
import { LIB, TOOLS, WORK } from "../env.ts";
import { evalScript, prep } from "../lint.ts";
import { runJsx } from "../runner.ts";
import { abspath, die, isFile, out } from "../util.ts";

export async function cmdRun(argv: string[]): Promise<number> {
  const p = parseArgs(argv, "run", ["--log", "--timeout"], ["--ro", "--undo", "--no-rollback"]);
  let script = p.pos[p.pos.length - 1] ?? "";
  if (!script) die("usage: ae run script.jsx [--log file] [--ro|--undo] [--no-rollback] [--timeout s]");
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
  return runJsx(script, log, { undo, label: path.basename(script), timeout, rollback: !p.opts["--no-rollback"] });
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
  return runJsx(f, path.join(dir, "eval.log"), { undo, label: "ae eval", rollback });
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

