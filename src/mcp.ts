// ae mcp: a Model Context Protocol server on stdin/stdout for clients without a shell (Claude Desktop chat, other
// agents). No dependencies and no network: newline-delimited JSON-RPC 2.0. Every tool runs the same CLI in a child
// process (stdout here is the protocol channel), one call at a time, since AE runs one script at a time.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { TOOLS, WORK } from "./env.ts";
import { err } from "./util.ts";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_IMAGES = 6;

type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  props: Record<string, Schema>;
  required?: string[];
  readOnly?: boolean;
  destructive?: boolean;
  /** CLI arguments for this call, or the finished text result */
  argv: (a: Args) => string[] | { text: string };
  /** images to attach, from the command's stdout lines */
  images?: (stdout: string[]) => string[];
}

const S = (description: string): Schema => ({ type: "string", description });
const N = (description: string): Schema => ({ type: "number", description });
const B = (description: string): Schema => ({ type: "boolean", description });
const RES: Schema = { type: "string", enum: ["full", "half", "third", "quarter"], description: "render resolution (default half)" };
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
/** `--flag value` when the value is set */
const opt = (flag: string, v: unknown) => (v === undefined || v === null || v === "" ? [] : [flag, String(v)]);
const flag = (f: string, v: unknown) => (v ? [f] : []);
const prefixed = (prefix: string) => (lines: string[]) => lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
const pngLines = (lines: string[]) => lines.filter((l) => l.endsWith(".png") && path.isAbsolute(l));

/** Scripts passed as text are written to <WORK>/mcp/<name>.jsx (their log lands next to them). */
function scriptFile(code: string, name: unknown, dflt: string): string {
  const dir = path.join(WORK, "mcp");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, (s(name).replace(/[^A-Za-z0-9_-]+/g, "_") || dflt) + ".jsx");
  writeFileSync(f, code);
  return f;
}

