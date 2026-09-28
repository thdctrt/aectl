// ae doctor / selftest / completion / hook, and the hidden _names used by the zsh completion
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { aeApp, LIB, TOOLS, WORK } from "../env.ts";
import { check } from "../lint.ts";
import { aeRunning, readLog, runJsx, runSnippet } from "../runner.ts";
import { die, err, has, isDir, isFile, jsstr, need, out, run } from "../util.ts";

// ------------------------------------------------------------------------------------------ doctor

/** Checks everything a first run needs; ok/WARN/FAIL with the fix. Exit 1 on any FAIL. Read-only. */
export async function cmdDoctor(): Promise<number> {
  let fails = 0;
  const ok = (m: string) => out("ok    " + m);
  const warn = (m: string) => out("WARN  " + m);
  const fail = (m: string) => {
    out("FAIL  " + m);
    fails++;
  };
  const app = aeApp();
  const pref = "Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network";

  if (os.platform() === "darwin") ok("macOS " + run("sw_vers", ["-productVersion"]).stdout.trim());
  else fail("macOS only (AE is driven through osascript)");
  ok("node " + process.versions.node);
  for (const tool of ["ffmpeg", "ffprobe"]) {
    if (has(tool)) ok(tool);
    else warn(`${tool} not found (needed by snap --sheet, sheet, frames, probe, selftest): brew install ffmpeg`);
  }
  try {
    mkdirSync(WORK, { recursive: true });
    ok("work dir " + WORK);
  } catch {
    fail(`cannot write the work dir ${WORK} (set AE_TMP)`);
  }
  if ([`/Applications/${app}/${app}.app`, `/Applications/${app}.app`].some(isDir)) ok(`app '${app}'`);
  else warn(`'${app}' not found in /Applications (set AE_APP to the app name)`);

  // "Allow Scripts to Write Files and Access Network": ae run reads the log file the script writes
  const prefs = prefsFile(app);
  if (prefs) {
    const text = readFileSync(prefs, "utf8").replace(/\r/g, "\n");
    const m = /"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "?(\d+)"?/.exec(text);
    if (m && Number(m[1]) === 1) ok(`scripts may write files (prefs ${path.basename(prefs)})`);
    else if (m) fail(`scripts may not write files, so ae never sees the log. In AE: ${pref}`);
    else warn(`could not read the scripting pref in ${prefs}; make sure ${pref} is on`);
  } else {
    warn(`AE prefs not found; make sure ${pref} is on`);
  }

  if (!has("osascript")) {
    fail("osascript not found");
  } else if (!aeRunning()) {
    warn(`'${app}' is not running: start it and run ae doctor again to test the connection`);
  } else {
    // the first run makes macOS ask whether this terminal may control AE
    const captured = await captureStderr(() => runSnippet("doctor", "doctor", 'log("AE " + app.version);\n', { undo: false, label: "ae doctor", quiet: true, timeout: 20 }));
    const { code, log } = captured.value;
    if (code === 0) {
      ok("round trip: " + (readLog(log).split("\n").find((l) => l.startsWith("AE ")) ?? ""));
    } else if (/-1743|Not authorized|not allowed/.test(captured.stderr)) {
      fail(`macOS blocks this terminal from controlling AE. System Settings > Privacy & Security > Automation: allow your terminal app to control '${app}'`);
    } else {
      fail("round trip failed (a modal dialog open in AE is the usual cause):");
      for (const l of captured.stderr.trim().split("\n")) out("      " + l);
    }
  }
  if (fails === 0) {
    out("no failures");
    return 0;
  }
  return 1;
}

/** Newest "<major>.<minor>" prefs folder for "Adobe After Effects 20YY" (26.10 after 26.5). */
function prefsFile(app: string): string {
  const year = /(20\d\d)$/.exec(app);
  if (!year) return "";
  const major = Number(year[1]) - 2000;
  const dir = path.join(os.homedir(), "Library/Preferences/Adobe/After Effects");
  let best = -1;
  let ver = "";
  try {
    for (const d of readdirSync(dir)) {
      const m = new RegExp(`^${major}\\.(\\d+)$`).exec(d);
      if (m && Number(m[1]) > best) {
        best = Number(m[1]);
        ver = d;
      }
    }
  } catch {
    return "";
  }
  const f = ver ? path.join(dir, ver, `Adobe After Effects ${ver} Prefs.txt`) : "";
  return f && isFile(f) ? f : "";
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr: buf };
  } finally {
    process.stderr.write = orig;
  }
}

// ------------------------------------------------------------------------------------------ selftest

