---
name: after-effects-tutor
description: Teach the user After Effects hands-on in their own project - lessons as step-by-step tasks left as markers in the timeline ("try 1/3 ..."), the user does each step by hand, the agent checks the result through the `ae` CLI and hints before it takes over; also answers questions left as markers and gives guided tours of a template. Use when the user wants to learn or practise AE ("teach me", "show me how", "let me do it myself", "explain how this template works"), not when they only want the edit done.
---

# Teaching After Effects in the user's timeline

This builds on the `after-effects` skill: load it first for the CLI (`ae`), the `AE.*` API and the pitfalls. Here the
user does the work by hand, and markers are the worksheet in their timeline.

## Plan

- **3-5 steps per lesson**, each leaving a trace you can check in the project: a key, an ease, a changed value, an
  effect, a parent, a trim. "Understand X" is not a step; "make the box land softer" is.
- Use the user's comp when the lesson is about their work. Otherwise build a **practice comp** with the problem already
  in it: a box on linear keys to ease, a title to parent to a null, a layer to trim to the beat (`ae beats`).
- Ask what they already know if it is unclear, and pitch the steps at that level.

## Set up (one `ae run`, so one Cmd+Z step)

```js
// lesson.jsx
AE.run("Lesson: easing", function (log) {
    var c = AE.addComp("Practice", {w: 1920, h: 1080, dur: 90, fps: 30});
    var box = AE.addRect(c, {size: [200, 200], fill: "#7143EC", name: "Box"});
    AE.key(AE.tf(box, "pos"), [[0, [460, 540]], [45, [1460, 540]]], {interp: "linear"});
    AE.marker(box, 0, "try 1/3: select both Position keys (P), make them ease", {label: 9});
    AE.marker(box, 45, "try 2/3: make it land softer (Graph Editor)", {label: 9});
    AE.marker(c, 55, "try 3/3: start the move 10 frames later", {label: 9});
    AE.show(c, 0);
    AE.select(box);
});
```

- One marker per step, at the frame where it happens, on the layer it is about (layer markers move with the layer;
  comp markers for steps about the whole comp). All lesson markers share one label.
- Comments start with `try N/M:`. Keep that prefix ASCII so the cleanup can find it; the rest may be in the user's
  language. Keep them short, since the timeline truncates them: the goal plus the shortcut or panel. Explanations go
  in the chat.
- `AE.show` opens the comp at the first step, `AE.select` selects its layer.

## Each step

1. **Save the state before it**:
   `ae dump "Practice" --layer "Box" --at 0 > "$TMPDIR/ae-tools/lesson/before.txt"`. `--at` keeps the dump stable while
   the user moves the playhead. Drop `--layer` when the step adds layers (a null, a precomp).
2. **Tell the user the step** in the chat, in a sentence or two: what to do and why it matters.
3. **Leave the project alone while they work.** Any change you make becomes the top undo step, so their Cmd+Z would
   undo yours first.
4. **When they say done**, dump again and `diff`. `ae sel` shows what they selected, `ae graph` the ease they made
   (peak/avg 1.00 = still linear), `ae snap --crop` the look. Say what worked and what is off, in terms of what they
   see in AE, not of the dump.
5. **When it is not right, hints escalate**: the goal again, then where to look (panel, property, shortcut), then the
   exact clicks. Name shortcuts as well as menu paths, since the UI may be localised. Only then offer to do it
   yourself with `ae run fix.jsx --ab "Practice" --frames 0,20,45`: they see before and after, and Cmd+Z lets them try
   again.
6. Once they confirm, mark the step done in one run (`AE.removeMarkers(box, "try 1/3")`, then
   `AE.marker(box, 0, "done 1/3: ...", {label: 9})`) and go to the next one with `AE.show`.

## Questions and tours

- A marker whose comment starts with `?` is the user's question at that frame (`ae markers`). Look at that frame
  (`ae dump --at`, `ae snap`) and answer in the chat.
- To explain a project (a template, someone else's rig), leave `note N/M:` markers on its interesting parts (an
  expression, a control layer, a precomp, a matte) and walk through them one at a time with `AE.show`.

## Clean up

At the end, ask whether to keep the markers (some users keep the notes). A practice comp goes as a whole
(`ae eval 'AE.remove("Practice")'`). In the user's own comp, remove only the lesson markers:

```sh
ae eval 'var c = AE.comp("Main"), re = /^(try|done|note) \d/, n = AE.removeMarkers(c, re); for (var i = 1; i <= c.numLayers; i++) n += AE.removeMarkers(c.layer(i), re); n'
```

Never save the project: the user decides that.
