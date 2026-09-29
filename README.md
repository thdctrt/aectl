# aectl: drive After Effects from the shell (and from your AI agent)

A small CLI (`ae`) and an ExtendScript library (`lib.jsx`) for scripting a running Adobe After Effects on macOS.
It is built for coding agents such as Claude Code, but works just as well by hand.

```sh
ae sel                                    # what the user selected, and where the playhead is
ae tree                                   # every comp, plus the layers of the active one
ae dump "Main" --layer "Title"            # transforms, keys with easing, expressions, text
ae run retime.jsx --diff                  # lint, run as ONE undo step, print the log and what changed
ae snap "Main" 0-120:30 --sheet           # render frames to PNG + a labelled contact sheet
ae graph "Main" "Title" pos               # value + speed curves: see the easing
```

## Why

- **Nothing to install inside AE.** No CEP panel, no bridge to keep open. Scripts go through `osascript` to
  `DoScriptFile`, so AE only has to be running.
- **Lint before AE sees the script.** ExtendScript is ES3. A stray `let`, `=>` or `{in: 1}` opens a modal error
  dialog that blocks AE until someone clicks it. `ae run` parses the script against the rules of the real engine
  (checked in AE 2026), catches typos like `AE.setTxt` ("did you mean AE.setText?"), and refuses to send a broken
  script. As a Claude Code plugin it also lints every `.jsx` the agent writes, right after it is written.
- **Safe edits.** Every run is one Cmd+Z step, with dialogs suppressed and errors caught. Errors are reported with the
  line in *your* file.
- **Visual feedback.** `ae snap` renders frames to PNG and waits until the files are complete. `--sheet` tiles them
  into one image that an agent (or you) can look at. `ae graph` draws the motion curves of a property.
- **Works with you, not around you.** `ae sel` reads your selection and playhead, `ae markers` reads the notes you
  leave as markers, and `ae run --diff` shows exactly what a script changed.
