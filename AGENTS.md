# Developing aectl

Notes for agents and people working on this repository. To *use* the tool, read
[`skills/after-effects/SKILL.md`](skills/after-effects/SKILL.md) instead: it is the user-facing reference (and the
Claude Code skill), with the full CLI, the `AE.*` API and the AE pitfalls.

## Layout

| path | what |
|---|---|
| `src/` | the CLI in TypeScript: `cli.ts` (dispatch, usage text), `commands/*.ts`, `lint.ts` (ExtendScript lint), `runner.ts` (osascript, logs, PNG waits), `media.ts` (ffmpeg, image measuring), `audio.ts` (onset detection for `ae beats`), `diff.ts` (`run --diff`), `plot.ts` (`graph` charts, own PNG encoder), `mcp.ts` (`ae mcp`) |
| `dist/ae.mjs` | the bundled CLI, **generated** by `pnpm build` and committed (the plugin installs from git without a build step). Never edit it by hand |
| `ae` | launcher: checks the node version, then loads `dist/ae.mjs`. Plain old JS on purpose |
| `lib.jsx` | ExtendScript library, everything under `AE`. `ae run` prepends it to every script |
| `test/*.test.ts` | vitest suite: lint rules, CLI exit codes and messages, the hook |
| `tests/selftest.jsx`, `tests/cleanup.jsx` | self-test inside AE, in a throwaway comp, and its idempotent cleanup |
| `skills/after-effects/SKILL.md` | user and agent reference; shipped as the plugin's skill |
| `skills/after-effects-tutor/SKILL.md` | a second skill: lessons as markers in the user's timeline. Separate so its text loads only when someone wants to learn |
| `hooks/hooks.json` | plugin hook: `ae hook` lints every `.jsx` Claude writes or edits |
| `completions/_ae` | zsh completion, printed by `ae completion zsh` |
| `package.json`, `.claude-plugin/` | npm package (`aectl`, bins `ae` and `aectl`) and Claude Code plugin/marketplace manifests |

## Rules

- **`lib.jsx` and `tests/*.jsx` are ES3** (ExtendScript). A syntax error opens a modal dialog in AE that blocks every
  later call. `./ae check` them after every change.
- **The lint (`src/lint.ts`) encodes what the real engine accepts.** Every rule was checked in AE 2026 with `eval()`
  inside `try/catch`, which reports a syntax error without a modal dialog. Before adding or changing a rule, verify it
  the same way (`ae eval 'try { eval("<snippet>"); log("ok") } catch (e) { log(e.message) }' --ro`) and add the case
  to the tables in `test/lint.test.ts`. Errors are for code AE refuses to compile; code that only fails at runtime
  gets a warning.
- **Output contract.** Paths and `PNG`/`SHEET` lines go to stdout, `ae: ...` messages and lint findings to stderr.
  Exit codes: 0 ok, 1 the script logged `ERR`, 2 usage or lint error, 3 AE not running or timeout. Agents rely on them.
- **Adding or changing a command** touches: its `cmd*` function in `src/commands/`, `COMMANDS` and `USAGE` in
  `src/cli.ts`, the CLI block in `SKILL.md`, the table in `README.md`, `completions/_ae`, its tool in `TOOLS_LIST` in
  `src/mcp.ts` (when an agent would use it), and a test. A test fails when a command in `USAGE` is missing from
  `SKILL.md`, `README.md` or the completion. A USAGE line starts with `  ae <command>`: `ae <command> --help` prints it.
- **The MCP server** (`ae mcp`) runs each tool as a child `node dist/ae.mjs <command>`: stdout is the protocol channel,
  so nothing in that process may print to it. Calls are serialised (AE runs one script at a time, and the commands
  share work files). Images come from the `SHEET`/`GRAPH`/PNG lines of the command's stdout. The plugin does not
  register it: Claude Code uses the CLI, and the server's tool list would cost context in every session.
