---
name: after-effects
description: Drive a running Adobe After Effects (macOS) from the shell with the `ae` CLI and the ExtendScript helper library - inspect comps and layers (dump/tree), run and lint .jsx edits as one undo step, render frames to PNG contact sheets to check the result, probe and sample video files, save the project. Use whenever the user asks to look at, edit, animate, retime, re-text, replace footage in, or render frames from an After Effects project, or to write/debug ExtendScript for AE.
---

# After Effects from the shell (`ae` + `lib.jsx`)

## Where the CLI is

- If `ae` is on PATH (`command -v ae`), use it. Installed from npm it is also available as `aectl`.
- Otherwise it is `<skill-dir>/../../ae`, where `<skill-dir>` is the directory of this SKILL.md (Claude Code prints it as
  "Base directory for this skill"). `lib.jsx` and `tests/` sit next to `ae`.
- First time on a machine, or when a command times out or exits 3: run `ae doctor`. It checks node, ffmpeg, the AE
  "Allow Scripts to Write Files and Access Network" pref and the macOS Automation permission, and prints the fix.
- Requirements: AE running, node 22+, ffmpeg/ffprobe (for sheets and video tools).

The user works in this AE project. Read with `dump`/`tree`/`snap` before changing anything, keep edits in `AE.run`
(one undo step each), and never save unless asked.

## Writing a script

```js
// my_edit.jsx. Run with:  ae run my_edit.jsx
AE.run("Retime intro", function (log) {          // one Cmd+Z step, dialogs suppressed, errors caught
    var c = AE.comp("Main");
    var L = AE.layer(c, "Title");
    AE.trim(L, 144, 194);                          // comp frames
    AE.setText(L, "Hello world", "#806600");       // safe with typewriter expressions
    log("now", AE.span(L));                        // log(...) takes anything, arrays included
    AE.snap(c, [150, 190], null, "chk", "half");   // ae run waits for the PNGs
});
```

- `ae run` prepends `lib.jsx` itself, so no `#include` is needed. An `#include` line that points at this `lib.jsx`
  is allowed and gets stripped. Other `#include`/`//@include` lines are kept, with relative paths made absolute.
- The whole script is wrapped in a function, inside `AE.run(<file name>)`, so top-level code also gets try/catch,
  suppressed dialogs and `log()`. If the file itself calls `AE.run(`/`AE.peek(`/`app.beginUndoGroup(`, the outer wrapper opens no undo
  group, so your named groups count. Otherwise the whole file is one undo step named after it.
  `--ro` means no undo group at all, `--undo` forces one.
- The log goes to `<script>.log` next to the script (scripts inside the toolkit dir log to `$TMPDIR/ae-tools/logs/`),
  or to `--log file`. It is printed, and the exit code is 1 if any line starts with `ERR`.
- Errors come out as `ERR <message> @ my_edit.jsx:12` (line in YOUR file) or `@ lib.jsx:N` when a helper threw.
- Log line prefixes: `ERR` (failure, exit 1), `WARN` (e.g. a trim that would not stick), `PNG <path>` (the runner waits
  for that file), `DONE/FAILED <name> (ms)` (end of each `AE.run`), `UNDO <step>` (the Cmd+Z step it made), `ROLLED BACK <step>`.
- **A run that throws is undone** (`ROLLED BACK`), so a script that fails halfway leaves nothing behind; fix it and run
  it again. `--no-rollback` keeps the partial result. Only a throw rolls back, not `ERR`/`WARN` lines you log yourself.
  A run that succeeded cannot be undone from a script (AE does not say what its last step is): ask the user to press
  Cmd+Z, naming the `UNDO` step they should see in the Edit menu.
- Standalone, without the CLI: `#include` the lib and call `AE.run(name, "/abs/log.txt", fn)`. Without a logPath
  it writes to `AE.tmp/ae_run.log`.

## CLI