- **Helpers for the parts AE gets wrong.** Trims that silently don't stick, Source Text read through a typewriter
  expression, keyframe ease arrays of the wrong length, `"x" + array` throwing. See the pitfalls in the
  [reference](skills/after-effects/SKILL.md#pitfalls-all-handled-by-the-libcli-keep-them-in-mind-for-raw-code).

## Install

Requirements: macOS, After Effects (tested with 2026), node 22+, ffmpeg (`brew install ffmpeg`) for the image and video tools.

**As a Claude Code plugin** (the agent also gets the full API reference as a skill):

```
/plugin marketplace add thdctrt/aectl
/plugin install aectl@aectl
```

**From npm** (puts `ae` and `aectl` on your PATH):

```sh
npm install -g aectl
```

To get the lint hook without the plugin, add this to `~/.claude/settings.json`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [ { "type": "command", "command": "ae hook" } ] } ] } }
```

Install it once instead of calling it through `npx`: an agent makes many calls, and `npx` resolves the package on every one.

**From git:**

```sh
git clone https://github.com/thdctrt/aectl && ln -s "$PWD/aectl/ae" /usr/local/bin/ae
```

Then run the check. It tells you exactly what to fix:

```sh
ae doctor      # node, ffmpeg, the AE scripting pref, macOS Automation permission, a round trip to AE
ae selftest    # 76 checks + a rollback round trip in a throwaway comp, cleaned up afterwards
```

Two things usually need a one-time click:

1. In AE: **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network**. The CLI reads the
   log file your script writes.
2. macOS asks whether your terminal may control After Effects. Allow it (System Settings > Privacy & Security > Automation).

**zsh completion** (commands, options, `.jsx` and video files, and comp/layer names from the running AE):

```sh
echo 'eval "$(ae completion zsh)"' >> ~/.zshrc
```

## Writing a script

```js
// retime.jsx:  ae run retime.jsx
AE.run("Retime intro", function (log) {
    var c = AE.comp("Main");
    var L = AE.layer(c, "Title");
    AE.trim(L, 144, 194);                        // comp frames; WARNs if AE won't keep the trim
    AE.setText(L, "Hello world", "#806600");     // keeps font/size, safe with typewriter expressions
    log("now", AE.span(L));
    AE.snap(c, [150, 190]);                      // ae run waits for the PNGs
});
```

Everything is in [`skills/after-effects/SKILL.md`](skills/after-effects/SKILL.md): every command and option, the
full `AE.*` API, and the pitfalls. It doubles as the skill that tells an agent how to use the tool.

## Commands

| command | what |
|---|---|
| `ae run script.jsx` | lint, run as one undo step, print the log, wait for PNGs; exit 1 on `ERR`; a run that throws is undone |
| `ae eval 'js'` | run a one-liner; the value of the last expression is printed |
| `ae check script.jsx` | syntax + ExtendScript lint only, no AE needed |
| `ae run edit.jsx --diff` / `--ab "Comp" --frames 0,60` | also print what changed in the project / a before-after contact sheet |
| `ae sel` | the active comp, playhead frame, work area, selected layers, properties and keyframes |
| `ae tree` / `ae dump "Comp"` | project overview / one comp in detail (read-only) |
| `ae markers` / `ae mark "Comp" 120 "note"` | read comp and layer markers (notes from the user) / add one |
| `ae health` / `ae find "text"` | missing footage and fonts, expression errors, off-screen layers, text past the edge / search names, text, expressions, files, effects, markers |
| `ae effects blur` | installed effects with their matchNames |
| `ae snap "Comp" 0-90:15 --sheet` | render frames to PNG, optionally as a contact sheet or cropped to a region (`--crop`) |
| `ae graph "Comp" "Layer" "Transform/Position"` | value and speed curves as a PNG, plus the numbers of each ease |
| `ae sheet out.png a.png b.png` | contact sheet from any images |
| `ae measure a.png [b.png]` | ink bounding box, centre and mean colour of an image; with two, how far b is off from a |
| `ae frames video.mp4` / `ae probe video.mp4` | sample a clip into a sheet / size, fps (flags VFR), duration |
| `ae beats "Comp" --layer "Music"` | music accents (onsets) in the comp's frames, to key animation to the beat; `--mark` adds them as markers |
| `ae export "Comp" --preset youtube-1080` | render and encode for YouTube, Shorts/Reels, web, ProRes, alpha, GIF (`--list`); `--ame` uses Media Encoder; `--quick` takes snapped frames for a fast preview |
| `ae save [--backup]` | save the project (only when you mean it) |
| `ae doctor` / `ae selftest` | check the setup / run the self-test |
| `ae completion zsh` | print the zsh completion script |
| `ae mcp` | the same tools as an MCP server (see below) |

Exit codes: 0 ok, 1 the script logged `ERR`, 2 usage or lint error, 3 AE not running or timeout (usually a modal dialog in AE).

## MCP server (Claude Desktop and other clients without a shell)

Claude Code needs nothing more than the plugin: it calls the CLI. Clients that cannot run shell commands on your Mac
(the Claude Desktop chat, other MCP-capable agents) can use `ae mcp`, an MCP server over stdin/stdout. It is part of
the same CLI: no extra package, no network, nothing fetched at start. The commands above are tools (`ae_run`,
`ae_snap`, `ae_selection`, ...); `ae_snap`, `ae_graph` and `ae_run` with `ab_comp` return their images directly, and
`ae_docs` hands the model the full reference.

In Claude Desktop: Settings > Developer > Edit Config, then add (absolute paths: GUI apps start servers with a minimal
`PATH`; `which node` and the path to your `ae` give them):

```json
{
  "mcpServers": {
    "aectl": { "command": "/opt/homebrew/bin/node", "args": ["/path/to/aectl/ae", "mcp"] }
  }
}
```

With a global npm install the second path is `$(npm root -g)/aectl/ae`. Restart Claude Desktop. The first call makes
macOS ask whether Claude may control After Effects: allow it (System Settings > Privacy & Security > Automation).

## Limitations

- macOS only: the transport is AppleScript. Windows would need `AfterFX.exe -r` and a port of the CLI.
- Tested on After Effects 2026 (26.x). Older versions probably work, but some pitfalls are version-specific.
- AE runs one script at a time, and a modal dialog in AE blocks everything until it is closed.

## Development

The CLI is TypeScript in `src/`, bundled into `dist/ae.mjs`. `pnpm install && pnpm check` type-checks, runs the
tests (vitest) and verifies that the committed `dist/` is up to date. See [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
