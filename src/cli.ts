// ae - drive Adobe After Effects from the shell (macOS). Entry point: dispatch to the commands.
import { cmdExport } from "./commands/export.ts";
import { cmdDump, cmdSnap, cmdTree } from "./commands/inspect.ts";
import { cmdFrames, cmdProbe, cmdSheet } from "./commands/media.ts";
import { cmdSave } from "./commands/save.ts";
import { cmdCheck, cmdEval, cmdRun } from "./commands/script.ts";
import { cmdCompletion, cmdDoctor, cmdHook, cmdNames, cmdSelftest } from "./commands/setup.ts";
import { err, Exit } from "./util.ts";

export const USAGE = `ae - drive Adobe After Effects from the shell (macOS). See README.md next to this file.
  ae run script.jsx [--log file] [--ro|--undo] [--timeout s]
  ae eval 'js' [--ro]            ae check script.jsx [more.jsx ...]
  ae dump "Comp" [--depth N] [--layer name] [--no-keys] [--max-keys N] [--raw-text]
  ae tree [--main "Comp"]         (default: the active comp)
  ae snap "Comp" 8,44,90|10-100:10 [--out dir] [--prefix p] [--res full|half|third|quarter] [--sheet] [--cols N] [--width px]
  ae sheet out.png a.png b.png ... [--cols N] [--width px]
  ae frames video.mp4 [--n 12] [--cols 4] [--width 480] [--from s] [--to s] [--out sheet.png]
  ae probe video.mp4 [--fps N]    (--fps: also the length in comp frames at N fps)
  ae export "Comp" [--preset youtube-1080] [--out file] [--full | --from F --to F] [--fit pad|crop] [--force] [--ame [--wait]]
  ae export --list                (presets: youtube-1080, youtube-4k, shorts, square, web, prores, prores-alpha, webm-alpha, gif)
  ae save [--backup] [--status] [--as file.aep]
  ae doctor                       check node/ffmpeg/AE/permissions/prefs      ae selftest [--keep]
  ae completion zsh               zsh completion; add to ~/.zshrc:  eval "$(ae completion zsh)"
  ae hook                         Claude Code PostToolUse hook: lints a .jsx right after it is written
Exit codes: 0 ok, 1 script logged ERR, 2 usage/syntax/lint error, 3 AE not running / timeout.
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  run: cmdRun,
  eval: cmdEval,
  check: cmdCheck,
  dump: cmdDump,
  tree: cmdTree,
  snap: cmdSnap,
  sheet: cmdSheet,
  frames: cmdFrames,
  probe: cmdProbe,
  export: cmdExport,
  save: cmdSave,
  doctor: cmdDoctor,
  selftest: cmdSelftest,
  completion: cmdCompletion,
  hook: cmdHook,
  _names: cmdNames,
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    process.stdout.write(USAGE);
    return 2;
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    err(`ae: unknown command '${cmd}'`);
    process.stdout.write(USAGE);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    const lines = USAGE.split("\n").filter((l) => new RegExp(`\\bae ${cmd}\\b`).test(l));
    process.stdout.write((lines.length ? lines : USAGE.split("\n").slice(0, 1)).join("\n") + "\n");
    return 0;
  }
  try {
    return await fn(rest);
  } catch (e) {
    if (e instanceof Exit) {
      if (e.message) err(e.message);
      return e.code;
    }
    throw e;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err("ae: internal error: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exitCode = 2;
  },
);
