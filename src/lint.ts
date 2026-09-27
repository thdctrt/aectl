// Syntax check and ExtendScript lint for .jsx files, run before anything is sent to AE: a syntax error in AE opens a
// modal dialog that blocks every later call.
//
// The source is parsed with a modern parser (acorn, latest ECMAScript) and the AST is checked against what the
// ExtendScript engine in AE 2026 (26.5) actually accepts. Verified with eval() inside AE:
//   rejected (syntax): let, =>, `template`, class, spread/rest, destructuring, default params, for...of, ?. ??, **,
//     async/await, generators, getters/setters, shorthand/computed/method properties, regex flags other than gim,
//     catch without a binding, const in a for(...) header, future reserved words as names (short, int, static, ...),
//     reserved words as unquoted object keys ({in: 1}, {static: 1}).
//   accepted: trailing commas, const (reassignment is silently ignored), reserved words after a dot (o.in, o.class),
//     `let` / `yield` as plain names, labels, debugger, Date.now.
//   undefined at runtime: JSON, Function.prototype.bind, Object.keys & co, Array.isArray, [].indexOf/forEach/map...,
//     "".trim & co.
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { exists } from "./util.ts";

type Node = acorn.Node & Record<string, any>;

export interface Finding {
  line: number;
  level: "error" | "warning";
  msg: string;
}

export interface CheckResult {
  errors: string[]; // formatted, ready to print
  warnings: string[];
}

