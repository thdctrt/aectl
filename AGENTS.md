# Developing aectl

Notes for agents and people working on this repository. To *use* the tool, read
[`skills/after-effects/SKILL.md`](skills/after-effects/SKILL.md) instead: it is the user-facing reference (and the
Claude Code skill), with the full CLI, the `AE.*` API and the AE pitfalls.

## Layout

| path | what |
|---|---|
| `src/` | the CLI in TypeScript: `cli.ts` (dispatch, usage text), `commands/*.ts`, `lint.ts` (ExtendScript lint), `runner.ts` (osascript, logs, PNG waits), `media.ts` (ffmpeg) |
| `dist/ae.mjs` | the bundled CLI, **generated** by `npm run build` and committed (the plugin installs from git without a build step). Never edit it by hand |
| `ae` | launcher: checks the node version, then loads `dist/ae.mjs`. Plain old JS on purpose |
| `lib.jsx` | ExtendScript library, everything under `AE`. `ae run` prepends it to every script |
| `test/*.test.ts` | vitest suite: lint rules, CLI exit codes and messages, the hook |
| `tests/selftest.jsx`, `tests/cleanup.jsx` | self-test inside AE, in a throwaway comp, and its idempotent cleanup |
| `skills/after-effects/SKILL.md` | user and agent reference; shipped as the plugin's skill |
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
  `src/cli.ts`, the CLI block in `SKILL.md`, the table in `README.md`, `completions/_ae`, and a test.
- **Changing the API** in `lib.jsx`: document it in the API section of `SKILL.md`. If it works around AE behaviour,
  add a pitfall there too and a check in `tests/selftest.jsx`. A test fails when the docs mention an `AE.*` member
  that `lib.jsx` does not define.
- **Nothing personal in the repo**: no absolute user paths, no real project or comp names in examples or tests.
  Use neutral names (`Main`, `Title`, `Intro`).
- **Keep `SKILL.md` lean.** Every agent that uses the tool loads it in full (about 4k tokens). Put material that
  only matters for developing the toolkit here, not there.
- Commit messages: short and plain, without attribution trailers such as `Co-Authored-By`.

## Checks

Without AE (fast, run them always):

```sh
npm install
npm run check        # typecheck + build + vitest + fails if the committed dist/ is stale
zsh -n completions/_ae
./ae doctor          # AE-related lines only WARN when AE is not running
npm pack --dry-run   # the file list must include everything the CLI reads at runtime
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
Source Text)/key/copyEase/replaceFootage/cover/dump and snaps 3 frames, and must print `ALL PASS` (40 checks). The
`WARN trim ... wanted in=0 out=240` line is expected: that check trims past the end of the source on purpose.
Then `tests/cleanup.jsx` removes exactly those items. It is idempotent and never saves. The self-test never touches
existing comps or layers, but it leaves two entries in the undo history and marks the project as changed. Never
save the project from a test.

## Release

1. Bump `version` in both `package.json` and `.claude-plugin/plugin.json` (keep them equal).
2. Run the checks above, including `ae selftest` against a running AE, and commit the rebuilt `dist/`.
3. `npm publish`, and push to `main`. The plugin marketplace installs straight from the GitHub repo.
