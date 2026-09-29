// Unit tests of the parts of sel/markers/health/graph/effects/run --diff/mcp that run without AE: the diff, the graph
// maths and chart, the effect search, and the MCP server over stdio.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseGraph, segments, speeds } from "../src/commands/graph.ts";
import { parseEffects, searchEffects } from "../src/commands/project.ts";
import { diffSnapshots, lineDiff, parseSnapshot } from "../src/diff.ts";
import { TOOLS_LIST } from "../src/mcp.ts";
import { encodePng, renderChart } from "../src/plot.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "aectl-"));

describe("diff", () => {
  const snap = (layers: string) =>
    ["@I", "Composition 'Main' id=1", "@C 1 COMP 'Main' id=1 1920x1080 25fps dur=250f (10s) layers=2 folder=''", "marker f10 'a'", layers].join("\n");
  const before = snap(["@L id5", "#1 'Title' [text] in=0 out=250 st=0", "    tf Opacity=100", "@L id6", "#2 'Box' [shape] in=0 out=250 st=0", "    tf Opacity=50"].join("\n"));

  it("reports nothing for equal snapshots", () => {
    expect(diffSnapshots(parseSnapshot(before), parseSnapshot(before))).toEqual([]);
  });

  it("reports changed lines, new and removed layers, and moves on one line", () => {
    const after = snap(["@L id7", "#1 'New' [solid] in=0 out=250 st=0", "@L id5", "#2 'Title' [text] in=0 out=250 st=0", "    tf Opacity=0"].join("\n"));
    const d = diffSnapshots(parseSnapshot(before), parseSnapshot(after));
    expect(d[0]).toBe("comp 'Main' id=1:");
    expect(d).toContain("  - #2 'Box' [shape] in=0 out=250 st=0  (removed)");
    expect(d).toContain("  + #1 'New' [solid] in=0 out=250 st=0  (new)");
    expect(d).toContain("  ~ #2 'Title' [text] in=0 out=250 st=0");
    expect(d).toContain("      - tf Opacity=100");
    expect(d).toContain("      + tf Opacity=0");
    expect(d).toContain("  layer order: 'Title' #1->#2");
  });

  it("reports new comps and project items", () => {
    const after = before.replace("@I\n", "@I\nFootage 'clip.mp4' id=9\n") + "\n@C 2 COMP 'Intro' id=2 100x100 25fps dur=10f (0.4s) layers=0 folder=''";
    const d = diffSnapshots(parseSnapshot(before), parseSnapshot(after));
    expect(d).toEqual(["project items:", "  + Footage 'clip.mp4' id=9", "+ comp 'Intro' id=2 (new)"]);
  });

  it("diffs lines in order", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual(["- b", "+ x", "+ d"]);
  });
});

describe("graph", () => {
  const log = [
    "PROP 'Title' Transform/Position (ADBE Position) fps=25 spatial=1 color=0",
    "RANGE 0 20 5",
    "KEY 0:[0,0] BB(33,33)",
    "KEY 20:[100,0] BB(33,33)",
    "S 0 0,0",
    "S 5 10,0",
    "S 10 50,0",
    "S 15 90,0",
    "S 20 100,0",
  ].join("\n");

  it("parses AE.graphData output", () => {
    const g = parseGraph(log);
    expect(g).toMatchObject({ title: "'Title' Transform/Position (ADBE Position)", fps: 25, spatial: true, from: 0, to: 20, step: 5 });
    expect(g.keys.map((k) => k.frame)).toEqual([0, 20]);
    expect(g.samples[2]).toEqual({ frame: 10, v: [50, 0] });
  });

  it("computes speeds and describes the easing of each segment", () => {
    const g = parseGraph(log);
    expect(speeds(g).map((s) => s.v[0])).toEqual([50, 200, 200, 50]); // units per second at 25 fps
    const [seg] = segments(g);
    expect(seg).toContain("f0->f20  change [100,0]");
    expect(seg).toContain("peak 200/s");
    expect(seg).toContain("peak/avg 1.60");
  });

  it("calls a constant speed linear", () => {
    const lin = log.replace("S 5 10,0", "S 5 25,0").replace("S 10 50,0", "S 10 50,0").replace("S 15 90,0", "S 15 75,0");
    expect(segments(parseGraph(lin))[0]).toContain("constant speed 125/s (linear)");
  });

  it("writes a valid PNG chart", () => {
    const file = path.join(tmp(), "g.png");
    const g = parseGraph(log);
    renderChart(file, { title: "t", width: 320, height: 200, xFrom: 0, xTo: 20, marks: [0, 20], panels: [{ title: "value", series: [{ name: "x", color: [255, 0, 0], points: g.samples.map((s) => [s.frame, s.v[0]]) }] }] });
    const png = readFileSync(file);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(320);
    expect(png.readUInt32BE(20)).toBe(200);
  });

  it("encodes raw RGB losslessly", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = encodePng(2, 2, rgb);
    const idat = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
  });
});

