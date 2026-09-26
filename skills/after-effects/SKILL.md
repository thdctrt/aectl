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
- Requirements: AE running, node, ffmpeg/ffprobe (for sheets and video tools).

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
  for that file), `DONE/FAILED <name> (ms)` (end of each `AE.run`).
- Standalone, without the CLI: `#include` the lib and call `AE.run(name, "/abs/log.txt", fn)`. Without a logPath
  it writes to `AE.tmp/ae_run.log`.

## CLI

```
ae run script.jsx [--log file] [--ro|--undo] [--timeout s]   # check, run, wait for log (+PNGs), print, exit 1 on ERR
ae check script.jsx                                          # syntax + ExtendScript lint only
ae eval 'AE.comp("Logo").numLayers' [--ro]                   # expression -> value is logged
ae eval 'var c=AE.comp("Logo"); log(c.duration);' --ro       # statements -> use log()
ae dump "Main" [--depth 1] [--layer "Title"] [--no-keys] [--max-keys N] [--raw-text]
ae tree [--main "Main"]                                      # all comps (folder, size, fps, dur) + layers of --main (default: active comp)
ae snap "Main" 8,44,90 [--out dir] [--prefix p] [--res full|half|third|quarter] [--sheet] [--cols 4] [--width 640]
ae snap "Intro" 0-84:14 --sheet                     # ranges: a-b or a-b:step
ae sheet out.png a.png b.png ... [--cols 4] [--width 640]    # contact sheet from any images (labels = file names)
ae frames video.mp4 [--n 12] [--cols 4] [--width 480] [--from s] [--to s] [--out sheet.png]  # pick clip times
ae probe video.mp4 [--fps 25]                                # size, fps (avg + r; flags VFR), duration, frames, audio;
                                                             # --fps: length in comp frames at that rate
ae save [--status] [--backup] [--as file.aep]                # save the open project (see below)
ae doctor                                                    # check node/ffmpeg/AE prefs/permissions, test the connection
ae selftest [--keep]                                         # 40 checks in a throwaway comp, then cleanup (see below)
```

- `snap` defaults: `--res half`, output in `$TMPDIR/ae-tools/snap/<comp>/`, files named `<prefix>_f0044.png`. It prints one
  path per line, then `SHEET <path>` with `--sheet`. The comp's own resolution factor is restored afterwards.
- `dump`/`tree`/`snap` are read-only (no undo group). `dump --raw-text` runs in one undo group "ae dump", see pitfall 6.
- Env: `AE_TIMEOUT` (log wait, default 300 s), `AE_SNAP_TIMEOUT` (PNG wait, default 60 s), `AE_TMP` (work dir,
  default `$TMPDIR`), `AE_DEBUG=1` (PNG wait timing), `AE_APP` (app name; default: the running AE, else the newest one in /Applications).
- Exit codes: 0 ok, 1 ERR logged, 2 usage/syntax/lint, 3 AE not running / timeout (a modal dialog in AE is the usual cause).
- `save`: prints the project path and whether it has unsaved changes, then saves with AE's own Save (not undoable).
  Does nothing when there are no unsaved changes. `--status` only reports. `--backup` first copies the current .aep on
  disk to `<project dir>/Backups/<name>-YYYYmmdd-HHMMSS.aep`. `--as` saves to a new path, and AE keeps working on that
  new file afterwards, like Save As. Only save when the user asks you to: they may prefer to save themselves.
- The combined file that actually ran is at `$TMPDIR/ae-tools/run/<name>.combined.jsx`.

## API (`lib.jsx`)

Frames are always comp frames (`frame * comp.frameDuration`). Layer/comp arguments accept objects; `comp` also takes a
name or numeric id.

**Lookup**
- `AE.comp(nameOrId)`: throws if the comp is missing or the name is ambiguous. `AE.comps(name?)` returns all comps with that name.
- `AE.layer(comp, nameOrIndex)`: throws if missing or ambiguous. `AE.layers(comp, name|RegExp|fn)` returns the list.
- `AE.findProp(group, matchNameOrName)` searches recursively. `AE.findProps(...)` returns all matches.
- `AE.tf(layer, "pos"|"anchor"|"scale"|"rot"|"opacity"|"x"|"y"|matchName)` returns a transform property.
- `AE.footage(path, folder?)` finds a FootageItem by `file.fsName`, or imports it (into `AE.folder(folder)`).
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

  Returns the key index.
- `AE.copyEase(prop, k|"all", srcProp, srcK)` copies in/out interpolation, temporal ease, and continuous/auto-bezier.
  The ease-array length adapts to the target dimension (e.g. a spatial Position with 1 entry from a Scale with 3).
- `AE.keys(prop)` returns `[{frame, time, index, value, "in", "out", inEase, outEase}]`. Read the interpolation types as
  **`k["in"]` / `k["out"]`**, because `k.in` is a syntax error in ExtendScript.
- `AE.set(prop, value)` is a `setValue` that pads missing dimensions (z) and throws clearly if the property is keyed.

