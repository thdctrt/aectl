// Minimal option parser: options may appear anywhere; everything else is positional.
import { die } from "./util.ts";

export interface Parsed {
  opts: Record<string, string | true>;
  pos: string[];
}

/**
 * `values`: options that take the next argument; `flags`: boolean options.
 * `unknown` decides what an unrecognised "-x" does (default: "<cmd>: unknown option -x", exit 2).
 */
export function parseArgs(argv: string[], cmd: string, values: string[] = [], flags: string[] = [], unknown?: (opt: string) => never): Parsed {
  const opts: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (values.includes(a)) {
      if (i + 1 >= argv.length) die(`${cmd}: ${a} needs a value`);
      opts[a] = argv[++i];
    } else if (flags.includes(a)) {
      opts[a] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      if (unknown) unknown(a);
      die(`${cmd}: unknown option ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

export function str(p: Parsed, name: string, dflt = ""): string {
  const v = p.opts[name];
  return typeof v === "string" ? v : dflt;
}

/** A whole number option; dies with a clear message when it is not one. */
export function int(p: Parsed, name: string, dflt: number): number {
  const v = p.opts[name];
  if (typeof v !== "string") return dflt;
  if (!/^-?\d+$/.test(v)) die(`${name} must be a whole number, got '${v}'`);
  return parseInt(v, 10);
}
