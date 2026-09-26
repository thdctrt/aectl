import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aeMembers, check, isExpr, lint, prep } from "../src/lint.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "lib.jsx");
const levels = (src: string) => lint(src, LIB).map((f) => f.level);
const errorsOf = (src: string) => lint(src, LIB).filter((f) => f.level === "error");
const warningsOf = (src: string) => lint(src, LIB).filter((f) => f.level === "warning");

// Every row was checked against the ExtendScript engine of AE 2026 (26.5) with eval() inside try/catch.
describe("matches what AE 2026 ExtendScript accepts", () => {
  const rejected: [string, string][] = [
    ["future reserved word as a name", "var short = 1;"],
    ["int as a name", "var int = 1;"],
    ["static as a name", "var static = 1;"],
    ["native/final as names", "var native = 1, final = 2;"],
    ["reserved word as a bare key", "var o = {in: 1};"],
    ["future reserved word as a bare key", "var o = {static: 1};"],
    ["class as a bare key", "var o = {class: 1};"],
    ["getter", "var o = {get x() { return 1; }};"],
    ["setter", "var o = {set x(v) {}};"],
    ["let", "let a = 1;"],
    ["const in a for header", "for (const i = 0; false;) {}"],
    ["arrow function", "var f = (x) => x;"],
    ["template literal", "var s = `x`;"],
    ["exponent", "var p = 2 ** 3;"],
    ["regex /y flag", "var r = /a/y;"],
    ["class", "class A {}"],
    ["spread", "f(...args);"],
    ["rest parameter", "function f(...a) {}"],
    ["destructuring", "var {a} = o;"],
    ["default parameter", "function f(a = 1) {}"],
    ["for...of", "for (var x of a) {}"],
    ["optional chaining", "var y = o?.a;"],
    ["nullish coalescing", "var y = a ?? b;"],
    ["shorthand property", "var o = {a};"],
    ["computed key", "var o = {[k]: 1};"],
    ["method shorthand", "var o = {m() {}};"],
    ["async function", "async function f() {}"],
    ["generator", "function* g() {}"],
    ["catch without binding", "try {} catch {}"],
    ["executeCommand", "app.executeCommand(2004);"],
  ];
  it.each(rejected)("rejects %s", (_name, src) => {
    expect(errorsOf(src).length).toBeGreaterThan(0);
  });

  const accepted: [string, string][] = [
    ["trailing comma in an object", "var o = ({a: 1,});"],
    ["trailing comma in an array", "var a = [1, 2,];"],
    ["quoted reserved key", 'var o = {"in": 1};'],
    ["let as a plain name", "var let = 1;"],
    ["yield as a plain name", "var yield = 1;"],
    ["labels and continue", "outer: for (var i = 0; i < 2; i++) { for (var j = 0; j < 2; j++) { continue outer; } }"],
    ["debugger", "if (false) { debugger; }"],
    ["Date.now", "var t = Date.now();"],
    ["top-level return (the runner wraps scripts in a function)", "if (true) { return; }"],
    ["regex flags g, i, m", "var r = /a/gim;"],
  ];
  it.each(accepted)("accepts %s", (_name, src) => {
    expect(errorsOf(src)).toEqual([]);
  });

  it("only warns about reserved words after a dot (fine in AE 2026, not in older versions)", () => {
    expect(levels("var o = {}; o.in = 1; var t = o.class;")).toEqual(["warning", "warning"]);
  });

  it("only warns about const outside a for header", () => {
    expect(levels("const c = 1;")).toEqual(["warning"]);
  });
});

describe("runtime warnings", () => {
  it.each([
    ["[].forEach", "[1].forEach(function () {});"],
    ["str.trim", 'var t = " a ".trim();'],
    ["Object.keys", "var k = Object.keys({});"],
    ["Array.isArray", "var b = Array.isArray([]);"],
    ["Function.bind", "var g = f.bind(null);"],
    ["JSON", "var s = JSON.stringify({});"],
    ["indexOf on an array literal", "var i = [1, 2].indexOf(2);"],
    ["indexOf on a variable holding an array", "var a = [1]; var i = a.indexOf(1);"],
    ["indexOf on split()", 'var i = "a,b".split(",").indexOf("b");'],
    ["app.project.save", "app.project.save();"],
    ["app.quit", "app.quit();"],
  ])("warns about %s", (_name, src) => {
    expect(warningsOf(src).length).toBeGreaterThan(0);
    expect(errorsOf(src)).toEqual([]);
  });

  it.each([
    ["indexOf on a string", 'var i = "abc".indexOf("b");'],
    ["a polyfilled forEach", "Array.prototype.forEach = function (f) {}; [1].forEach(function () {});"],
    ["a polyfilled Object.keys", "Object.keys = function (o) { return []; }; Object.keys({});"],
    ["JSON the script defines itself", "var JSON = {stringify: function () {}}; JSON.stringify(1);"],
    ["AE helpers named like ES5 methods", "AE.trim(L, 1, 2);"],
    ["strings and comments that look like errors", '// let x = () => 1\nvar s = "let y = `z` => 1"; var r = /let x/g;'],
  ])("does not warn about %s", (_name, src) => {
    expect(lint(src, LIB)).toEqual([]);
  });
});