```
ae run script.jsx [--log file] [--ro|--undo] [--no-rollback] [--timeout s]   # check, run, wait for log (+PNGs), print, exit 1 on ERR
ae check script.jsx [more.jsx ...]                           # syntax + ExtendScript lint only (no AE needed)
ae eval 'AE.comp("Logo").numLayers' [--ro]                   # the value of the last expression is logged
ae eval 'var c=AE.comp("Logo"); c.duration' --ro             # (or of a top-level `return x`); no IIFE needed
ae dump "Main" [--depth 1] [--layer "Title"] [--at F] [--props] [--no-keys] [--max-keys N] [--raw-text]
ae tree [--main "Main"]                                      # all comps (folder, size, fps, dur) + layers of --main (default: active comp)
ae snap "Main" 8,44,90 [--out dir] [--prefix p] [--res full|half|third|quarter] [--crop x,y,w,h] [--sheet] [--cols 4] [--width 640]
ae snap "Intro" 0-84:14 --sheet                     # ranges: a-b or a-b:step
ae sheet out.png a.png b.png ... [--cols 4] [--width 640]    # contact sheet from any images (labels = file names)
ae measure a.png [b.png] [--box x,y,w,h] [--bg #RRGGBB]       # ink bounding box, centre, mean colour; with b: the b-a delta
ae frames video.mp4 [--n 12] [--cols 4] [--width 480] [--from s] [--to s] [--out sheet.png]  # pick clip times
ae probe video.mp4 [--fps 25]                                # size, fps (avg + r; flags VFR), duration, frames, audio;
                                                             # --fps: length in comp frames at that rate
ae beats "Main" --layer "Music" [--from F --to F] [--top N] [--env]   # music accents in Main's frames (see below)
ae beats music.wav [--fps 25] [--offset F] [...]                      # the same for a file that starts at frame F
ae export "Main" [--preset youtube-1080] [--out f.mp4] [--full | --from F --to F] [--fit pad|crop] [--force] [--ame [--wait]]
ae export --list                                             # the presets (below)
ae save [--status] [--backup] [--as file.aep]                # save the open project (see below)
ae doctor                                                    # check node/ffmpeg/AE prefs/permissions, test the connection
ae selftest [--keep]                                         # 53 checks + a rollback round trip in a throwaway comp, then cleanup (dirties the project)
```

- `snap` defaults: `--res half`, output in `$TMPDIR/ae-tools/snap/<comp>/`, files named `<prefix>_f0044.png`. It prints one
  path per line, then `SHEET <path>` with `--sheet`. The comp's own resolution factor is restored afterwards.
  `--crop x,y,w,h` is in comp pixels at any `--res` (a close-up of one region).
- `measure`: "ink" is every pixel that is not background (alpha, or the corner colour). Compare a snap with a design
  render (`ae measure design.png snap.png`): b is scaled to a's size, so a half-res snap works; the delta says how
  far and in which direction the AE result is off.
- `dump`/`tree`/`snap` are read-only (no undo group). `dump --raw-text` runs in one undo group "ae dump", see pitfall 6.
- Env: `AE_TIMEOUT` (log wait, default 300 s), `AE_SNAP_TIMEOUT` (PNG wait, default 60 s), `AE_TMP` (work dir,
  default `$TMPDIR`), `AE_DEBUG=1` (PNG wait timing), `AE_APP` (app name; default: the running AE, else the newest one in /Applications).
- Exit codes: 0 ok, 1 ERR logged, 2 usage/syntax/lint, 3 AE not running / timeout (a modal dialog in AE is the usual cause).
- `ae <command> --help` prints that command's usage.
- `save`: prints the project path and whether it has unsaved changes, then saves with AE's own Save (not undoable).
  Does nothing when there are no unsaved changes. `--status` only reports. `--backup` first copies the current .aep on
  disk to `<project dir>/Backups/<name>-YYYYmmdd-HHMMSS.aep`. `--as` saves to a new path, and AE keeps working on that
  new file afterwards, like Save As. Only save when the user asks you to: they may prefer to save themselves.
