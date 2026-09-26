// ae save: save the open project with AE's own Save (not undoable). Only when the user asks for it.
import { copyFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../args.ts";
import { readLog, runSnippet } from "../runner.ts";
import { abspath, die, err, isDir, isFile, jsstr, out } from "../util.ts";

const logValue = (log: string, key: string) => (readLog(log).split("\n").find((l) => l.startsWith(key + " ")) ?? "").slice(key.length + 1);

export async function cmdSave(argv: string[]): Promise<number> {
  const usage = () => die("usage: ae save [--backup] [--status] [--as file.aep]") as never;
  const p = parseArgs(argv, "save", ["--as"], ["--backup", "--status"], usage);
  if (p.pos.length) usage();
  const as = str(p, "--as") ? abspath(str(p, "--as")) : "";

  const st = await runSnippet("save", "status", 'var __p=app.project.file;log("PATH "+(__p?__p.fsName:""));log("DIRTY "+app.project.dirty);\n', {
    undo: false,
    label: "ae save status",
    quiet: true,
  });
  if (st.code) return st.code;
  const project = logValue(st.log, "PATH");
  const dirty = logValue(st.log, "DIRTY");
  out(`project: ${project || "<untitled>"}`);
  out(`unsaved changes: ${dirty}`);
  if (p.opts["--status"]) return 0;
  if (!as) {
    if (!project) die("project has never been saved; use: ae save --as /path/file.aep");
    if (dirty !== "true") {
      out("nothing to save");
      return 0;
    }
  } else {
    if (!/\.aepx?$/.test(as)) die("--as path must end in .aep or .aepx");
    if (!isDir(path.dirname(as))) die("folder does not exist: " + path.dirname(as));
  }
  if (p.opts["--backup"] && project && isFile(project)) {
    const name = path.basename(project);
    const ext = path.extname(name);
    const dest = path.join(path.dirname(project), "Backups", `${name.slice(0, name.length - ext.length)}-${stamp(new Date())}${ext}`);
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(project, dest);
      const s = statSync(project);
      utimesSync(dest, s.atime, s.mtime); // like cp -p
    } catch {
      die(`backup failed (${dest}); not saved`);
    }
    out("backup: " + dest);
  }
  const save = as ? `app.project.save(new File(${jsstr(as)}));` : "app.project.save();";
  const sv = await runSnippet("save", "save", save + 'log("SAVED "+app.project.file.fsName);log("DIRTY "+app.project.dirty);\n', { undo: false, label: "ae save", quiet: true });
  if (sv.code) return sv.code;
  const saved = logValue(sv.log, "SAVED");
  if (!saved || !isFile(saved)) {
    err(`ae: save did not confirm (log: ${sv.log})`);
    return 1;
  }
  const s = statSync(saved);
  out(`saved: ${saved} (${humanSize(s.size)}, ${s.mtime.toTimeString().slice(0, 8)})`);
  if (logValue(sv.log, "DIRTY") !== "false") err("ae: warning: AE still reports unsaved changes");
  return 0;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanSize(n: number): string {
  const units = ["B", "K", "M", "G"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? String(n) : n < 10 ? n.toFixed(1) : String(Math.round(n))) + units[i];
}