describe("AE namespace", () => {
  it("reads the members from lib.jsx", () => {
    const m = aeMembers(LIB);
    for (const name of ["run", "comp", "layer", "trim", "setText", "key", "snap", "dump", "str"]) expect(m.has(name)).toBe(true);
  });

  it("rejects an unknown member and suggests the closest one", () => {
    const [f] = errorsOf('AE.setTxt(L, "x");');
    expect(f.msg).toContain("AE.setTxt does not exist");
    expect(f.msg).toContain("did you mean AE.setText?");
  });

  it("accepts members the script adds itself", () => {
    expect(lint("AE.myHelper = function () {}; AE.myHelper();", LIB)).toEqual([]);
  });

  it("only warns when other files are included (they may add members)", () => {
    expect(levels('#include "extra.jsx"\nAE.fromExtra();')).toEqual(["warning"]);
  });

  it("skips the check when the script declares its own AE", () => {
    expect(lint("var AE = {}; AE.anything();", LIB)).toEqual([]);
  });

  it("knows every AE.* used in the docs and tests", () => {
    const m = aeMembers(LIB);
    const typoExamples = new Set(["setTxt"]); // the docs show it as the lint's "did you mean" example
    for (const f of ["skills/after-effects/SKILL.md", "README.md", "AGENTS.md", "tests/selftest.jsx", "tests/cleanup.jsx"]) {
      for (const [, name] of readFileSync(path.join(ROOT, f), "utf8").matchAll(/\bAE\.([A-Za-z_$][\w$]*)/g)) {
        if (typoExamples.has(name)) continue;
        expect(m.has(name), `AE.${name} in ${f}`).toBe(true);
      }
    }
  });
});

describe("the toolkit's own scripts", () => {
  it.each(["lib.jsx", "tests/selftest.jsx", "tests/cleanup.jsx"])("%s has no errors or warnings", (f) => {
    const { errors, warnings } = check(readFileSync(path.join(ROOT, f), "utf8"), f, LIB);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("check / prep", () => {
  it("reports syntax errors with the line", () => {
    const { errors } = check("var a = 1;\nvar b = (1 + ;\n", "x.jsx", LIB);
    expect(errors).toEqual(["x.jsx:2: SYNTAX Unexpected token\n    var b = (1 + ;"]);
  });

  it("formats errors with the source line", () => {
    expect(check("let a = 1;", "x.jsx", LIB).errors).toEqual(["x.jsx:1: ERROR let (ES6): use var\n    let a = 1;"]);
  });

  it("strips #include of this lib.jsx and makes other includes absolute", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aectl-"));
    const input = path.join(dir, "s.jsx");
    const output = path.join(dir, "s.prep.jsx");
    writeFileSync(input, `#include "${LIB}"\n#include "helper.jsx"\n#target aftereffects\nlog(1);\n`);
    expect(prep(input, output, LIB, false)).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(`\n#include "${path.join(dir, "helper.jsx")}"\n#target aftereffects\nlog(1);\n`);
  });

  it("refuses to write a script with errors", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aectl-"));
    const input = path.join(dir, "bad.jsx");
    writeFileSync(input, "let a = 1;\n");
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(prep(input, path.join(dir, "out.jsx"), LIB)).toBe(false);
    } finally {
      process.stderr.write = write;
    }
  });

  it("tells expressions from statements (ae eval logs an expression's value)", () => {
    expect(isExpr('AE.comp("Main").numLayers')).toBe(true);
    expect(isExpr("1 + 2")).toBe(true);
    expect(isExpr("var c = 1; log(c);")).toBe(false);
  });
});