describe("effects", () => {
  const all = parseEffects(["V\t26.5", "E\tADBE Gaussian Blur 2\tGaussian Blur\tBlur & Sharpen", "E\tADBE Fill\tFill\tGenerate", "E\tADBE Box Blur2\tFast Box Blur\tBlur & Sharpen"].join("\n"));

  it("parses the cache and searches every word", () => {
    expect(all.length).toBe(3);
    expect(searchEffects(all, ["blur"]).map((e) => e.displayName)).toEqual(["Fast Box Blur", "Gaussian Blur"]);
    expect(searchEffects(all, ["blur", "gauss"]).map((e) => e.matchName)).toEqual(["ADBE Gaussian Blur 2"]);
    expect(searchEffects(all, ["GENERATE"]).map((e) => e.matchName)).toEqual(["ADBE Fill"]);
  });
});

describe("mcp", () => {
  // talk to `ae mcp` over stdio, with an AE that is never running
  const session = async (msgs: object[]) => {
    const bin = tmp();
    writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\necho false\n");
    chmodSync(path.join(bin, "osascript"), 0o755);
    const child = spawn(path.join(ROOT, "ae"), ["mcp"], { env: { ...process.env, AE_APP: "No Such After Effects 2099", PATH: bin + path.delimiter + process.env.PATH } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.end(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    await new Promise((r) => child.on("close", r));
    return out.trim().split("\n").map((l) => JSON.parse(l));
  };
  const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  it("initializes, lists the tools and answers calls", async () => {
    const res = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "ae_check", { code: "let x = 1;" }),
      call(4, "ae_check", { code: "var x = 1;" }),
      call(5, "ae_docs"),
      call(6, "ae_tree"),
      call(7, "ae_nope"),
      { jsonrpc: "2.0", id: 8, method: "resources/list" },
      call(9, "ae_run", {}),
    ]);
    const byId = new Map(res.map((m) => [m.id, m]));
    expect(res.length).toBe(9); // no answer to the notification
    expect(byId.get(1).result.protocolVersion).toBe("2025-06-18");
    expect(byId.get(1).result.serverInfo.name).toBe("aectl");
    expect(byId.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS_LIST.map((t) => t.name));
    expect(byId.get(3).result.isError).toBe(true);
    expect(byId.get(3).result.content[0].text).toContain("ERROR let (ES6)");
    expect(byId.get(4).result).toMatchObject({ isError: false });
    expect(byId.get(5).result.content[0].text).toContain("## API (`lib.jsx`)");
    expect(byId.get(6).result.isError).toBe(true);
    expect(byId.get(6).result.content[0].text).toContain("exit 3");
    expect(byId.get(7).result.isError).toBe(true);
    expect(byId.get(8).error.code).toBe(-32601);
    expect(byId.get(9).result.content[0].text).toBe("give either code or file");
  }, 30000); // a few child processes: slow on a busy machine

  it("describes every tool with a schema, and maps each to a CLI command", () => {
    const usage = readFileSync(path.join(ROOT, "src/cli.ts"), "utf8");
    for (const t of TOOLS_LIST) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      for (const r of t.required ?? []) expect(Object.keys(t.props), t.name).toContain(r);
      const args: Record<string, unknown> = {};
      for (const k of Object.keys(t.props)) args[k] = t.props[k].type === "boolean" ? true : t.props[k].type === "number" ? 1 : "x";
      delete args.file;
      const argv = t.argv(args);
      if (Array.isArray(argv)) expect(usage, t.name).toContain(`  ${argv[0]}: cmd`);
    }
  });
});