function docs(): string {
  const md = readFileSync(path.join(TOOLS, "skills", "after-effects", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return (
    "In this MCP server every `ae <command>` of the reference below is a tool (ae_run runs a script, ae_snap renders frames, ...). " +
    "Paths in results are on the user's Mac.\n\n" +
    md
  );
}

export const TOOLS_LIST: Tool[] = [
  {
    name: "ae_docs",
    title: "After Effects reference",
    description: "The full reference: the AE.* ExtendScript API, the ES3 rules the lint enforces, and the After Effects pitfalls. Read it once before writing a script.",
    props: {},
    readOnly: true,
    argv: () => ({ text: docs() }),
  },
  {
    name: "ae_selection",
    title: "Selection and playhead",
    description: "What the user has selected in After Effects: the active comp, its playhead frame and work area, the selected layers, properties and keyframes, and the Project panel selection.",
    props: {},
    readOnly: true,
    argv: () => ["sel"],
  },
  {
    name: "ae_tree",
    title: "Project overview",
    description: "Every comp (folder, size, fps, duration, layers), then the layers of the active comp or of `main`.",
    props: { main: S("comp whose layers to list (default: the active comp)") },
    readOnly: true,
    argv: (a) => ["tree", ...opt("--main", a.main)],
  },
  {
    name: "ae_dump",
    title: "Comp details",
    description: "One comp in detail: layers with timing, transforms, text, effects with their values, every keyframe with its easing, expressions and their errors, markers.",
    props: {
      comp: S("comp name"),
      layer: S("only this layer"),
      depth: N("recurse this many levels into precomps"),
      at: N("comp frame for the values (default: the playhead)"),
      props: B("also every changed static value (shape contents, masks, text animators, layer styles)"),
      keys: B("include keyframes (default true)"),
      max_keys: N("keyframes shown per property (default 30)"),
      raw_text: B("read expression-driven Source Text raw (one undo step)"),
    },
    required: ["comp"],
    readOnly: true,
    argv: (a) => [
      "dump",
      s(a.comp),
      ...opt("--layer", a.layer),
      ...opt("--depth", a.depth),
      ...opt("--at", a.at),
      ...flag("--props", a.props),
      ...flag("--no-keys", a.keys === false),
      ...opt("--max-keys", a.max_keys),
      ...flag("--raw-text", a.raw_text),
    ],
  },
  {
    name: "ae_snap",
    title: "Render frames",
    description: "Render comp frames to PNG and return them as images (as one labelled contact sheet by default). Frames are comp frames: '8,44,90' or '0-120:30'.",
    props: {
      comp: S("comp name"),
      frames: S("frame list: 8,44,90 or 0-120:30"),
      res: RES,
      crop: S("x,y,w,h in comp pixels: a close-up of one region"),
      sheet: B("one contact sheet instead of separate images (default true)"),
      cols: N("sheet columns (default 4)"),
      width: N("sheet cell width in px (default 640)"),
    },
    required: ["comp", "frames"],
    readOnly: true,
    argv: (a) => ["snap", s(a.comp), s(a.frames), ...opt("--res", a.res), ...opt("--crop", a.crop), ...flag("--sheet", a.sheet !== false), ...opt("--cols", a.cols), ...opt("--width", a.width)],
    images: (l) => {
      const sheet = prefixed("SHEET ")(l);
      return sheet.length ? sheet : pngLines(l);
    },
  },
  {
    name: "ae_run",
    title: "Run a script",
    description:
      "Lint and run ExtendScript in After Effects as one undo step (the AE.* library is preloaded; ES3 only, see ae_docs). log(...) output comes back. " +
      "A run that throws is rolled back. Afterwards expression errors in the comps it touched are reported. diff: also report what changed in the project.",
    props: {
      code: S("the script (ExtendScript, ES3)"),
      file: S("or: path of a .jsx file to run"),
      name: S("script name, used for the undo step and the file (default mcp_script)"),
      readonly: B("no undo group (for scripts that only read)"),
      diff: B("print what the script changed in the project (slow on big projects)"),
      ab_comp: S("render before/after frames of this comp as one sheet (needs ab_frames)"),
      ab_frames: S("frames for ab_comp: 0,60,120"),
    },
    destructive: true,
    argv: (a) => {
      const file = a.code !== undefined ? scriptFile(s(a.code), a.name, "mcp_script") : s(a.file);
      return ["run", file, ...flag("--ro", a.readonly), ...flag("--diff", a.diff), ...opt("--ab", a.ab_comp), ...opt("--frames", a.ab_frames)];
    },
    images: prefixed("SHEET "),
  },
  {
    name: "ae_eval",
    title: "Evaluate",
    description: "Run a one-liner in After Effects: the value of the last expression is returned (AE.comp(\"Main\").numLayers).",
    props: { code: S("ExtendScript expression or statements"), readonly: B("no undo group") },
    required: ["code"],
    destructive: true,
    argv: (a) => ["eval", s(a.code), ...flag("--ro", a.readonly)],
  },
  {
    name: "ae_check",
    title: "Lint a script",
    description: "Syntax and ExtendScript (ES3) lint without running anything.",
    props: { code: S("the script"), file: S("or: path of a .jsx file") },
    readOnly: true,
    argv: (a) => ["check", a.code !== undefined ? scriptFile(s(a.code), "check", "check") : s(a.file)],
  },
  {
    name: "ae_markers",
    title: "Read markers",
    description: "Comp and layer markers with their comments, by frame. Users leave notes to the agent as markers.",
    props: { comp: S("comp name (default: the active comp)"), all: B("every comp in the project") },
    readOnly: true,
    argv: (a) => ["markers", ...(a.comp ? [s(a.comp)] : []), ...flag("--all", a.all)],
  },
  {
    name: "ae_mark",
    title: "Add a marker",
    description: "Add a comp marker (or a layer marker) with a comment, e.g. to point the user at a change. Undoable.",
    props: { comp: S("comp name"), frame: N("comp frame"), comment: S("marker text"), layer: S("put it on this layer"), duration: N("length in frames"), label: N("label colour 0-16") },
    required: ["comp", "frame", "comment"],
    argv: (a) => ["mark", s(a.comp), s(a.frame), s(a.comment), ...opt("--layer", a.layer), ...opt("--dur", a.duration), ...opt("--label", a.label)],
  },
  {
    name: "ae_health",
    title: "Project health",
    description: "Missing footage and fonts, expression errors, layers never visible or off screen, text crossing the frame edge (or a safe margin).",
    props: { comp: S("comp to check (default: the active comp)"), all: B("check every comp"), safe: N("safe margin in % of each side for text") },
    readOnly: true,
    argv: (a) => ["health", ...(a.comp ? [s(a.comp)] : []), ...flag("--all", a.all), ...opt("--safe", a.safe)],
  },
  {
    name: "ae_find",
    title: "Search the project",
    description: "Find text in item and layer names, text layers, expressions, footage paths, effects and marker comments.",
    props: { query: S("text to find (case-insensitive)"), scopes: S("comma list of name,text,expr,file,effect,marker (default all)"), comp: S("only this comp"), regex: B("query is a regular expression") },
    required: ["query"],
    readOnly: true,
    argv: (a) => ["find", s(a.query), ...opt("--in", a.scopes), ...opt("--comp", a.comp), ...flag("--regex", a.regex)],
  },
  {
    name: "ae_effects",
    title: "Search effects",
    description: "Installed effects matching all words (display name, matchName, category). AE.addEffect(layer, matchName) takes either name.",
    props: { query: S("words to match, e.g. 'blur'"), refresh: B("re-read the list from AE (after installing plugins)") },
    readOnly: true,
    argv: (a) => ["effects", ...s(a.query).split(/\s+/).filter(Boolean), ...flag("--refresh", a.refresh)],
  },
  {
    name: "ae_graph",
    title: "Motion graph",
    description: "Value and speed curves of an animated property as an image, plus per-segment numbers (peak speed and where it falls between keys, peak/avg as a measure of the easing).",
    props: {
      comp: S("comp name"),
      layer: S("layer name or index"),
      prop: S("property path: 'Transform/Position', 'Effects/Gaussian Blur/Blurriness', or an alias: pos, scale, rot, opacity"),
      from: N("first frame (default: first key - 5)"),
      to: N("last frame (default: last key + 5)"),
      step: N("sample every N frames (default 0.5)"),
    },
    required: ["comp", "layer", "prop"],
    readOnly: true,
    argv: (a) => ["graph", s(a.comp), s(a.layer), s(a.prop), ...opt("--from", a.from), ...opt("--to", a.to), ...opt("--step", a.step)],
    images: prefixed("GRAPH "),
  },
  {
    name: "ae_measure",
    title: "Measure an image",
    description: "Ink bounding box, centre and mean colour of a PNG (e.g. a snap); with a second image, how far and in which direction it is off.",
    props: { image: S("PNG path"), other: S("second PNG to compare with (scaled to the first)"), box: S("x,y,w,h: only this region"), bg: S("background colour #RRGGBB (default: alpha or the corner colour)") },
    required: ["image"],
    readOnly: true,
    argv: (a) => ["measure", s(a.image), ...(a.other ? [s(a.other)] : []), ...opt("--box", a.box), ...opt("--bg", a.bg)],
  },
  {
    name: "ae_beats",
    title: "Detect beats",
    description: "Music accents (onsets) of an audio layer in the comp's frames, strongest = 1; optionally as markers on that layer.",
    props: {
      comp: S("comp name"),
      layer: S("the audio layer"),
      from: N("first comp frame"),
      to: N("last comp frame"),
      top: N("keep only the N strongest"),
      min_gap: N("frames between accents at least (default 3)"),
      mark: B("add a marker 'beat <strength>' at each accent on the layer (undoable)"),
    },
    required: ["comp", "layer"],
    argv: (a) => ["beats", s(a.comp), "--layer", s(a.layer), ...opt("--from", a.from), ...opt("--to", a.to), ...opt("--top", a.top), ...opt("--min-gap", a.min_gap), ...flag("--mark", a.mark)],
  },
  {
    name: "ae_export",
    title: "Export a video",
    description:
      "Render a comp and encode it for a destination (presets: youtube-1080, youtube-4k, shorts, square, web, prores, prores-alpha, webm-alpha, gif). " +
      "Default range: the work area. AE is busy until the render is done.",
    props: {
      comp: S("comp name"),
      preset: S("preset (default youtube-1080)"),
      out: S("output file (default ./<comp>_<preset>.<ext>)"),
      from: N("first comp frame"),
      to: N("last comp frame"),
      full: B("the whole comp instead of the work area"),
      fit: { type: "string", enum: ["pad", "crop"], description: "when the aspect differs: letterbox (default) or fill" },
      force: B("overwrite an existing file"),
    },
    required: ["comp"],
    argv: (a) => ["export", s(a.comp), ...opt("--preset", a.preset), ...opt("--out", a.out), ...opt("--from", a.from), ...opt("--to", a.to), ...flag("--full", a.full), ...opt("--fit", a.fit), ...flag("--force", a.force)],
  },
  {
    name: "ae_probe",
    title: "Probe a video",
    description: "Size, fps (flags variable frame rate), duration, frame count and audio of a video file.",
    props: { file: S("video file"), fps: N("also the length in comp frames at this rate") },
    required: ["file"],
    readOnly: true,
    argv: (a) => ["probe", s(a.file), ...opt("--fps", a.fps)],
  },
  {
    name: "ae_frames",
    title: "Sample a video",
    description: "A contact sheet of evenly spaced frames from a video file (to pick clip times), returned as an image.",
    props: { file: S("video file"), n: N("number of frames (default 12)"), from: N("start, seconds"), to: N("end, seconds") },
    required: ["file"],
    readOnly: true,
    argv: (a) => ["frames", s(a.file), ...opt("--n", a.n), ...opt("--from", a.from), ...opt("--to", a.to)],
    images: prefixed("SHEET "),
  },
  {
    name: "ae_save",
    title: "Save the project",
    description: "Save the open project with AE's own Save (not undoable). ONLY when the user explicitly asks. status: only report the path and unsaved changes.",
    props: { status: B("only report"), backup: B("first copy the .aep to Backups/") },
    destructive: true,
    argv: (a) => ["save", ...flag("--status", a.status), ...flag("--backup", a.backup)],
  },
  {
    name: "ae_doctor",
    title: "Check the setup",
    description: "Check node, ffmpeg, the AE scripting preference and the macOS Automation permission, and test the connection; prints the fix for each problem.",
    props: {},
    readOnly: true,
    argv: () => ["doctor"],
  },
];

const EXIT: Record<number, string> = { 1: "the script logged ERR", 2: "usage or lint error, nothing ran", 3: "AE is not running or did not answer (a modal dialog open in AE?)" };

function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TOOLS, "dist", "ae.mjs"), ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 2, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function callTool(name: string, args: Args): Promise<{ content: Content[]; isError: boolean }> {
  const tool = TOOLS_LIST.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  for (const r of tool.required ?? []) if (args[r] === undefined || args[r] === "") return { content: [{ type: "text", text: `missing argument '${r}'` }], isError: true };
  if (name === "ae_run" || name === "ae_check") {
    if ((args.code === undefined) === !args.file) return { content: [{ type: "text", text: "give either code or file" }], isError: true };
  }
  const argv = tool.argv(args);
  if (!Array.isArray(argv)) return { content: [{ type: "text", text: argv.text }], isError: false };
  const r = await runCli(argv);
  const parts = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean);
  if (r.code) parts.push(`exit ${r.code}: ${EXIT[r.code] ?? "failed"}`);
  const content: Content[] = [{ type: "text", text: parts.join("\n") || "ok" }];
  if (tool.images && r.code === 0) {
    const files = tool.images(r.stdout.split("\n").map((l) => l.trim()));
    for (const f of files.slice(0, MAX_IMAGES)) {
      try {
        if (statSync(f).size > MAX_IMAGE) continue;
        content.push({ type: "image", data: readFileSync(f).toString("base64"), mimeType: "image/png" });
      } catch {
        // file gone: the path is in the text anyway
      }
    }
  }
  return { content, isError: r.code !== 0 };
}

