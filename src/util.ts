// Small helpers shared by every command: errors with exit codes, process spawning, paths.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** An error that ends the CLI with `code` after printing `message` (already prefixed with "ae: " where wanted). */
export class Exit extends Error {
  code: number;
  constructor(code: number, message = "") {
    super(message);
    this.code = code;
  }
}

/** Usage/argument error: "ae: <msg>" on stderr, exit 2. */
export function die(msg: string): never {
  throw new Exit(2, "ae: " + msg);
}

export function err(msg: string): void {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
}

export function out(msg: string): void {
  process.stdout.write(msg.endsWith("\n") ? msg : msg + "\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a program synchronously; returns status (-1 if it could not start), stdout and stderr as text. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    status: r.error ? -1 : (r.status ?? -1),
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? (r.error ? r.error.message : "")),
  };
}

const whichCache = new Map<string, boolean>();
export function has(cmd: string): boolean {
  if (!whichCache.has(cmd)) {
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    whichCache.set(cmd, dirs.some((d) => d && isFile(path.join(d, cmd))));
  }
  return whichCache.get(cmd)!;
}

export function need(cmd: string): void {
  if (!has(cmd)) die(cmd + " not found");
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

/** Absolute path without resolving symlinks or `..` (like the bash version: $PWD/rel). */
export function abspath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** JS string literal that survives any file encoding: JSON with everything above 0x7e escaped. */
export function jsstr(s: string): string {
  return JSON.stringify(String(s)).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Replace every character outside `allowed` (a regex character class body) with "_". */
export function safeChars(s: string, allowed: string): string {
  return s.replace(new RegExp("[^" + allowed + "]", "g"), "_");
}

export function basenameNoExt(p: string): string {
  const b = path.basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}