- **Commands that generate ExtendScript** keep it to a few lines around an `AE.*` helper, so the logic lives in
  `lib.jsx`, is documented once and is checked by the self-test.
- **No `instanceof Layer`/`AVLayer` in `lib.jsx`**: in AE 26.5 instanceof matches only the exact class (pitfall 17).
  Use `isLayer(x)`, the exact class (`TextLayer`, `ShapeLayer`), or a method check (`sourceRectAtTime`).
- **The CLI tests put a fake `osascript` first on `PATH`**, so they never reach an AE that happens to be running.
- **Changing the API** in `lib.jsx`: document it in the API section of `SKILL.md`. If it works around AE behaviour,
  add a pitfall there too and a check in `tests/selftest.jsx`. A test fails when the docs mention an `AE.*` member
  that `lib.jsx` does not define.
- **Nothing personal in the repo**: no absolute user paths, no real project or comp names in examples or tests.
  Use neutral names (`Main`, `Title`, `Intro`).
- **Keep `SKILL.md` lean.** Every agent that uses the tool loads it in full (about 4k tokens). Put material that
  only matters for developing the toolkit here, not there. Workflows that only some users need (like teaching) go
  in a skill of their own under `skills/`: until it is used, only its description costs context.
- Commit messages: short and plain, without attribution trailers such as `Co-Authored-By`.

## Checks

Without AE (fast, run them always):

```sh
pnpm install
pnpm check           # typecheck + build + vitest + fails if the committed dist/ is stale
zsh -n completions/_ae
./ae doctor          # AE-related lines only WARN when AE is not running
pnpm pack --dry-run  # the file list must include everything the CLI reads at runtime
claude plugin validate .
```

Commit `dist/ae.mjs` together with the `src/` change that produced it.

With AE running, **in a scratch project, not someone's working one**:

```sh
./ae selftest            # or --keep to leave the test items in the project for inspection
```

It generates a 6 s test clip with ffmpeg (`$TMPDIR/ae-tools/__aetools_clip.mp4`, reused by later runs; delete it
to regenerate), then runs `tests/selftest.jsx`. That creates `__aetools_test`, `__aetools_test_src`, the folder
`__aetools_test_folder` and imports the clip. It checks trim/shift/setText (a real typewriter expression, plus keyed
Source Text)/key/copyEase/replaceFootage/cover/dump, builds with `AE.addComp/addText/addRect/control/fx/key/fade/clearKeys/rebuild` (including a failing rebuild), copies a layer (`AE.copyLayer`), moves the playhead and selects (`AE.show/cti/select`), sets and reads markers, resolves property paths, checks `AE.isLayer` (and logs the `instanceof` quirk of pitfall 17), sets expressions with `AE.expr` and finds a broken one with `AE.exprErrors` (pitfall 16), checks `AE.bounds` through a parent, `AE.health`, `AE.addEffect` by display name with `AE.setProps`, `AE.find`, the `--diff` snapshot and `AE.graphData`, snaps 3 frames and renders 5 frames through the render queue (`AE.render`), and must print `ALL PASS` (76 checks). Then `ae selftest` checks the rollback from outside: a run that changes something and throws, and one that throws before changing anything, must both leave the test comp as the previous run left it (one more `PASS` line; the two probes print their expected `ERR`). The
`WARN trim ... wanted in=0 out=240` line is expected: that check trims past the end of the source on purpose.
Then `tests/cleanup.jsx` removes exactly those items. It is idempotent and never saves. The self-test never touches
existing comps or layers, but it leaves two entries in the undo history and marks the project as changed. Never
save the project from a test.

## Release

1. Bump `version` in both `package.json` and `.claude-plugin/plugin.json` (keep them equal).
2. Run the checks above, including `ae selftest` against a running AE, and commit the rebuilt `dist/`.
3. `pnpm publish`, and push to `main`. The plugin marketplace installs straight from the GitHub repo.