const INSTRUCTIONS =
  "Drives the Adobe After Effects running on the user's Mac. Read ae_docs once before writing a script (ExtendScript is ES3, and the AE.* library " +
  "avoids the known AE traps). Look before you change: ae_selection, ae_tree, ae_dump, ae_snap. Edits go through ae_run, one undo step each. " +
  "Frames are comp frames. Never save unless the user asks.";

function toolDefs() {
  return TOOLS_LIST.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: "object", properties: t.props, ...(t.required ? { required: t.required } : {}) },
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
  }));
}

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Handle one request; returns the response, or null for notifications. */
export async function handle(msg: Message, version: string): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") return msg && "id" in msg ? fail(-32600, "invalid request") : null;
  const isNote = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "aectl", title: "After Effects (aectl)", version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolDefs() });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Args;
      return reply(await callTool(name, args));
    }
    default:
      return isNote ? null : fail(-32601, `method not found: ${msg.method}`);
  }
}

export async function cmdMcp(argv: string[]): Promise<number> {
  if (argv.length) {
    err("usage: ae mcp   (an MCP server on stdin/stdout; configure it in your MCP client, see README)");
    return 2;
  }
  // GUI apps start servers with a minimal PATH: make Homebrew's ffmpeg findable
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const d of ["/usr/local/bin", "/opt/homebrew/bin"]) if (!dirs.includes(d)) dirs.unshift(d);
  process.env.PATH = dirs.join(path.delimiter);
  let version = "0";
  try {
    version = JSON.parse(readFileSync(path.join(TOOLS, "package.json"), "utf8")).version;
  } catch {
    // version stays "0"
  }
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  let queue: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Message;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    // one at a time: AE runs one script at a time, and the commands share work files
    queue = queue.then(async () => {
      try {
        const res = await handle(msg, version);
        if (res) send(res);
      } catch (e) {
        send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
      }
    });
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
  await queue;
  return 0;
}