- `beats`: onsets (hits, note attacks) found by spectral flux, one line each: comp frame, strength 0..1 (1 = the
  strongest in the range), a bar. With `--layer` the file, start, stretch and in/out come from AE, so the frames are
  the comp's own: key animation straight to them. `--top N` keeps the N strongest (downbeats, big hits),
  `--min-gap F` (default 3) merges closer ones, `--threshold` (default 0.15) drops weaker ones, `--env` adds loudness
  in dBFS per frame (swells, quiet parts). Time remapping on the layer is ignored (a note says so).
- The combined file that actually ran is at `$TMPDIR/ae-tools/run/<name>.combined.jsx`.
- `export`: AE renders a master (ProRes 422 HQ or Lossless; with alpha for alpha presets) through the render queue,
  then ffmpeg encodes the preset. Default range: the comp's work area. Default file: `./<comp>_<preset>.<ext>`; an
  existing file needs `--force`. AE is busy until its render finishes. Prints `EXPORT <path>` and a probe line
  (size, fps, length, codec, alpha, audio): check it matches what the user asked for. Map requests to presets:

  | the user says | preset |
  |---|---|
  | YouTube, Vimeo, "1080", Full HD | `youtube-1080` (default) |
  | 4K, UHD | `youtube-4k` |
  | Shorts, Reels, TikTok, vertical, stories | `shorts` (1080x1920) |
  | square, Instagram feed | `square` (1080x1080) |
  | for a website, docs, a chat, small | `web` (H.264, at most 1280 wide) |
  | master, for editing, for the client, ProRes | `prores` |
  | transparent, with alpha, for compositing | `prores-alpha` |
  | transparent video for web / UI | `webm-alpha` |
  | GIF | `gif` |

  When the comp's aspect differs from the preset, it is letterboxed (`--fit crop` fills the frame instead) and a note
  goes to stderr: tell the user. `--ame` hands the comp to Adobe Media Encoder with AE's H.264 template at the comp
  size (the preset's size is not applied), needs a saved project, and returns right away (`--wait` waits for the file).
  Lottie is not supported yet.

## API (`lib.jsx`)

Frames are always comp frames (`frame * comp.frameDuration`). Layer/comp arguments accept objects; `comp` also takes a
name or numeric id.

**Lookup**
- `AE.comp(nameOrId)`: throws if the comp is missing or the name is ambiguous. `AE.comps(name?)` returns all comps with that name.
- `AE.layer(comp, nameOrIndex)`: throws if missing or ambiguous. `AE.layers(comp, name|RegExp|fn)` returns the list.
- `AE.copyLayer(layer, comp?, {name, above})` copies a layer and returns **the copy** (found by its new id; pitfall 11).
  In place it lands right above the source, in another comp at the top, or above `above` (layer or index).
- `AE.findProp(group, matchNameOrName)` searches recursively. `AE.findProps(...)` returns all matches.
- `AE.tf(layer, "pos"|"anchor"|"scale"|"rot"|"opacity"|"x"|"y"|matchName)` returns a transform property.
- `AE.footage(path, folder?, {reload})` finds a FootageItem by `file.fsName`, or imports it (into `AE.folder(folder)`).
  `reload: true` re-reads a file that changed on disk.
  Afterwards `AE.lastImported` is true/false and `AE.imported` holds the items imported during this script.
- `AE.folder(name, parent?)` finds or creates a folder. `AE.items(Type?)`, `AE.itemPath(item)` returns `"a/b"`.

**Time**
- `AE.f(comp, frames)` gives seconds. `AE.toF(comp, seconds)` gives frames. `AE.fd(compOrLayerOrProp)` gives the frame duration.
- `AE.trim(layer, inF, outF)`: `null` keeps a side. It retries up to 3 times with a frameDuration/4 tolerance. If the trim
  won't stick (e.g. past the end of the source) it logs a `WARN` with the source span and returns false.
- `AE.shift(layer, dF)` moves `startTime`. `AE.span(layer)` returns `"in=.. out=.. st=.."` in frames.

**Colour**
- `AE.hex("#7143EC")` returns `[r,g,b]`. `AE.hex("#7143EC", true)` returns `[r,g,b,1]`. Also accepts `"#abc"`, `"#RRGGBBAA"` and arrays.
- `AE.toHex(rgb)` goes the other way.

**Text**
- `AE.setText(layer, text|null, hex?)` is expression-safe and keeps font, size and tracking. It applies to every key
  if Source Text is keyed.
- `AE.getText(layer, t?)` and `AE.textDoc(layer, t?, key?)` return the raw (pre-expression) source (pitfall 6).
- `AE.textProp(layer)` and `AE.hasExpr(prop)` are also available.

**Keys**
- `AE.key(prop, frame, value, {interp, ease, like})` sets one key:
  - `interp` is `"linear"|"bezier"|"hold"` or `[in,out]`;
  - `ease` is an influence % or `[in%, out%]`, with speed 0;
  - `like: [srcProp, srcKey]` copies interpolation and ease from a reference key;
  - hex strings work for colour properties.

  Returns the key index. List form: `AE.key(prop, [[frame, value, opts|ease], ...], opts)` sets several keys.
- `AE.copyEase(prop, k|"all", srcProp, srcK)` copies in/out interpolation, temporal ease, and continuous/auto-bezier.
  The ease-array length adapts to the target dimension (e.g. a spatial Position with 1 entry from a Scale with 3).
- `AE.keys(prop)` returns `[{frame, time, index, value, "in", "out", inEase, outEase}]`. Read the interpolation types as
  **`k["in"]` / `k["out"]`**: `k.in` works in AE 2026 but is a syntax error in older versions.
- `AE.set(prop, value)` is a `setValue` that pads missing dimensions (z) and throws clearly if the property is keyed.

**Building** (the usual script: resolve every input first, then build; a rebuild never leaves a half-built project)
- `AE.rebuild(name, [o], fn(comp))` builds `name` again: `fn` fills a new comp; if it throws, everything the build
  added (comps, footage, folders) is removed and the old comp is untouched (and under `ae run` the rollback also
  undoes whatever `fn` changed in existing items). On success every layer using the old comp is switched to the new one (in/out/start kept), the
  old comp is removed, and the new one takes its name. `o`: `AE.addComp` options (default: like the old comp) and
  `replace` (comp names/items/folders of the previous build to remove after a success).
- `AE.addComp(name, {w, h, dur (frames), fps, like, folder, bg})`, `AE.remove(compName|item|folder|layer|[...])`.
- `AE.addText(comp, text, {font, size, fill, stroke, strokeWidth, tracking, leading, justify, caps, box:[w,h], pos, name})`;
  `AE.textStyle(layer, {...same})` restyles (every key, expression-safe). Warns when the font is not installed.
- `AE.addRect(compOrShapeLayer, {size, pos, round, fill, stroke, strokeWidth, name, layer})` returns the shape layer.
  A new layer sits at [0,0], so `pos` is in comp coordinates (pitfall 12). Find the group with `AE.findProp(L, name)`.
- `AE.addEffect(layer, matchName, name?)`, `AE.fx(layer, name, param?)` (fresh references, pitfall 14),
  `AE.control(layer, "slider"|"checkbox"|"color"|"point"|"angle"|"layer", name, value)` returns the value property.
- `AE.fade(layer, fromF, toF, a=0, b=100, opts)`; `AE.clearKeys(prop)` (Time Remap is reset to its two default
  keys instead of being hidden, pitfall 13).

**Footage placement**
- `AE.replaceFootage(layer, pathOrItem, {folder, anchor, scale, pos, start, inF, outF, mute, name, cover, reload})`:
  - `replaceSource(item, false)` keeps the transforms and in/out; a layer that ran to the end of its old source runs
    to the end of the new one;
  - `start` is the startTime in frames;
  - `name: true` means use the item's name;
  - `cover: true` or `{...}` runs `AE.cover` after the swap.
- `AE.cover(layer, {zoom, scale, anchor, pos, focus:[srcX,srcY], flipX})`:
  - sets the minimum scale that fills the comp (× `zoom`, or at least `scale`);
  - keeps mirroring signs;
  - clamps the position so no edge shows;
  - `focus` brings a source pixel to the comp centre before clamping.

  Assumes rotation 0. Returns `{scale, min, pos}`.

**Run / log / inspect**
- `AE.run(name, [logPath], fn(log), [{undo:false, rollback:false}])` and `AE.peek(name, fn)` (no undo group). A nested
  `AE.run` gets its own try/catch but joins the outer undo group. `rollback` (default under `ae run`/`ae eval`)
  undoes the step when `fn` throws.
- `AE.log(...)`, `AE.warn(...)`, `AE.str(anything)`: `str` is a safe stringify for arrays, TextDocument, KeyframeEase,
  Shape, layers and items.
- `AE.dump(comp, {depth, keys, maxKeys, filter, rawText, at, props})` returns the text tree:
  - per layer: index, name, kind, source (and file), in/out/start in frames, stretch, parent, matte, disabled/solo/3D/audio flags;
  - transform values (post-expression at the comp's current time, or at frame `at`; `*` = keyed, `~` = expression,
    `~!` = expression with an error);
  - text (font, size, tracking, fill, leading, justification, box size/position, `ink` = sourceRectAtTime in layer
    space) and the effects with their changed parameter values;
  - every keyed or expression property as `frame:value` with interpolation `LL/BB(inInfl,outInfl)/HH`, the expression
    text, `(OFF)` when AE disabled it, and `expr ERROR:` with AE's message;
  - `props`: also every changed static value (shape contents, masks, text animators, layer styles), one `prop` line each;
  - `depth` recurses into precomps.
- `AE.tree(mainName?)` is the project overview used by `ae tree`.
- `AE.snap(comp, frames[], outDir?, prefix?, res?)` queues PNGs, logs `PNG <path>` and returns the paths.
  `res` is `"full"|"half"|"third"|"quarter"`, 1–4, `[x,y]`, or null (keep).
- `AE.render(comp, path, {kind, full, from, to, ame})` renders through the render queue and returns the file:
  `kind` is `"master"` (ProRes 422 HQ/Lossless, default), `"alpha"` or `"h264"`; the range defaults to the work area
  (`from`/`to` are comp frames, inclusive). Logs `RENDERED <path>`. Blocks AE until done. `ae export` is built on it.
- `AE.scriptPath` / `AE.scriptDir` hold the original script location under `ae run`. `AE.tmp` is the shell-readable work dir.

## Pitfalls (all handled by the lib/CLI; keep them in mind for raw code)

1. **`"x" + array` throws** ("invalid numeric result") because this engine overloads `+` for arrays. Use `AE.str(v)`,
   `String(arr)` or `arr.join(",")`. `log()` already does this, and the lint warns about `"x" + L.transform.position.value`.
2. **Never call `app.executeCommand`**. The lint refuses it. A failed run is rolled back for you (above).
3. **Wrap mutations**: suppress dialogs, one undo group, try/catch logging `message` + line. This is `AE.run`, and
   `ae run` adds it automatically.
4. **Logs**: `f.encoding="UTF-8"` **and `f.lineFeed="Unix"`**. The macOS default writes CR, which is why old logs looked
   run-together. `AE._write` does both and writes atomically (`.part`, then rename).
5. **Trim**: in/out may not stick, and `startTime` can be negative. Use `AE.trim` (retries, verifies, WARNs).
   Footage can't be trimmed past its source span unless time remap is on.
6. **Typewriter/cursor expressions on Source Text**: `prop.value` is the half-typed text (`'Grocery Shopp|'`).
   **In AE 26.5, `valueAtTime(t, true)` and `keyValue(k)` ALSO return post-expression text for Source Text**: the
   preExpression flag is ignored (verified). The only reliable raw read is to disable the expression, read, and re-enable
   it. `AE.textDoc`/`getText`/`setText` do exactly that. It is a net-zero but undoable change, so do it inside `AE.run`.
   `ae dump` stays read-only and shows `(expr, post@fN) '...'`, the post-expression text at the layer's last frame
   (a typewriter is complete there). Use `--raw-text` for the true source.
7. **`saveFrameToPng` is async**. The files appear after the script returns. The shell side waits until each PNG ends
   with the `IEND` chunk (timeout 60 s). `resolutionFactor` is taken at call time, so the lib sets it, queues the renders
   and restores the comp's *original* value right away.
8. **zsh globs**: `rm s*.png` with no match aborts `&&` chains. The CLI deletes by exact path. In your own shell commands, use `find ... -delete` or `rm -f` with explicit names.
9. **Keyframe ease**: new keys get default interpolation. `AE.key(..., {like:[ref,k]})` or `AE.copyEase` copy it.
   `setTemporalEaseAtKey` needs arrays whose length matches the property's ease dimension: 1 for spatial or 1-D
   properties, 2 or 3 for Scale-like ones. The lib reads the target key's own length and adapts.
10. **Footage**: match by `file.fsName` before importing (`AE.footage`). `replaceSource(item, false)` keeps transforms.
11. **`layer.copyToComp(comp)` into the same comp**: the new copy goes to index 1, and the JS reference you copied from
    then points at the copy. Use `AE.copyLayer`, which returns the copy whatever the index. A copy of a disabled layer is
    disabled too, and a duplicate name gets a ` 2` suffix.
12. **New shape layers sit at the comp centre**: `layers.addShape()` sets the layer position to the comp centre,
    so a rect whose own Position is in comp coordinates ends up offset. Set the layer position to `[0,0]` first.
13. **Time Remap**: removing every key and then calling `setValueAtTime` fails with "property ... is hidden".
    Keep AE's default keys, add yours, then remove only the default end key.
14. **Shape contents: `addProperty` invalidates sibling references**. After adding a second group to a shape layer's
    contents, a reference you kept to the first group throws "Object is invalid". Re-fetch groups by name
    (`root.property("Lid")`) after the last `addProperty`.
15. **`renderQueue.render()` and `queueInAME()` process the whole queue**, including items the user queued for later.
    `AE.render` switches those off for the duration, restores them, and removes its own item.

ExtendScript is ES3. `ae run`, `ae eval` and `ae check` parse every script first and refuse to send one AE would reject
(a syntax error in AE opens a blocking modal dialog). With the Claude Code plugin, every `.jsx` you write or edit is
checked right away by a hook; otherwise run `ae check file.jsx` yourself. The rules match AE 2026 (verified in AE):
- Errors: `let`, `=>`, template literals, `class`, spread/rest, destructuring, default parameters, `for...of`, `**`,
  `?.`, `??`, getters/setters, shorthand/computed/method properties, `async`/generators, regex flags other than `gim`,
  `const` in a `for (...)` header, future reserved words as names (`short`, `int`, `static`, `char`, `native`, ...),
  reserved words as unquoted object keys (`{in: 1}`: write `{"in": 1}`), `app.executeCommand`, and **unknown `AE.*`
  members** (`AE.setTxt` gets "did you mean AE.setText?").
- Warnings (they fail at runtime): `[].forEach/map/filter/...`, `[].indexOf`, `"".trim/startsWith/...`, `.bind`,
  `Object.keys` & co, `Array.isArray`, **`JSON`, which is undefined** (use `AE.str(v)`), and `"text" + <array value>` (pitfall 1). Also `const` (reassignment is
  silently ignored), `app.project.save/close`, and reserved words after a dot (`o.in` works in AE 2026, not in older versions).
- Fine: trailing commas, `o["in"]`, `let`/`yield` as plain names, `Date.now`.

AE's `Folder.temp` is `.../T/TemporaryItems/`, and a sandboxed shell may be unable to read it. Write files the shell
must read to `AE.tmp`, or to a path you pass in.