**Footage placement**
- `AE.replaceFootage(layer, pathOrItem, {folder, anchor, scale, pos, start, inF, outF, mute, name, cover})`:
  - `replaceSource(item, false)` keeps the transforms;
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
- `AE.run(name, [logPath], fn(log), [{undo:false}])` and `AE.peek(name, fn)` (no undo group). A nested `AE.run` gets
  its own try/catch but joins the outer undo group.
- `AE.log(...)`, `AE.warn(...)`, `AE.str(anything)`: `str` is a safe stringify for arrays, TextDocument, KeyframeEase,
  Shape, layers and items.
- `AE.dump(comp, {depth, keys, maxKeys, filter, rawText})` returns the text tree:
  - per layer: index, name, kind, source (and file), in/out/start in frames, stretch, parent, matte, disabled/solo/3D/audio flags;
  - transform values (post-expression at the comp's current time; `*` = keyed, `~` = expression);
  - text (font, size, tracking, fill) and the effect list;
  - every keyed or expression property as `frame:value` with interpolation `LL/BB(inInfl,outInfl)/HH` and the expression text;
  - `depth` recurses into precomps.
- `AE.tree(mainName?)` is the project overview used by `ae tree`.
- `AE.snap(comp, frames[], outDir?, prefix?, res?)` queues PNGs, logs `PNG <path>` and returns the paths.
  `res` is `"full"|"half"|"third"|"quarter"`, 1–4, `[x,y]`, or null (keep).
- `AE.scriptPath` / `AE.scriptDir` hold the original script location under `ae run`. `AE.tmp` is the shell-readable work dir.

## Pitfalls (all handled by the lib/CLI; keep them in mind for raw code)

1. **`"x" + array` throws** ("invalid numeric result") because this engine overloads `+` for arrays. Use `AE.str(v)`,
   `String(arr)` or `arr.join(",")`. `log()` already does this.
2. **Never call `app.executeCommand`**. The lint refuses it.
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
8. **zsh globs**: `rm s*.png` with no match aborts `&&` chains. The CLI is bash with `nullglob` and deletes by exact
   path. In your own shell commands, use `find ... -delete` or `rm -f` with explicit names.
9. **Keyframe ease**: new keys get default interpolation. `AE.key(..., {like:[ref,k]})` or `AE.copyEase` copy it.
   `setTemporalEaseAtKey` needs arrays whose length matches the property's ease dimension: 1 for spatial or 1-D
   properties, 2 or 3 for Scale-like ones. The lib reads the target key's own length and adapts.
10. **Footage**: match by `file.fsName` before importing (`AE.footage`). `replaceSource(item, false)` keeps transforms.
11. **`layer.copyToComp(comp)` into the same comp**: the new copy goes to index 1, and the JS reference you copied from
    then points at the copy. Re-fetch both by index right after (`copy = comp.layer(1); orig = comp.layer(2)`). A copy of a
    disabled layer is disabled too, and a duplicate name gets a ` 2` suffix.
12. **New shape layers sit at the comp centre**: `layers.addShape()` sets the layer position to the comp centre,
    so a rect whose own Position is in comp coordinates ends up offset. Set the layer position to `[0,0]` first.
13. **Time Remap**: removing every key and then calling `setValueAtTime` fails with "property ... is hidden".
    Keep AE's default keys, add yours, then remove only the default end key.
14. **Shape contents: `addProperty` invalidates sibling references**. After adding a second group to a shape layer's
    contents, a reference you kept to the first group throws "Object is invalid". Re-fetch groups by name
    (`root.property("Lid")`) after the last `addProperty`.

ExtendScript is ES3, and the CLI lint enforces it:
- Hard errors: `let`/`const`, `=>`, template literals, `class`, spread, `for...of`, `**`, `?.`/`??`, and reserved
  words used as properties or bare keys (`o.in`, `{in:1}`). These would raise a blocking modal dialog in AE.
- Warnings: `[].forEach/map/filter/indexOf`, `"".trim`, `Object.keys` and `Array.isArray` don't exist.
  (`JSON` exists in this environment.)
- Also flagged: `app.project.save/close`.
- The lint strips strings, comments and regex literals first, but it can still give a false positive.

AE's `Folder.temp` is `.../T/TemporaryItems/`, and a sandboxed shell may be unable to read it. Write files the shell
must read to `AE.tmp`, or to a path you pass in.

## Self-test

```
ae selftest            # or: ae selftest --keep   to leave the test items in the project for inspection
```

It generates a 6 s test clip with ffmpeg (`$TMPDIR/ae-tools/__aetools_clip.mp4`, reused later), then runs `tests/selftest.jsx`, which creates
`__aetools_test`, `__aetools_test_src`, the folder `__aetools_test_folder` and imports the clip. It checks
trim/shift/setText (real typewriter expression, plus keyed Source Text)/key/copyEase/replaceFootage/cover/dump, and snaps
3 frames. It prints `ALL PASS` (40 checks). Then `tests/cleanup.jsx` removes exactly those items; it is idempotent and never
saves. It never touches existing comps or layers. It does leave two entries in the undo history and makes the project dirty.
