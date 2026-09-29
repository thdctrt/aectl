// End-to-end tests of the built CLI (dist/ae.mjs through the `ae` launcher) for everything that does not need AE.
// `npm test` builds first.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrames } from "../src/commands/inspect.ts";
import { looksLikeExtendScript } from "../src/commands/setup.ts";
import { jsstr } from "../src/util.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "aectl-"));
// an osascript that answers "not running" (also on machines without one) and an app name no AE can have:
// nothing here ever talks to a running After Effects
const BIN = tmp();
writeFileSync(path.join(BIN, "osascript"), "#!/bin/sh\necho false\n");
chmodSync(path.join(BIN, "osascript"), 0o755);
const ENV = { ...process.env, AE_APP: "No Such After Effects 2099", PATH: BIN + path.delimiter + process.env.PATH };
const ae = (args: string[], input?: string) => {
  const r = spawnSync(path.join(ROOT, "ae"), args, { encoding: "utf8", input, env: ENV });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("cli", () => {
  it("prints usage: exit 0 for help, 2 without a command", () => {
    expect(ae(["help"]).code).toBe(0);
    expect(ae(["help"]).out).toContain("ae run script.jsx");
    expect(ae([]).code).toBe(2);
  });

  it("--help after a command prints its usage lines", () => {
    const r = ae(["dump", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^  ae dump "Comp"/);
    expect(ae(["check", "-h"]).out).toContain("ae check script.jsx");
  });

  it("rejects an unknown command", () => {
    const r = ae(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'frobnicate'");
  });

  it.each([
    [["run"], "usage: ae run"],
    [["run", "--zzz", "x.jsx"], "run: unknown option --zzz"],
    [["run", "/nope.jsx"], "no such file: /nope.jsx"],
    [["dump"], "usage: ae dump"],
    [["snap", "X", "1", "--res", "huge"], "--res must be full|half|third|quarter"],
    [["snap", "X", "1-a"], "bad frame list '1-a'"],
    [["save", "--zzz"], "usage: ae save"],
    [["completion", "bash"], "usage: ae completion zsh"],
    [["run", "x.jsx", "--ab", "Main"], "no such file: x.jsx"],
    [["sel", "extra"], "usage: ae sel"],
    [["markers", "A", "B"], "usage: ae markers"],
    [["mark", "Main"], "usage: ae mark"],
    [["mark", "Main", "ten", "hi"], "frame must be a number"],
    [["health", "--safe", "60"], "--safe is a margin"],
    [["find"], "usage: ae find"],
    [["find", "x", "--in", "names"], "unknown scope 'names'"],
    [["find", "(", "--regex"], "bad regex"],
    [["graph", "Main", "Title"], "usage: ae graph"],
    [["graph", "Main", "Title", "pos", "--from", "x"], "--from must be a number"],
    [["beats", "x.wav", "--mark"], "--mark puts markers on the audio layer"],
    [["mcp", "extra"], "usage: ae mcp"],
  ])("ae %j -> exit 2 with a message", (args, msg) => {
    const r = ae(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });

  it("run: --ab needs --frames", () => {
    const d = tmp();
    writeFileSync(path.join(d, "s.jsx"), "log(1);\n");
    const r = ae(["run", path.join(d, "s.jsx"), "--ab", "Main"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--ab and --frames go together");
  });

  it("every command in the usage is documented and completed", () => {
    const usage = ae(["help"]).out;
    const cmds = new Set([...usage.matchAll(/(?:^|\s{2,})ae ([a-z]+)/gm)].map((m) => m[1]));
    expect(cmds.size).toBeGreaterThan(20);
    const skill = readFileSync(path.join(ROOT, "skills/after-effects/SKILL.md"), "utf8");
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const zsh = readFileSync(path.join(ROOT, "completions/_ae"), "utf8");
    for (const c of cmds) {
      if (c === "hook") continue; // internal: registered by the plugin
      // the completion is for people at a shell, not for agents: SKILL.md stays lean
      if (c !== "completion") expect(skill, `ae ${c} in SKILL.md`).toMatch(new RegExp("\\bae " + c + "\\b"));
      expect(readme, `ae ${c} in README.md`).toMatch(new RegExp("\\bae " + c + "\\b"));
      expect(zsh, `${c} in completions/_ae`).toContain(`'${c}:`);
    }
  });

  it("check: ok for a valid script, exit 2 with the error for a broken one", () => {
    const d = tmp();
    writeFileSync(path.join(d, "good.jsx"), "var a = 1;\nlog(a);\n");
    writeFileSync(path.join(d, "bad.jsx"), "var a = 1;\nvar f = () => a;\n");
    expect(ae(["check", path.join(d, "good.jsx")])).toMatchObject({ code: 0, out: `ok: ${path.join(d, "good.jsx")}\n` });
    const bad = ae(["check", path.join(d, "bad.jsx")]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("bad.jsx:2: ERROR arrow function");
  });

  it("run/eval refuse to send a broken script to AE", () => {
    const r = ae(["eval", "let x = 1", "--ro"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("failed the syntax/lint check; not run");
  });

  it("run reports a missing AE with exit 3 after the lint passes", () => {
    const d = tmp();
    writeFileSync(path.join(d, "s.jsx"), "log(1);\n");
    const r = ae(["run", path.join(d, "s.jsx")]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("is not running");
  });

  it("completion zsh prints the script", () => {
    expect(ae(["completion", "zsh"]).out.startsWith("#compdef ae aectl")).toBe(true);
  });

  it("_names prints nothing when AE is not running", () => {
    expect(ae(["_names", "comps"])).toMatchObject({ code: 0, out: "" });
  });
});

describe("hook", () => {
  const hook = (file: string, src: string) => {
    const d = tmp();
    const f = path.join(d, file);
    writeFileSync(f, src);
    return ae(["hook"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: f } }));
  };

  it("blocks an ExtendScript file with errors (exit 2, message on stderr)", () => {
    const r = hook("edit.jsx", "var c = app.project.activeItem;\nlet n = 1;\n");
    expect(r.code).toBe(2);
    expect(r.err).toContain("edit.jsx:2: ERROR let (ES6)");
  });

  it("passes warnings to the model as additional context", () => {
    const r = hook("edit.jsx", "var c = app.project.activeItem;\n[1].forEach(function () {});\n");
    expect(r.code).toBe(0);
    const outJson = JSON.parse(r.out);
    expect(outJson.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(outJson.hookSpecificOutput.additionalContext).toContain(".forEach()");
  });

  it("stays silent for React .jsx, other files and bad input", () => {
    expect(hook("App.jsx", 'import React from "react";\nexport const A = () => <div />;\n')).toMatchObject({ code: 0, out: "", err: "" });
    expect(hook("x.ts", "let a = 1;\n")).toMatchObject({ code: 0, out: "", err: "" });
    expect(ae(["hook"], "not json")).toMatchObject({ code: 0, out: "", err: "" });
  });

  it("recognises ExtendScript", () => {
    expect(looksLikeExtendScript("var c = app.project.activeItem;")).toBe(true);
    expect(looksLikeExtendScript('#include "lib.jsx"\nfoo();')).toBe(true);
    expect(looksLikeExtendScript('AE.run("x", function (log) {});')).toBe(true);
    expect(looksLikeExtendScript("function Button() { return <button />; }")).toBe(false);
  });
});

describe("helpers", () => {
  it("parses frame lists and ranges", () => {
    expect(parseFrames("8,44,90")).toEqual([8, 44, 90]);
    expect(parseFrames("0-20:10")).toEqual([0, 10, 20]);
    expect(parseFrames("3-5,9")).toEqual([3, 4, 5, 9]);
  });

  it("escapes strings for ExtendScript source", () => {
    expect(jsstr('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(jsstr("Привет")).toBe('"\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442"');
  });
});
