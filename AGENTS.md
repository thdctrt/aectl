# Developing aectl

Notes for agents and people working on this repository. To *use* the tool, read
[`skills/after-effects/SKILL.md`](skills/after-effects/SKILL.md) instead: it is the user-facing reference (and the
Claude Code skill), with the full CLI, the `AE.*` API and the AE pitfalls.

## Layout

| path | what |
|---|---|
| `ae` | the CLI, one bash file. Also holds the node helper (syntax check, ES3 lint, `#include` rewriting) as a heredoc |
| `lib.jsx` | ExtendScript library, everything under `AE`. `ae run` prepends it to every script |
| `tests/selftest.jsx`, `tests/cleanup.jsx` | self-test in a throwaway comp, and its idempotent cleanup |
| `skills/after-effects/SKILL.md` | user and agent reference; shipped as the plugin's skill |
| `completions/_ae` | zsh completion, printed by `ae completion zsh` |
| `README.md` | short intro for humans |
| `package.json`, `.claude-plugin/` | npm package (`aectl`, bins `ae` and `aectl`) and Claude Code plugin/marketplace manifests |

## Rules

- **`lib.jsx` and `tests/*.jsx` are ES3** (ExtendScript). No `let`/`const`, `=>`, template literals, `[].forEach/map/indexOf`,
  `"".trim`, `Object.keys`, and no reserved words as bare keys or properties (`o["in"]`, never `o.in`). A syntax error
  opens a modal dialog in AE that blocks every later call. Run `./ae check` on anything you touch.
- **`ae` runs on macOS `/bin/bash` 3.2.** No associative arrays, `mapfile`, `${var,,}`, `|&` or `;&`.
  `nullglob` is on for the whole script. Keep it a single file with no dependencies beyond node, osascript and ffmpeg.
- **`ae help` prints the header comment of `ae`**: `usage()` shows a fixed line range (`sed -n '2,14p'`). When you add
  or remove a header line, update that range.
- **Adding or changing a command** touches five places: the `cmd_*` function and the `case` at the bottom of `ae`,
  the header comment, the CLI block in `SKILL.md`, the table in `README.md`, and `completions/_ae`.
- **Changing the API** in `lib.jsx`: document it in the API section of `SKILL.md`. If it works around AE behaviour,
  add a pitfall there too and a check in `tests/selftest.jsx`.
- **Nothing personal in the repo**: no absolute user paths, no real project or comp names in examples or tests.
  Use neutral names (`Main`, `Title`, `Intro`).
- **Keep `SKILL.md` lean.** Every agent that uses the tool loads it in full (about 4k tokens). Put material that
  only matters for developing the toolkit here, not there.
- Commit messages: short and plain, without attribution trailers such as `Co-Authored-By`.

## Checks

Without AE (fast, run them always):

```sh
bash -n ae && zsh -n completions/_ae
./ae check lib.jsx && ./ae check tests/selftest.jsx && ./ae check tests/cleanup.jsx
./ae doctor          # AE-related lines only WARN when AE is not running
npm pack --dry-run   # the file list must include everything the CLI reads at runtime
claude plugin validate .
```

With AE running, **in a scratch project, not someone's working one**:

```sh
./ae selftest            # or --keep to leave the test items in the project for inspection
```

It generates a 6 s test clip with ffmpeg (`$TMPDIR/ae-tools/__aetools_clip.mp4`, reused by later runs; delete it
to regenerate), then runs `tests/selftest.jsx`. That creates `__aetools_test`, `__aetools_test_src`, the folder
`__aetools_test_folder` and imports the clip. It checks trim/shift/setText (a real typewriter expression, plus keyed
Source Text)/key/copyEase/replaceFootage/cover/dump and snaps 3 frames, and must print `ALL PASS` (40 checks). The
`WARN trim ... wanted in=0 out=240` line is expected: that check trims past the end of the source on purpose.
Then `tests/cleanup.jsx` removes exactly those items. It is idempotent and never saves. The self-test never touches
existing comps or layers, but it leaves two entries in the undo history and marks the project as changed. Never
save the project from a test.

## Release

1. Bump `version` in both `package.json` and `.claude-plugin/plugin.json` (keep them equal).
2. Run the checks above, including `ae selftest` against a running AE.
3. `npm publish`, and push to `main`. The plugin marketplace installs straight from the GitHub repo.