/** Preprocessor lines ExtendScript understands; blanked (keeping line numbers) before parsing. */
const PRE = /^\s*(#|\/\/@)(include|includepath|target|targetengine|script|strict|engine)\b/;
const INCLUDE = /^\s*(#|\/\/@)include\s+["']?([^"']+?)["']?\s*;?\s*$/;

const KEYWORDS = new Set(
  "break case catch continue debugger default delete do else finally for function if in instanceof new return switch this throw try typeof var void while with null true false".split(" "),
);
/** ES3 future reserved words: ExtendScript rejects them as names ("Illegal use of reserved word"). */
const FUTURE = new Set(
  "abstract boolean byte char class const double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile".split(" "),
);

const ES5_METHODS: Record<string, string> = {
  forEach: "a for loop", map: "a for loop", filter: "a for loop", reduce: "a for loop", reduceRight: "a for loop",
  some: "a for loop", every: "a for loop", find: "a for loop", findIndex: "a for loop", includes: "indexOf on strings, a loop on arrays",
  startsWith: "s.indexOf(x) === 0", endsWith: "s.slice(-x.length) === x", trim: 's.replace(/^\\s+|\\s+$/g, "")',
  trimStart: 's.replace(/^\\s+/, "")', trimEnd: 's.replace(/\\s+$/, "")', padStart: "a while loop", padEnd: "a while loop",
  repeat: "a loop", bind: "a closure: var self = this; function () { self.f(); }",
};
const OBJECT_STATICS = new Set(["keys", "assign", "entries", "values", "create", "defineProperty", "defineProperties", "freeze", "getPrototypeOf", "getOwnPropertyNames", "fromEntries"]);
const ARRAY_STATICS = new Set(["isArray", "from", "of"]);
const PROJECT_CALLS = new Set(["save", "saveWithDialog", "close"]);
const APP_CALLS = new Set(["quit", "newProject", "open"]);

// ------------------------------------------------------------------------------------------ AE namespace members

let libMembers: Set<string> | null = null;
/** Every `A.name = ...` in lib.jsx (the AE namespace is built as `var AE = (function () { var A = {}; ... })()`). */
export function aeMembers(libPath: string): Set<string> {
  if (libMembers) return libMembers;
  const names = new Set<string>();
  try {
    const ast = acorn.parse(blankPreprocessor(readFileSync(libPath, "utf8")), { ecmaVersion: "latest", allowReturnOutsideFunction: true });
    walk.simple(ast, {
      AssignmentExpression(n: Node) {
        const l = n.left;
        if (l.type === "MemberExpression" && !l.computed && l.object.type === "Identifier" && l.object.name === "A") names.add(l.property.name);
      },
    });
  } catch {
    // unreadable lib: the member check is skipped (empty set disables it below)
  }
  libMembers = names;
  return names;
}

function suggest(name: string, pool: Set<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const cand of pool) {
    if (cand.startsWith("_")) continue;
    const d = cand.toLowerCase() === name.toLowerCase() ? 0 : distance(name, cand);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ------------------------------------------------------------------------------------------ lint

export function blankPreprocessor(src: string): string {
  return src
    .split("\n")
    .map((l) => (PRE.test(l) ? "" : l))
    .join("\n");
}

/**
 * Lint ExtendScript source. `libPath` enables the AE.* member check.
 * Returns findings, or a single syntax error (level "error", msg starting with "SYNTAX").
 */
export function lint(src: string, libPath?: string): Finding[] {
  const hasOtherIncludes = src.split("\n").some((l) => {
    const m = INCLUDE.exec(l);
    return m !== null && path.basename(m[2]) !== "lib.jsx";
  });
  const code = blankPreprocessor(src);
  let ast: Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: false, locations: true }) as Node;
  } catch (e) {
    const se = e as SyntaxError & { loc?: { line: number; column: number } };
    const msg = String(se.message).replace(/\s*\(\d+:\d+\)$/, "");
    return [{ line: se.loc?.line ?? 1, level: "error", msg: "SYNTAX " + msg }];
  }

  const found: Finding[] = [];
  const at = (n: Node, level: Finding["level"], msg: string) => found.push({ line: n.loc!.start.line, level, msg });

  // what the script defines itself: polyfills, its own JSON, its own AE members, a shadowed AE
  const assignedProto = new Set<string>(); // "Array.prototype.forEach" -> "forEach"
  const assignedStatic = new Set<string>(); // "Object.keys"
  const aeAssigned = new Set<string>();
  const declared = new Set<string>();
  const arrayVars = new Set<string>();
  const forHeaderConst = new Set<Node>();
  walk.full(ast, (n: Node) => {
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && !n.left.computed) {
      const l = n.left;
      const obj = l.object;
      if (obj.type === "MemberExpression" && !obj.computed && obj.property.name === "prototype") assignedProto.add(l.property.name);
      if (obj.type === "Identifier") {
        assignedStatic.add(obj.name + "." + l.property.name);
        if (obj.name === "AE") aeAssigned.add(l.property.name);
      }
    }
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") declared.add(n.left.name);
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier") {
      declared.add(n.id.name);
      if (n.init && isArrayish(n.init)) arrayVars.add(n.id.name);
    }
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression") && n.id) declared.add(n.id.name);
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      for (const p of n.params) if (p.type === "Identifier") declared.add(p.name);
    }
    if (n.type === "ForStatement" && n.init?.type === "VariableDeclaration" && n.init.kind === "const") forHeaderConst.add(n.init);
    if ((n.type === "ForInStatement" || n.type === "ForOfStatement") && n.left.type === "VariableDeclaration" && n.left.kind === "const") forHeaderConst.add(n.left);
  });
  const members = libPath && !declared.has("AE") ? aeMembers(libPath) : new Set<string>();

  walk.full(ast, (n: Node) => {
    switch (n.type) {
      case "ArrowFunctionExpression":
        return at(n, "error", "arrow function (ES6): use function (x) { return ...; }");
      case "TemplateLiteral":
        return at(n, "error", 'template literal (ES6): use "a" + b');
      case "ClassDeclaration":
      case "ClassExpression":
        return at(n, "error", "class (ES6): use a constructor function and its prototype");
      case "SpreadElement":
        return at(n, "error", "spread ... (ES6): use f.apply(null, arr) or arr.concat(other)");
      case "RestElement":
        return at(n, "error", "rest parameter ... (ES6): use arguments");
      case "ForOfStatement":
        return at(n, "error", "for...of (ES6): use for (var i = 0; i < a.length; i++)");
      case "ChainExpression":
        return at(n, "error", "optional chaining ?. (ES2020): test for null explicitly");
      case "AwaitExpression":
        return at(n, "error", "await: not in ExtendScript");
      case "YieldExpression":
        return at(n, "error", "yield (ES6 generator): not in ExtendScript");
      case "ObjectPattern":
      case "ArrayPattern":
        return at(n, "error", "destructuring (ES6): assign each value separately");
      case "AssignmentPattern":
        return at(n, "error", "default parameter value (ES6): use if (x === undefined) { x = ...; }");
      case "MetaProperty":
      case "ImportExpression":
        return at(n, "error", n.type === "MetaProperty" ? "new.target / import.meta: not in ExtendScript" : "import(): not in ExtendScript");
      case "CatchClause":
        if (!n.param) at(n, "error", "catch without a binding (ES2019): write catch (e)");
        return;
      case "VariableDeclaration":
        if (n.kind === "let") at(n, "error", "let (ES6): use var");
        else if (n.kind === "const") {
          if (forHeaderConst.has(n)) at(n, "error", "const in a for (...) header is a syntax error in ExtendScript: use var");
          else at(n, "warning", "const works in ExtendScript, but reassigning it is silently ignored: prefer var");
        }
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
        if (n.async) at(n, "error", "async function: not in ExtendScript");
        if (n.generator) at(n, "error", "generator function* (ES6): not in ExtendScript");
        return;
      case "BinaryExpression":
        if (n.operator === "**") at(n, "error", "** (ES2016): use Math.pow(a, b)");
        else if (n.operator === "+" && ((isStringy(n.left) && isVector(n.right)) || (isStringy(n.right) && isVector(n.left))))
          at(n, "warning", '"text" + an array value throws "invalid numeric result" in ExtendScript (+ is overloaded for arrays): use AE.str(v) or v.join(",")');
        return;
      case "LogicalExpression":
        if (n.operator === "??") at(n, "error", "?? (ES2020): use (x !== undefined && x !== null ? x : y)");
        return;
      case "AssignmentExpression":
        if (n.operator === "**=") at(n, "error", "**= (ES2016): use x = Math.pow(x, y)");
        else if (n.operator === "??=" || n.operator === "||=" || n.operator === "&&=") at(n, "error", n.operator + " (ES2021): write the assignment out");
        return;
      case "Literal":
        if (n.regex && /[^gim]/.test(n.regex.flags)) at(n, "error", "regex flag /" + n.regex.flags.replace(/[gim]/g, "") + " (ES6+): ExtendScript knows only g, i, m");
        else if (n.bigint !== undefined) at(n, "error", "BigInt literal: not in ExtendScript");
        else if (typeof n.value === "number" && typeof n.raw === "string" && n.raw.includes("_")) at(n, "error", "numeric separator 1_000 (ES2021): write 1000");
        return;
      case "Identifier":
        if (FUTURE.has(n.name)) at(n, "error", `'${n.name}' is a reserved word in ExtendScript ("Illegal use of reserved word"): rename it`);
        else if (n.name === "JSON" && !declared.has("JSON") && !hasOtherIncludes) at(n, "warning", "JSON is undefined in ExtendScript: use AE.str(v) to turn values into text");
        return;
      case "ObjectExpression":
        for (const p of n.properties as Node[]) {
          if (p.type !== "Property") continue;
          if (p.kind === "get" || p.kind === "set") at(p, "error", "getter/setter in an object literal: not in ExtendScript");
          else if (p.method) at(p, "error", "method shorthand (ES6): write name: function () { ... }");
          else if (p.shorthand) at(p, "error", `shorthand property {${p.key.name}} (ES6): write {${p.key.name}: ${p.key.name}}`);
          else if (p.computed) at(p, "error", "computed key [k] (ES6): create the object, then set o[k] = v");
          else if (p.key.type === "Identifier" && (KEYWORDS.has(p.key.name) || FUTURE.has(p.key.name)))
            at(p, "error", `reserved word as an object key ("Illegal use of reserved word"): quote it: {"${p.key.name}": ...}`);
        }
        return;
      case "MemberExpression":
        return memberRules(n);
      case "CallExpression":
        return callRules(n);
    }
  });

  function memberRules(n: Node) {
    if (n.computed || n.property.type !== "Identifier") return;
    const prop: string = n.property.name;
    const obj = n.object;
    if (KEYWORDS.has(prop) || FUTURE.has(prop)) {
      at(n, "warning", `reserved word after a dot (.${prop}) works in AE 2026 but is a syntax error in older versions: o["${prop}"] works everywhere`);
    }
    if (obj.type === "Identifier" && obj.name === "AE" && members.size > 0 && !members.has(prop) && !aeAssigned.has(prop)) {
      const s = suggest(prop, members);
      at(n, hasOtherIncludes ? "warning" : "error", `AE.${prop} does not exist in lib.jsx` + (s ? ` (did you mean AE.${s}?)` : "") + ": see the API section of SKILL.md");
    }
    if (obj.type === "Identifier" && obj.name === "Object" && OBJECT_STATICS.has(prop) && !assignedStatic.has("Object." + prop)) {
      at(n, "warning", `Object.${prop} is undefined in ExtendScript: use a for (var k in o) loop`);
    }
    if (obj.type === "Identifier" && obj.name === "Array" && ARRAY_STATICS.has(prop) && !assignedStatic.has("Array." + prop)) {
      at(n, "warning", `Array.${prop} is undefined in ExtendScript` + (prop === "isArray" ? ": use v instanceof Array" : ""));
    }
  }

  function callRules(n: Node) {
    const c = n.callee;
    if (c.type !== "MemberExpression" || c.computed || c.property.type !== "Identifier") return;
    const prop: string = c.property.name;
    const obj = c.object;
    if (prop === "executeCommand") return at(n, "error", "app.executeCommand is forbidden: menu commands can open dialogs and act on whatever is selected (pitfall 2)");
    const isAE = obj.type === "Identifier" && (obj.name === "AE" || obj.name === "A");
    if (!isAE && Object.prototype.hasOwnProperty.call(ES5_METHODS, prop) && !assignedProto.has(prop)) {
      at(n, "warning", `.${prop}() is undefined in ExtendScript (ES5+): use ${ES5_METHODS[prop]}`);
    }
    if ((prop === "indexOf" || prop === "lastIndexOf") && !assignedProto.has(prop) && (isArrayish(obj) || (obj.type === "Identifier" && arrayVars.has(obj.name)))) {
      at(n, "warning", `Array ${prop}() is undefined in ExtendScript (strings have it, arrays don't): use a for loop`);
    }
    if (obj.type === "MemberExpression" && !obj.computed && obj.object.type === "Identifier" && obj.object.name === "app" && obj.property.name === "project" && PROJECT_CALLS.has(prop)) {
      at(n, "warning", `app.project.${prop}() saves/closes the project: only when the user asked (use ae save)`);
    }
    if (obj.type === "Identifier" && obj.name === "app" && APP_CALLS.has(prop)) at(n, "warning", `app.${prop}() closes or replaces the project`);
  }

  // one finding per line and message, in line order
  const seen = new Set<string>();
  return found
    .filter((f) => {
      const k = f.line + "\0" + f.msg;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.line - b.line || (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

/** A string literal, or a + chain that contains one. */
function isStringy(n: Node): boolean {
  if (n.type === "Literal") return typeof n.value === "string";
  return n.type === "BinaryExpression" && n.operator === "+" && (isStringy(n.left) || isStringy(n.right));
}

// Properties whose value is always an array: transform vectors, shape sizes/positions, colours.
const VECTOR_PROPS = new Set(["position", "anchorPoint", "scale", "orientation", "pointOfInterest"]);
const VECTOR_TF = new Set(["pos", "position", "anchor", "anchorPoint", "scale", "ADBE Position", "ADBE Anchor Point", "ADBE Scale"]);
const VECTOR_NAME = /^(ADBE (Position|Anchor Point|Scale|Orientation)|Position|Anchor Point|Scale|Color)$|(Rect|Ellipse|Star) (Size|Position)$|Color$/i;
const VECTOR_TEXT = new Set(["fillColor", "strokeColor", "boxTextSize", "boxTextPos"]);

/** An expression that reads one of those properties' values (`.value`, `.valueAtTime()`, `.keyValue()`), or a TextDocument colour/box. */
function isVector(n: Node): boolean {
  if (n.type === "MemberExpression" && !n.computed) {
    if (VECTOR_TEXT.has(n.property.name)) return true;
    return n.property.name === "value" && isVectorProp(n.object);
  }
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed)
    return (n.callee.property.name === "valueAtTime" || n.callee.property.name === "keyValue") && isVectorProp(n.callee.object);
  return false;
}

function isVectorProp(n: Node): boolean {
  if (n.type === "MemberExpression" && !n.computed) return VECTOR_PROPS.has(n.property.name);
  if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.computed) return false;
  const arg = n.arguments[n.arguments.length - 1];
  if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") return false;
  const fn: string = n.callee.property.name;
  if (fn === "tf") return VECTOR_TF.has(arg.value);
  return (fn === "property" || fn === "findProp") && VECTOR_NAME.test(arg.value) && !/^[XYZ] Position$/i.test(arg.value);
}

function isArrayish(n: Node): boolean {
  if (n.type === "ArrayExpression") return true;
  if (n.type === "NewExpression" && n.callee.type === "Identifier" && n.callee.name === "Array") return true;
  // "a,b".split(",") / arr.concat(x) / arr.slice() on a known array literal
  return n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.name === "split";
}

/** Findings formatted like `label:12: ERROR msg` + the source line; errors and warnings separately. */
export function check(src: string, label: string, libPath?: string): CheckResult {
  const lines = src.split("\n");
  const res: CheckResult = { errors: [], warnings: [] };
  for (const f of lint(src, libPath)) {
    const text = (lines[f.line - 1] ?? "").trim().slice(0, 160);
    const kind = f.msg.startsWith("SYNTAX ") ? "SYNTAX" : f.level === "error" ? "ERROR" : "warning";
    const msg = kind === "SYNTAX" ? f.msg.slice(7) : f.msg;
    (f.level === "error" ? res.errors : res.warnings).push(`${label}:${f.line}: ${kind} ${msg}\n    ${text}`);
  }
  return res;
}

/**
 * Check `input`, print warnings/errors to stderr, and write the runnable version to `output`: `#include` of this
 * lib.jsx removed (the runner prepends it), other includes made absolute. Returns false on errors (nothing written).
 */
export function prep(input: string, output: string, libPath: string, showWarnings = true): boolean {
  const src = readFileSync(input, "utf8").replace(/^﻿/, "");
  const { errors, warnings } = check(src, path.basename(input), libPath);
  if (showWarnings) for (const w of warnings) process.stderr.write(w + "\n");
  if (errors.length) {
    for (const e of errors) process.stderr.write(e + "\n");
    return false;
  }
  const dir = path.dirname(path.resolve(input));
  const res = src
    .split("\n")
    .map((l) => {
      const m = INCLUDE.exec(l);
      if (!m) return l;
      const p = path.isAbsolute(m[2]) ? m[2] : path.resolve(dir, m[2]);
      if (path.basename(p) === "lib.jsx" && (p === libPath || (exists(p) && realpathSync(p) === realpathSync(libPath)))) return "";
      return '#include "' + p + '"';
    })
    .join("\n");
  writeFileSync(output, res);
  return true;
}

/** True when `code` is a single expression (ae eval then logs its value). */
export function isExpr(code: string): boolean {
  try {
    new vm.Script("(function(){return (" + code + "\n)})");
    return true;
  } catch {
    return false;
  }
}

/**
 * The script `ae eval` runs. Like a REPL, it logs the value of a single expression, or of the last statement when
 * that is an expression or a top-level `return x` (the runner wraps the code in a function). Line numbers are kept.
 */
export function evalScript(code: string): string {
  const show = (expr: string) => `var __r = (${expr}); if (__r !== undefined) { log(__r); }`;
  if (isExpr(code)) return show(code + "\n") + "\n";
  let body: Node[];
  try {
    body = (acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true }) as Node).body;
  } catch {
    return code + "\n"; // the lint reports the syntax error
  }
  const last = body[body.length - 1];
  let expr: Node | null = null;
  if (last?.type === "ExpressionStatement" && !last.directive) expr = last.expression;
  else if (last?.type === "ReturnStatement" && last.argument) expr = last.argument;
  if (!expr) return code + "\n";
  return code.slice(0, last.start) + show(code.slice(expr.start, expr.end)) + code.slice(last.end) + "\n";
}