/** Generate a test clip, run tests/selftest.jsx in a throwaway comp, then tests/cleanup.jsx. */
export async function cmdSelftest(argv: string[]): Promise<number> {
  const keep = argv[0] === "--keep";
  if (!aeRunning()) {
    err(`ae: '${aeApp()}' is not running`);
    return 3;
  }
  need("ffmpeg");
  mkdirSync(path.join(WORK, "logs"), { recursive: true });
  const clip = path.join(WORK, "__aetools_clip.mp4");
  if (!isFile(clip)) {
    const src = ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=6"];
    const x264 = run("ffmpeg", ["-v", "error", "-y", ...src, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    if (x264.status !== 0 && run("ffmpeg", ["-v", "error", "-y", ...src, "-c:v", "h264_videotoolbox", clip], { stdio: ["ignore", "inherit", "inherit"] }).status !== 0) {
      die("ffmpeg could not create " + clip);
    }
  }
  let code = await runJsx(path.join(TOOLS, "tests", "selftest.jsx"), path.join(WORK, "logs", "selftest.log"), { undo: false, label: "selftest.jsx" });
  if (code === 0) code = await rollbackRoundTrip();
  if (!keep) {
    const c = await runJsx(path.join(TOOLS, "tests", "cleanup.jsx"), path.join(WORK, "logs", "cleanup.log"), { undo: false, label: "cleanup.jsx", quiet: true });
    if (c === 0) err("ae: cleanup done");
  }
  return code;
}

/**
 * Rollback, which the in-AE self-test cannot check from inside its own undo group: a failed run is undone, and one
 * that fails before changing anything leaves the step before it alone. Uses the comment of the test comp.
 */
async function rollbackRoundTrip(): Promise<number> {
  const T = 'AE.comp("__aetools_test")';
  const CHECK = `function check(name, ok, info) { log((ok ? "PASS " : "ERR FAIL ") + name + (info === undefined ? "" : "  " + AE.str(info))); }\n`;
  const probe = (name: string, body: string) =>
    runSnippet("selftest", name, `AE.run(${jsstr(name)}, function () { ${body} throw new Error("expected by the self-test"); });\n`, { undo: false, label: name, quiet: true, rollback: true });
  const keep = await runSnippet("selftest", "rollback_keep", `AE.run("rollback keep", function () { ${T}.comment = "keep"; });\n`, { undo: false, label: "rollback keep", quiet: true, rollback: true });
  if (keep.code) return keep.code;
  err("ae: two runs that fail on purpose follow (their ERR lines are expected)");
  const changed = await probe("rollback probe", `${T}.comment = "changed";`);
  const empty = await probe("rollback empty", "");
  const rolled = [changed, empty].every((r) => r.code === 1 && readLog(r.log).includes("ROLLED BACK"));
  const r = await runSnippet(
    "selftest",
    "rollback_check",
    CHECK +
      `check("rollback undoes a failed run, and nothing before it", ${rolled} && ${T}.comment === "keep", [${rolled}, ${T}.comment]);\n` +
      `${T}.comment = "";\n`,
    { undo: false, label: "rollback check" },
  );
  return r.code;
}

// ------------------------------------------------------------------------------------------ completion

export async function cmdCompletion(argv: string[]): Promise<number> {
  if (argv[0] !== "zsh") die('usage: ae completion zsh   (then add  eval "$(ae completion zsh)"  to ~/.zshrc)');
  process.stdout.write(readFileSync(path.join(TOOLS, "completions", "_ae"), "utf8"));
  return 0;
}

/**
 * ae _names comps | ae _names layers "Comp": one name per line, for the completion. Read-only and silent; prints
 * nothing when AE is not running or does not answer within 3 s.
 */
export async function cmdNames(argv: string[]): Promise<number> {
  let code: string;
  if (argv[0] === "comps") code = 'var __a = AE.comps(); for (var __i = 0; __i < __a.length; __i++) { log("N " + __a[__i].name); }\n';
  else if (argv[0] === "layers") code = `var __c = AE.comp(${jsstr(argv[1] ?? "")}); for (var __i = 1; __i <= __c.numLayers; __i++) { log("N " + __c.layer(__i).name); }\n`;
  else return 2;
  if (!aeRunning()) return 0;
  const r = await captureStderr(() => runSnippet("complete", "names", code, { undo: false, label: "ae complete", quiet: true, timeout: 3 }));
  if (r.value.code) return 0;
  const names = [...new Set(readLog(r.value.log).split("\n").filter((l) => l.startsWith("N ")).map((l) => l.slice(2)))].sort();
  if (names.length) out(names.join("\n"));
  return 0;
}

// ------------------------------------------------------------------------------------------ hook

/** Does this .jsx look like ExtendScript for AE (and not a React component)? */
export function looksLikeExtendScript(src: string): boolean {
  if (/^\s*(import|export)\s/m.test(src) || /\bReact\b|\bfrom\s+["']/.test(src)) return false;
  return /\bAE\.\w|\bapp\.(project|beginUndoGroup|endUndoGroup|version)\b|\b(CompItem|FootageItem|FolderItem|AVLayer|TextLayer|ShapeLayer)\b|^\s*(#|\/\/@)(include|target)\b|\$\.(writeln|write|sleep|fileName|global)\b/m.test(src);
}

/**
 * Claude Code PostToolUse hook (the plugin registers it for Write/Edit/MultiEdit): lint the .jsx file that was just
 * written. Errors: stderr + exit 2, which Claude Code shows to the model. Warnings only: additionalContext, exit 0.
 */
export async function cmdHook(): Promise<number> {
  let input: { tool_input?: { file_path?: string } } = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return 0;
  }
  const file = input.tool_input?.file_path ?? "";
  if (!file.endsWith(".jsx") || file.includes(`${path.sep}node_modules${path.sep}`) || !isFile(file)) return 0;
  const src = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!looksLikeExtendScript(src)) return 0;
  const { errors, warnings } = check(src, path.basename(file), LIB);
  if (errors.length) {
    err(`ae check: ${file} would fail in After Effects (ExtendScript is ES3). Fix before running it:\n` + [...errors, ...warnings].join("\n"));
    return 2;
  }
  if (warnings.length) {
    out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `ae check warnings for ${file}:\n` + warnings.join("\n") } }));
  }
  return 0;
}
